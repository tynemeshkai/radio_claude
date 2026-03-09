#!/usr/bin/env python3
"""
LOCAL FARTS — FFT WebSocket Server v4.0
========================================
60fps exact AnalyserNode replica.

Previous versions used 30fps + compensated smoothing + client interpolation.
This created double-smoothing that made the visualizer look sluggish.

v4: run at native 60fps with exact AnalyserNode parameters.
Client does direct assignment — zero additional processing.
Result: 1:1 visual match with Web Audio API AnalyserNode.

CPU cost: FFT(1024) × 60/sec ≈ 3ms/sec. Negligible.
Bandwidth: 11 bytes × 60fps = 660 bytes/sec per client. Negligible.
"""

import asyncio
import math
import time
import numpy as np
from aiohttp import web
from contextlib import suppress

ICECAST_URL = "http://127.0.0.1:8000/stream_lossless.ogg"
HOST = "127.0.0.1"
PORT = 7891

SAMPLE_RATE = 44100
FFT_SIZE = 1024
READ_CHUNK = 512
BARS_COUNT = 11

# 60fps — matches AnalyserNode call rate in requestAnimationFrame
TARGET_FPS = 60
FRAME_INTERVAL = 1.0 / TARGET_FPS

# Exact AnalyserNode parameters — no compensation needed at 60fps
SMOOTH = 0.85        # analyser.smoothingTimeConstant
DB_MIN = -85.0       # analyser.minDecibels
DB_MAX = -10.0       # analyser.maxDecibels
DB_RANGE = DB_MAX - DB_MIN

# Logarithmic bin mapping — exact copy from old JS visualizer
MIN_BIN = 1
MAX_BIN = 370

_log_bin_ranges = []
for i in range(BARS_COUNT):
    sx = i / BARS_COUNT
    ex = (i + 1) / BARS_COUNT
    lo = int(math.floor(MIN_BIN * math.pow(MAX_BIN / MIN_BIN, sx)))
    hi = max(lo, int(math.floor(MIN_BIN * math.pow(MAX_BIN / MIN_BIN, ex))))
    _log_bin_ranges.append((lo, hi))

# Treble boost + power curve — exact copy from old JS
_treble_boost = np.array(
    [1.0 + (i / BARS_COUNT) * 1.4 for i in range(BARS_COUNT)],
    dtype=np.float32
)
POWER_CURVE = 1.4

_window = np.blackman(FFT_SIZE).astype(np.float32)

# State
_sample_buf = np.zeros(FFT_SIZE, dtype=np.float32)
_smoothed = np.zeros(BARS_COUNT, dtype=np.float32)
_latest_frame = bytes(BARS_COUNT)
_clients: set[web.WebSocketResponse] = set()
_stats = {"audio_connected": False}


def _compute_frame():
    global _latest_frame

    windowed = _sample_buf * _window
    spectrum = np.abs(np.fft.rfft(windowed))
    # AnalyserNode spec: magnitude[k] = |FFT[k]| / fftSize
    spectrum *= (1.0 / FFT_SIZE)

    raw = np.zeros(BARS_COUNT, dtype=np.float32)
    for i, (lo, hi) in enumerate(_log_bin_ranges):
        band = spectrum[lo:hi + 1]
        if len(band) > 0:
            raw[i] = float(np.max(band))

    # Exact smoothingTimeConstant formula from Web Audio spec
    _smoothed[:] = _smoothed * SMOOTH + raw * (1.0 - SMOOTH)

    result = np.zeros(BARS_COUNT, dtype=np.float32)
    for i in range(BARS_COUNT):
        db = 20.0 * np.log10(max(_smoothed[i], 1e-10))
        normed = max(0.0, min(1.0, (db - DB_MIN) / DB_RANGE))
        boosted = normed * _treble_boost[i]
        result[i] = min(1.0, boosted) ** POWER_CURVE

    _latest_frame = np.clip(result * 255.0, 0, 255).astype(np.uint8).tobytes()


async def _audio_reader():
    global _sample_buf
    cmd = [
        "/usr/bin/ffmpeg", "-hide_banner", "-loglevel", "error",
        "-reconnect", "1", "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", ICECAST_URL,
        "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-",
    ]
    read_bytes = READ_CHUNK * 4
    while True:
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            _stats["audio_connected"] = True
            print("FFT: Connected to Icecast")
            while True:
                data = await proc.stdout.readexactly(read_bytes)
                chunk = np.frombuffer(data, dtype=np.float32)
                _sample_buf[:FFT_SIZE - READ_CHUNK] = _sample_buf[READ_CHUNK:]
                _sample_buf[FFT_SIZE - READ_CHUNK:] = chunk
        except asyncio.IncompleteReadError:
            print("FFT: Icecast stream ended")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"FFT: Audio reader error: {e}")
        finally:
            _stats["audio_connected"] = False
            if proc:
                with suppress(Exception):
                    proc.kill(); await proc.wait()
            _sample_buf[:] = 0.0
            _smoothed[:] = 0.0
            await asyncio.sleep(2)


async def _frame_ticker():
    next_tick = time.monotonic()
    while True:
        _compute_frame()
        if _clients:
            frame = _latest_frame
            dead = []
            for ws in _clients:
                try:
                    await ws.send_bytes(frame)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                _clients.discard(ws)
        next_tick += FRAME_INTERVAL
        sleep_time = next_tick - time.monotonic()
        if sleep_time < -0.1:
            next_tick = time.monotonic() + FRAME_INTERVAL
            sleep_time = FRAME_INTERVAL
        if sleep_time > 0:
            await asyncio.sleep(sleep_time)


async def _ws_handler(req):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(req)
    _clients.add(ws)
    print(f"FFT: +client ({len(_clients)})")
    try:
        async for _ in ws:
            pass
    finally:
        _clients.discard(ws)
        print(f"FFT: -client ({len(_clients)})")
    return ws


async def _health(req):
    return web.json_response({
        "status": "ok", "clients": len(_clients),
        "audio": _stats["audio_connected"], "fps": TARGET_FPS
    })


async def _lifecycle(app):
    r = asyncio.create_task(_audio_reader())
    t = asyncio.create_task(_frame_ticker())
    yield
    r.cancel(); t.cancel()
    with suppress(asyncio.CancelledError):
        await r; await t


app = web.Application()
app.router.add_get("/ws-fft", _ws_handler)
app.router.add_get("/health", _health)
app.cleanup_ctx.append(_lifecycle)

if __name__ == "__main__":
    print(f"FFT v4 | {HOST}:{PORT} | {TARGET_FPS}fps | smooth={SMOOTH}")
    web.run_app(app, host=HOST, port=PORT)