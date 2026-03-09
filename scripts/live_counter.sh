#!/bin/bash
# ==============================================================================
# LIVE COUNTER — подсчёт реальных слушателей LOCAL FARTS Radio
# Пишет в /dev/shm/live-stats.json каждые 10 секунд
# ==============================================================================

STATS_FILE="/dev/shm/live-stats.json"
HLS_LOG="/var/log/nginx/hls_access.log"
# FFmpeg HLS slicer always holds exactly 1 Icecast slot — subtract it from raw count
RELAY_COUNT=1

while true; do
    M0=$(date "+%d/%b/%Y:%H:%M")
    M1=$(date -d "-1 min" "+%d/%b/%Y:%H:%M")

    # HLS: уникальные IP которые скачали .m4s сегмент за последнюю минуту
    # .m4s = реальное аудио, не просто проверка плейлиста
    HLS=$(tail -n 30000 "$HLS_LOG" 2>/dev/null \
        | awk -v d1="$M0" -v d2="$M1" \
            '($4 ~ d1 || $4 ~ d2) && /\.m4s/ && !/bot|curl|python|wget/ {seen[$1]=1} END {print length(seen)}')
    HLS=${HLS:-0}

    # Icecast: прямые подключения (минус 1 = FFmpeg HLS slicer relay)
    ICE_RAW=$(curl -m 2 -s http://127.0.0.1:8000/status-json.xsl \
        | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    src = d.get('icestats',{}).get('source',{})
    if isinstance(src, list):
        print(sum(s.get('listeners',0) for s in src))
    else:
        print(src.get('listeners',0))
except:
    print(0)
" 2>/dev/null)
    ICE_RAW=${ICE_RAW:-0}

    # Вычитаем HLS relay (FFmpeg slicer)
    ICE=$((ICE_RAW > RELAY_COUNT ? ICE_RAW - RELAY_COUNT : 0))

    TOTAL=$((HLS + ICE))

    echo "{\"hls\": $HLS, \"icecast\": $ICE, \"total\": $TOTAL}" > "$STATS_FILE"

    sleep 10
done