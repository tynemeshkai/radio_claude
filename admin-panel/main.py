#!/usr/bin/env python3
"""
LOCAL FARTS Radio — Admin API Backend
FastAPI сервер для управления радио.

Запуск: uvicorn main:app --host 127.0.0.1 --port 8888
"""

import asyncio
import json
import os
import subprocess
import secrets
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ==============================================================================
# CONFIG — пути под реальную структуру сервера
# ==============================================================================
NOWPLAYING_FILE = "/srv/radio/radio_data/nowplaying.json"
HISTORY_FILE = "/srv/radio/radio_data/history.json"
DJ_FILE = "/srv/radio/djs.json"
MUSIC_DIR = "/srv/radio/music"
DJ_LOG_FILE = "/var/log/localfarts/dj.log"
SESSION_FILE = "/tmp/dj_current_session.json"
STATIC_DIR = "/srv/radio/admin"

TELNET_HOST = "127.0.0.1"
TELNET_PORT = 1234
ICECAST_HOST = "127.0.0.1"
ICECAST_PORT = 8000

# API ключ для авторизации
ADMIN_TOKEN = os.environ.get("RADIO_ADMIN_TOKEN", "")
if not ADMIN_TOKEN:
    TOKEN_FILE = "/srv/radio/.admin_token"
    if os.path.exists(TOKEN_FILE):
        ADMIN_TOKEN = open(TOKEN_FILE).read().strip()
    else:
        ADMIN_TOKEN = secrets.token_urlsafe(32)
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, "w") as f:
            f.write(ADMIN_TOKEN)
        os.chmod(TOKEN_FILE, 0o600)
        print(f"\n🔑 Admin token сгенерирован: {ADMIN_TOKEN}")
        print(f"   Сохранён в {TOKEN_FILE}\n")

SERVICES = ["localfarts", "icecast2", "localfarts-hls", "nginx"]

# ==============================================================================
# APP
# ==============================================================================
app = FastAPI(title="LOCAL FARTS Radio Admin", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==============================================================================
# AUTH
# ==============================================================================
async def verify_token(x_admin_token: str = Header(default="")):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    return True


# ==============================================================================
# HELPERS
# ==============================================================================
async def telnet_cmd(cmd: str, timeout: float = 3.0) -> str:
    """Отправить команду в Liquidsoap telnet"""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(TELNET_HOST, TELNET_PORT),
            timeout=timeout
        )
        writer.write((cmd + "\n").encode())
        await writer.drain()

        response = b""
        try:
            while True:
                chunk = await asyncio.wait_for(reader.read(4096), timeout=2.0)
                if not chunk:
                    break
                response += chunk
                if b"END" in chunk or b"Done" in chunk:
                    break
        except asyncio.TimeoutError:
            pass

        writer.write(b"quit\n")
        await writer.drain()
        writer.close()

        return response.decode("utf-8", errors="replace").strip()
    except Exception as e:
        return f"ERROR: {e}"


def get_service_status(service: str) -> str:
    """Проверить статус systemd сервиса"""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def load_djs() -> dict:
    try:
        with open(DJ_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_djs(djs: dict):
    with open(DJ_FILE, "w") as f:
        json.dump(djs, f, indent=2, ensure_ascii=False)
    os.chmod(DJ_FILE, 0o600)


def read_json_file(path: str) -> dict:
    """Безопасное чтение JSON файла"""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def get_now_playing() -> dict:
    """Получить текущий трек из nowplaying.json (пишется write_history.sh)"""
    data = read_json_file(NOWPLAYING_FILE)
    return {
        "artist": data.get("artist", "—"),
        "title": data.get("title", "—"),
        "track": data.get("track", "—"),
        "started_at": data.get("started_at_utc", ""),
    }


def get_listener_stats() -> dict:
    """Читаем реальную статистику из /dev/shm/live-stats.json (пишется live_counter.sh)"""
    try:
        with open("/dev/shm/live-stats.json", "r") as f:
            data = json.load(f)
        return {
            "hls": data.get("hls", 0),
            "icecast": data.get("icecast", 0),
            "total": data.get("total", 0),
        }
    except Exception:
        return {"hls": 0, "icecast": 0, "total": 0}


async def get_uptime() -> str:
    """Аптайм через Liquidsoap telnet"""
    result = await telnet_cmd("uptime")
    # Формат: "0d 14h 22m 05s\nEND"
    for line in result.split("\n"):
        line = line.strip()
        if line and line != "END":
            return line
    return "—"


def get_live_dj() -> Optional[dict]:
    """Текущий DJ в эфире"""
    try:
        if os.path.exists(SESSION_FILE):
            with open(SESSION_FILE) as f:
                data = json.load(f)
            # Проверяем что сессия активна (есть connect_time, нет disconnect)
            if data.get("connected", False):
                return data
    except Exception:
        pass
    return None


def scan_library() -> dict:
    """Сканирование музыкальной библиотеки"""
    genres = {}
    total = 0
    try:
        for root, dirs, files in os.walk(MUSIC_DIR):
            for f in files:
                if f.lower().endswith((".mp3", ".flac", ".ogg", ".wav", ".m4a")):
                    total += 1
                    rel = os.path.relpath(os.path.join(root, f), MUSIC_DIR)
                    parts = rel.split(os.sep)
                    genre = parts[0] if len(parts) > 1 else "Unsorted"
                    genres[genre] = genres.get(genre, 0) + 1
    except Exception:
        pass
    return {"total": total, "genres": sorted(genres.items(), key=lambda x: -x[1])}


def search_tracks(query: str, limit: int = 50) -> list:
    """Поиск треков по имени файла"""
    results = []
    query_lower = query.lower()
    try:
        for root, dirs, files in os.walk(MUSIC_DIR):
            for f in files:
                if f.lower().endswith((".mp3", ".flac", ".ogg")) and query_lower in f.lower():
                    full = os.path.join(root, f)
                    results.append({
                        "filename": f,
                        "path": full,
                        "rel_path": os.path.relpath(full, MUSIC_DIR),
                    })
                    if len(results) >= limit:
                        return results
    except Exception:
        pass
    return results


# ==============================================================================
# API ENDPOINTS
# ==============================================================================

# --- STATUS ---
@app.get("/api/status")
async def api_status(auth: bool = Depends(verify_token)):
    now_playing = get_now_playing()
    listeners = get_listener_stats()
    live_dj = get_live_dj()
    uptime = await get_uptime()

    services = {}
    for svc in SERVICES:
        services[svc] = get_service_status(svc)

    return {
        "now_playing": now_playing,
        "listeners": listeners,
        "live_dj": live_dj,
        "uptime": uptime,
        "services": services,
    }


# --- HISTORY ---
@app.get("/api/history")
async def api_history(limit: int = 50, auth: bool = Depends(verify_token)):
    data = read_json_file(HISTORY_FILE)
    items = data.get("items", [])
    # items уже отсортированы от новых к старым (index 1 = последний)
    result = []
    for item in items[:limit]:
        result.append({
            "artist": item.get("artist", ""),
            "title": item.get("title", ""),
            "track": item.get("track", ""),
            "played_at": item.get("started_at_utc", ""),
        })
    return result


# --- QUEUE ---
@app.get("/api/queue")
async def api_queue(auth: bool = Depends(verify_token)):
    result = await telnet_cmd("request_queue.queue")
    rids = []
    for line in result.split("\n"):
        line = line.strip()
        if line and line != "END":
            rids.extend(line.split())

    tracks = []
    for rid in rids[:20]:
        meta_raw = await telnet_cmd(f"request.metadata {rid}")
        meta = {}
        for mline in meta_raw.split("\n"):
            mline = mline.strip()
            if "=" in mline and mline != "END":
                key, _, value = mline.partition("=")
                meta[key.strip()] = value.strip().strip('"')
        tracks.append({
            "rid": rid,
            "artist": meta.get("artist", ""),
            "title": meta.get("title", ""),
        })
    return tracks


class QueueRequest(BaseModel):
    uri: str

@app.post("/api/queue")
async def api_queue_push(req: QueueRequest, auth: bool = Depends(verify_token)):
    if not os.path.exists(req.uri):
        raise HTTPException(400, "File not found")
    result = await telnet_cmd(f"request_queue.push {req.uri}")
    return {"status": "ok", "response": result}


# --- SKIP ---
@app.post("/api/skip")
async def api_skip(auth: bool = Depends(verify_token)):
    result = await telnet_cmd("icecast_out.skip")
    return {"status": "ok", "response": result}


# --- DJS ---
@app.get("/api/djs")
async def api_djs_list(auth: bool = Depends(verify_token)):
    djs = load_djs()
    result = []
    for user, info in djs.items():
        result.append({
            "user": user,
            "name": info.get("name", ""),
            "max_minutes": info.get("max_minutes", 0),
            "enabled": info.get("enabled", False),
        })
    return result


class DJCreate(BaseModel):
    user: str
    password: str
    name: str
    max_minutes: int = 60

@app.post("/api/djs")
async def api_djs_add(dj: DJCreate, auth: bool = Depends(verify_token)):
    if len(dj.password) < 8:
        raise HTTPException(400, "Password min 8 chars")
    if not all(c.isalnum() or c == '_' for c in dj.user):
        raise HTTPException(400, "Username: only a-z, 0-9, _")

    djs = load_djs()
    if dj.user in djs:
        raise HTTPException(400, "User already exists")

    try:
        import bcrypt
        pw_hash = bcrypt.hashpw(dj.password.encode(), bcrypt.gensalt()).decode()
    except ImportError:
        pw_hash = dj.password

    djs[dj.user] = {
        "password_hash": pw_hash,
        "name": dj.name,
        "max_minutes": dj.max_minutes,
        "enabled": True,
    }
    save_djs(djs)
    return {"status": "ok", "user": dj.user}


class DJUpdate(BaseModel):
    name: Optional[str] = None
    max_minutes: Optional[int] = None
    enabled: Optional[bool] = None
    password: Optional[str] = None

@app.put("/api/djs/{user}")
async def api_djs_update(user: str, update: DJUpdate, auth: bool = Depends(verify_token)):
    djs = load_djs()
    if user not in djs:
        raise HTTPException(404, "DJ not found")

    if update.name is not None:
        djs[user]["name"] = update.name
    if update.max_minutes is not None:
        djs[user]["max_minutes"] = update.max_minutes
    if update.enabled is not None:
        djs[user]["enabled"] = update.enabled
    if update.password is not None:
        if len(update.password) < 8:
            raise HTTPException(400, "Password min 8 chars")
        try:
            import bcrypt
            djs[user]["password_hash"] = bcrypt.hashpw(update.password.encode(), bcrypt.gensalt()).decode()
        except ImportError:
            djs[user]["password_hash"] = update.password

    save_djs(djs)
    return {"status": "ok"}


@app.delete("/api/djs/{user}")
async def api_djs_remove(user: str, auth: bool = Depends(verify_token)):
    djs = load_djs()
    if user not in djs:
        raise HTTPException(404, "DJ not found")
    del djs[user]
    save_djs(djs)
    return {"status": "ok"}


@app.post("/api/djs/kick")
async def api_djs_kick(auth: bool = Depends(verify_token)):
    result = await telnet_cmd("live_harbor.stop")
    return {"status": "ok", "response": result}


# --- LIBRARY ---
@app.get("/api/library")
async def api_library(auth: bool = Depends(verify_token)):
    return scan_library()


@app.get("/api/library/search")
async def api_library_search(q: str = "", limit: int = 50, auth: bool = Depends(verify_token)):
    if len(q) < 2:
        return []
    return search_tracks(q, limit)


# --- LOGS ---
@app.get("/api/logs")
async def api_logs(lines: int = 100, auth: bool = Depends(verify_token)):
    try:
        if os.path.exists(DJ_LOG_FILE):
            with open(DJ_LOG_FILE) as f:
                all_lines = f.readlines()
            return [l.strip() for l in all_lines[-lines:]]
    except Exception:
        pass
    return []


# --- SERVICES ---
@app.get("/api/services")
async def api_services(auth: bool = Depends(verify_token)):
    result = {}
    for svc in SERVICES:
        result[svc] = get_service_status(svc)
    return result


@app.post("/api/services/{name}/restart")
async def api_service_restart(name: str, auth: bool = Depends(verify_token)):
    if name not in SERVICES:
        raise HTTPException(400, "Unknown service")
    try:
        subprocess.run(["systemctl", "restart", name], timeout=30, check=True)
        return {"status": "ok", "service": name}
    except Exception as e:
        raise HTTPException(500, f"Failed: {e}")


# ==============================================================================
# STARTUP
# ==============================================================================
@app.on_event("startup")
async def startup():
    # Создаём директорию для DJ логов если нет
    os.makedirs(os.path.dirname(DJ_LOG_FILE), exist_ok=True)
    if not os.path.exists(DJ_LOG_FILE):
        Path(DJ_LOG_FILE).touch()

    print(f"🎵 LOCAL FARTS Radio Admin API")
    print(f"🔑 Token: {ADMIN_TOKEN[:8]}...")
    print(f"📡 Liquidsoap telnet: {TELNET_HOST}:{TELNET_PORT}")
    print(f"🎧 Icecast: {ICECAST_HOST}:{ICECAST_PORT}")
    print(f"📂 Now playing: {NOWPLAYING_FILE}")
    print(f"📂 History: {HISTORY_FILE}")
    print(f"📂 Music: {MUSIC_DIR}")
    print(f"🌐 API: http://127.0.0.1:8888/api/")