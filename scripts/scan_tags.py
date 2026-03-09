#!/usr/bin/env python3
"""
One-time ReplayGain tagger for the entire music library.

Strategy:
  1. loudgain calculates gain/peak values (WITHOUT -I flag)
  2. mutagen writes ReplayGain tags (reliable with all ID3 versions)
  
This bypasses loudgain's broken ID3 writer while using its accurate EBU R128 scanner.
"""

import os
import re
import subprocess
import time

MUSIC_DIR = "/srv/radio/music"
LOG_FILE = "/var/log/radio_loudgain_fix.log"

total = 0
fixed = 0
failed = 0
skipped = 0
errors = 0

def safe_str(s):
    if isinstance(s, bytes):
        return s.decode('utf-8', errors='replace')
    try:
        s.encode('utf-8')
        return s
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s.encode('utf-8', errors='surrogateescape').decode('utf-8', errors='replace')

def log(msg):
    line = safe_str(msg).rstrip('\n')
    print(line, flush=True)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8', errors='replace') as f:
            f.write(line + '\n')
    except Exception:
        pass

def has_replaygain(filepath):
    try:
        from mutagen.mp3 import MP3
        m = MP3(filepath)
        if not m.tags:
            return False
        for key in m.tags:
            if 'replaygain' in str(key).lower():
                return True
    except Exception:
        pass
    return False

def scan_loudgain(filepath):
    """
    Run loudgain WITHOUT -I (no tag writing).
    Parse stdout to extract track/album gain and peak values.
    Returns dict with values or None on failure.
    """
    try:
        result = subprocess.run(
            ['/usr/bin/loudgain', '-S', '-a', filepath],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60
        )

        if result.returncode != 0:
            return None

        output = result.stdout.decode('utf-8', errors='replace')

        # Parse loudgain output format:
        # Track: /path/to/file.mp3
        #  Loudness:   -11.17 LUFS
        #  Range:        9.89 dB
        #  Peak:     1.043211 (0.37 dBTP)
        #  Gain:        -6.83 dB
        # Album:
        #  Loudness:   -11.17 LUFS
        #  Range:        9.89 dB
        #  Peak:     1.043211 (0.37 dBTP)
        #  Gain:        -6.83 dB

        # Split into Track and Album sections
        sections = output.split('Album:')
        if len(sections) < 2:
            return None

        track_section = sections[0]
        album_section = sections[1]

        def parse_section(text):
            gain_match = re.search(r'Gain:\s+([-\d.]+)\s+dB', text)
            peak_match = re.search(r'Peak:\s+([-\d.]+)', text)
            if not gain_match or not peak_match:
                return None, None
            return gain_match.group(1), peak_match.group(1)

        track_gain, track_peak = parse_section(track_section)
        album_gain, album_peak = parse_section(album_section)

        if track_gain is None or album_gain is None:
            return None

        return {
            'track_gain': track_gain,
            'track_peak': track_peak,
            'album_gain': album_gain,
            'album_peak': album_peak,
        }

    except subprocess.TimeoutExpired:
        log("  ⚠️ loudgain timed out")
        return None
    except Exception as e:
        log(f"  ⚠️ loudgain error: {e}")
        return None

def write_replaygain_tags(filepath, values):
    """
    Write ReplayGain tags via mutagen (works with any ID3 version).
    Writes TXXX frames compatible with all players.
    """
    try:
        from mutagen.mp3 import MP3
        from mutagen.id3 import TXXX

        m = MP3(filepath)
        if m.tags is None:
            m.add_tags()

        # Remove old ReplayGain tags first
        to_remove = [k for k in m.tags if 'replaygain' in str(k).lower()]
        for k in to_remove:
            del m.tags[k]

        # Write standard ReplayGain TXXX frames
        m.tags.add(TXXX(
            encoding=3,  # UTF-8
            desc='replaygain_track_gain',
            text=[f"{values['track_gain']} dB"]
        ))
        m.tags.add(TXXX(
            encoding=3,
            desc='replaygain_track_peak',
            text=[values['track_peak']]
        ))
        m.tags.add(TXXX(
            encoding=3,
            desc='replaygain_album_gain',
            text=[f"{values['album_gain']} dB"]
        ))
        m.tags.add(TXXX(
            encoding=3,
            desc='replaygain_album_peak',
            text=[values['album_peak']]
        ))

        m.save()
        return True

    except Exception as e:
        log(f"  ⚠️ Tag write failed: {e}")
        return False

def collect_files(music_dir):
    all_files = []
    try:
        for root, dirs, files in os.walk(music_dir):
            for f in files:
                if f.lower().endswith('.mp3'):
                    all_files.append(os.path.join(root, f))
    except Exception as e:
        log(f"⚠️ String walk failed: {e}, trying bytes fallback...")
        all_files = []
        for root, dirs, files in os.walk(music_dir.encode('utf-8', errors='surrogateescape')):
            for f in files:
                if f.lower().endswith(b'.mp3'):
                    path = os.path.join(root, f)
                    try:
                        all_files.append(path.decode('utf-8'))
                    except UnicodeDecodeError:
                        all_files.append(path.decode('utf-8', errors='surrogateescape'))
    return all_files

def main():
    global total, fixed, failed, skipped, errors

    log(f"{time.strftime('%c')} — Starting full ReplayGain scan...")
    log(f"Music directory: {MUSIC_DIR}")
    log(f"Strategy: loudgain (scan) + mutagen (write tags)")

    all_files = collect_files(MUSIC_DIR)
    file_count = len(all_files)
    log(f"Found {file_count} MP3 files")

    if file_count == 0:
        log("No files found!")
        return

    for filepath in all_files:
        total += 1
        basename = safe_str(os.path.basename(filepath))

        try:
            if not os.path.isfile(filepath):
                log(f"[{total}/{file_count}] ⚠️ Not found: {basename}")
                errors += 1
                continue

            if has_replaygain(filepath):
                skipped += 1
                if skipped % 100 == 0:
                    log(f"  ... skipped {skipped} files with existing tags")
                continue

            log(f"[{total}/{file_count}] {basename}")

            # Step 1: Scan with loudgain (no tag writing)
            values = scan_loudgain(filepath)

            if values is None:
                log(f"  ❌ loudgain scan failed: {safe_str(filepath)}")
                failed += 1
                continue

            # Step 2: Write tags with mutagen
            if write_replaygain_tags(filepath, values):
                fixed += 1
            else:
                failed += 1
                log(f"  ❌ Tag write failed: {safe_str(filepath)}")

        except Exception as e:
            errors += 1
            log(f"  ☠️ UNEXPECTED ERROR on {basename}: {e}")
            continue

    log("")
    log(f"{time.strftime('%c')} — Done!")
    log(f"{'='*40}")
    log(f"Total files: {total}")
    log(f"Skipped:     {skipped} (already had ReplayGain)")
    log(f"Fixed:       {fixed}")
    log(f"Failed:      {failed}")
    log(f"Errors:      {errors}")
    log(f"{'='*40}")

    if failed > 0:
        log(f"\n⚠️ {failed} files could not be processed.")

if __name__ == '__main__':
    main()