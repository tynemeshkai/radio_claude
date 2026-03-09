#!/usr/bin/env python3
"""
Smart track picker for Liquidsoap.

Goals:
1) Never crash on malformed history/playlist.
2) Always return a valid playable file path when possible.
3) Keep repeat distance by preferring least-recently-played tracks.
4) Be safe under concurrent calls (file lock + atomic history write).
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
from typing import Dict, Iterable, List, Tuple

try:
    import fcntl  # Linux/Unix only (server target)
except Exception:  # pragma: no cover
    fcntl = None


PLAYLIST_FILE = os.environ.get("SMART_PLAYLIST_FILE", "/srv/radio/music.m3u")
HISTORY_FILE = os.environ.get("SMART_HISTORY_FILE", "/srv/radio/smart_history.json")
LOCK_FILE = os.environ.get("SMART_LOCK_FILE", "/tmp/smart-picker.lock")
LOG_FILE = os.environ.get("SMART_LOG_FILE", "/tmp/smart-picker.log")

OLDEST_POOL_SIZE = max(1, int(os.environ.get("SMART_OLDEST_POOL_SIZE", "64")))
MAX_HISTORY_ITEMS = max(100, int(os.environ.get("SMART_MAX_HISTORY_ITEMS", "80000")))

# Keep extensions broad to support mixed libraries.
PLAYABLE_EXTS = {".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wav", ".opus"}


def _log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} {msg}"
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8", errors="replace") as fh:
            fh.write(line + "\n")
    except Exception:
        # Logging must never break picker flow.
        pass


def _normalize_entry(raw: str, playlist_dir: str) -> str:
    s = raw.strip().replace("\ufeff", "")
    if not s or s.startswith("#"):
        return ""
    # Convert relative paths in m3u to absolute.
    if not os.path.isabs(s):
        s = os.path.join(playlist_dir, s)
    s = os.path.normpath(s)
    return s


def _is_playable_file(path: str) -> bool:
    ext = os.path.splitext(path)[1].lower()
    if ext not in PLAYABLE_EXTS:
        return False
    return os.path.isfile(path)


def load_playlist(path: str) -> List[str]:
    if not os.path.isfile(path):
        _log(f"WARN playlist missing: {path}")
        return []

    playlist_dir = os.path.dirname(path) or "/"
    unique: Dict[str, None] = {}

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                entry = _normalize_entry(line, playlist_dir)
                if not entry:
                    continue
                if _is_playable_file(entry):
                    unique[entry] = None
    except Exception as exc:
        _log(f"ERROR playlist read failed: {exc}")
        return []

    tracks = list(unique.keys())
    if not tracks:
        _log(f"WARN playlist has no playable entries: {path}")
    return tracks


def load_history(path: str) -> Dict[str, float]:
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            raw = json.load(fh)
    except Exception as exc:
        _log(f"WARN history read failed, reset history: {exc}")
        return {}

    if not isinstance(raw, dict):
        _log("WARN history format invalid (not dict), reset history")
        return {}

    clean: Dict[str, float] = {}
    for k, v in raw.items():
        if not isinstance(k, str):
            continue
        try:
            ts = float(v)
        except Exception:
            ts = 0.0
        if not (ts > 0):
            ts = 0.0
        clean[k] = ts
    return clean


def trim_history(history: Dict[str, float], existing_tracks: Iterable[str]) -> Dict[str, float]:
    track_set = set(existing_tracks)
    clean = {k: float(v) for k, v in history.items() if k in track_set}
    if len(clean) <= MAX_HISTORY_ITEMS:
        return clean
    # Keep only most recent N entries to cap file size.
    return dict(sorted(clean.items(), key=lambda kv: kv[1], reverse=True)[:MAX_HISTORY_ITEMS])


def save_history(path: str, history: Dict[str, float]) -> None:
    tmp = f"{path}.tmp"
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    payload = json.dumps(history, ensure_ascii=False, separators=(",", ":"))
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def pick_track(tracks: List[str], history: Dict[str, float]) -> Tuple[str, Dict[str, float]]:
    now = time.time()
    history = trim_history(history, tracks)
    track_set = set(tracks)

    never_played = list(track_set - set(history.keys()))
    if never_played:
        choice = random.choice(never_played)
    else:
        # Least recently played first, but with small randomization window.
        oldest_sorted = sorted(history.items(), key=lambda item: item[1])
        pool = [k for k, _ in oldest_sorted[:OLDEST_POOL_SIZE]]
        # Safety: if history somehow empty but tracks exist.
        if not pool:
            pool = tracks
        choice = random.choice(pool)

    history[choice] = now
    return choice, history


class FileLock:
    def __init__(self, path: str):
        self.path = path
        self.fh = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.fh = open(self.path, "a+", encoding="utf-8")
        if fcntl is not None:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self.fh and fcntl is not None:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
        finally:
            if self.fh:
                self.fh.close()


def main() -> int:
    try:
        with FileLock(LOCK_FILE):
            tracks = load_playlist(PLAYLIST_FILE)
            if not tracks:
                # No playable entries -> explicit non-zero so caller can fallback.
                _log("ERROR no tracks available in playlist")
                return 1

            history = load_history(HISTORY_FILE)
            choice, updated_history = pick_track(tracks, history)

            try:
                save_history(HISTORY_FILE, updated_history)
            except Exception as exc:
                # History write error should not break playback selection.
                _log(f"WARN history save failed: {exc}")

            # Contract with Liquidsoap: stdout = selected file path
            print(choice)
            return 0
    except Exception as exc:
        _log(f"ERROR fatal picker exception: {exc}")
        # Final fallback: attempt random playable track from playlist.
        tracks = load_playlist(PLAYLIST_FILE)
        if tracks:
            print(random.choice(tracks))
            return 0
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
