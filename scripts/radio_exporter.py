#!/usr/bin/env python3
"""LOCAL FARTS Radio — Prometheus Exporter"""

import json
import os
import subprocess
import time
from http.server import HTTPServer
from prometheus_client import (
    Gauge, Info, Counter,
    generate_latest, CONTENT_TYPE_LATEST,
    CollectorRegistry, REGISTRY
)
from prometheus_client.exposition import MetricsHandler
import urllib.request

# ─── Конфигурация ───
ICECAST_STATUS_URL = "http://127.0.0.1:8000/status-json.xsl"
SSE_SERVER_URL = "http://127.0.0.1:7890/events"
LIVE_STATS_FILE = "/dev/shm/live-stats.json"
NOWPLAYING_FILE = "/srv/radio/radio_data/nowplaying.json"
HLS_DIR = "/dev/shm/hls/high"
HISTORY_FILE = "/srv/radio/radio_data/history.json"
EXPORTER_PORT = 9100

# ─── Метрики ───
# Слушатели
listeners_hls = Gauge(
    'radio_listeners_hls',
    'Number of HLS listeners'
)
listeners_icecast = Gauge(
    'radio_listeners_icecast',
    'Number of direct Icecast listeners'
)
listeners_total = Gauge(
    'radio_listeners_total',
    'Total listeners (HLS + Icecast)'
)

# HLS здоровье
hls_segment_age = Gauge(
    'radio_hls_segment_age_seconds',
    'Age of the newest HLS .ts segment in seconds'
)
hls_segment_count = Gauge(
    'radio_hls_segment_count',
    'Number of .ts segments currently on disk'
)

# Icecast
icecast_up = Gauge(
    'radio_icecast_up',
    'Whether Icecast is responding (1=up, 0=down)'
)
icecast_source_up = Gauge(
    'radio_icecast_source_up',
    'Whether the lossless source mount exists (1=up, 0=down)'
)

# Systemd сервисы
service_up = Gauge(
    'radio_service_up',
    'Whether a systemd service is active (1=up, 0=down)',
    ['service']
)

# Текущий трек
track_info = Info(
    'radio_current_track',
    'Currently playing track metadata'
)
track_started_at = Gauge(
    'radio_track_started_at_unix',
    'Unix timestamp when current track started'
)
track_sequence = Gauge(
    'radio_track_sequence',
    'Monotonic sequence number of current track'
)

# История
history_tracks_total = Gauge(
    'radio_history_tracks_total',
    'Number of tracks in history'
)

# Exporter health
scrape_errors = Counter(
    'radio_exporter_errors_total',
    'Total number of scrape errors',
    ['source']
)


# ─── Сборщики данных ───

def collect_live_stats():
    """Читает live-stats.json от live_counter.sh"""
    try:
        if not os.path.exists(LIVE_STATS_FILE):
            return
        with open(LIVE_STATS_FILE, 'r') as f:
            data = json.load(f)
        listeners_hls.set(data.get('hls', 0))
        listeners_icecast.set(data.get('icecast', 0))
        listeners_total.set(data.get('total', 0))
    except Exception:
        scrape_errors.labels(source='live_stats').inc()


def collect_icecast():
    """Проверяет Icecast status API"""
    try:
        req = urllib.request.Request(ICECAST_STATUS_URL)
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read())

        icecast_up.set(1)

        # Проверяем наличие source mount
        sources = data.get('icestats', {}).get('source')
        if sources is None:
            icecast_source_up.set(0)
            return

        if not isinstance(sources, list):
            sources = [sources]

        has_lossless = any(
            'stream_lossless' in (s.get('listenurl', '') or '')
            for s in sources
        )
        icecast_source_up.set(1 if has_lossless else 0)

    except Exception:
        icecast_up.set(0)
        icecast_source_up.set(0)
        scrape_errors.labels(source='icecast').inc()


def collect_hls():
    """Проверяет свежесть HLS-сегментов"""
    try:
        if not os.path.isdir(HLS_DIR):
            hls_segment_age.set(9999)
            hls_segment_count.set(0)
            return

        ts_files = [
            os.path.join(HLS_DIR, f)
            for f in os.listdir(HLS_DIR)
            if f.endswith('.ts')
        ]
        hls_segment_count.set(len(ts_files))

        if not ts_files:
            hls_segment_age.set(9999)
            return

        newest_mtime = max(os.path.getmtime(f) for f in ts_files)
        age = time.time() - newest_mtime
        hls_segment_age.set(round(age, 1))

    except Exception:
        scrape_errors.labels(source='hls').inc()


def collect_services():
    """Проверяет статус systemd-сервисов"""
    services = [
        'localfarts',
        'localfarts-hls',
        'icecast2',
        'sse_server',
        'nginx'
    ]
    for svc in services:
        try:
            result = subprocess.run(
                ['systemctl', 'is-active', svc],
                capture_output=True, text=True, timeout=5
            )
            is_active = result.stdout.strip() == 'active'
            service_up.labels(service=svc).set(1 if is_active else 0)
        except Exception:
            service_up.labels(service=svc).set(0)
            scrape_errors.labels(source=f'service_{svc}').inc()


def collect_nowplaying():
    """Читает текущий трек из nowplaying.json"""
    try:
        if not os.path.exists(NOWPLAYING_FILE):
            return
        with open(NOWPLAYING_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)

        track_info.info({
            'artist': data.get('artist', ''),
            'title': data.get('title', ''),
            'track': data.get('track', '')
        })

        started = data.get('started_at_unix_ms', 0)
        if started:
            track_started_at.set(started / 1000.0)

        seq = data.get('sequence', 0)
        if seq:
            track_sequence.set(seq)

    except Exception:
        scrape_errors.labels(source='nowplaying').inc()


def collect_history():
    """Считает количество треков в истории"""
    try:
        if not os.path.exists(HISTORY_FILE):
            return
        with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        items = data.get('items', [])
        history_tracks_total.set(len(items))
    except Exception:
        scrape_errors.labels(source='history').inc()


# ─── Custom handler: собираем метрики при каждом scrape ───

class RadioMetricsHandler(MetricsHandler):
    def do_GET(self):
        # Собираем все метрики прямо перед отдачей
        collect_live_stats()
        collect_icecast()
        collect_hls()
        collect_services()
        collect_nowplaying()
        collect_history()
        # Отдаём стандартный Prometheus-ответ
        super().do_GET()


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', EXPORTER_PORT), RadioMetricsHandler)
    print(f"Radio exporter listening on :{EXPORTER_PORT}")
    server.serve_forever()