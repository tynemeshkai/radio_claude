#!/usr/bin/env bash

LOG="/var/log/radio_watchdog.log"
LOCK="/run/radio_watchdog.lock"
STATE_FILE="/run/radio_watchdog.failcount"
FAIL_THRESHOLD=5
STREAM_MOUNT="/stream_lossless.ogg"
ADMIN_STATS_URL="http://127.0.0.1:8000/admin/stats"

mkdir -p /run

exec 9>"$LOCK"
if ! flock -n 9; then
    exit 0
fi

fail_count=0
if [[ -f "$STATE_FILE" ]]; then
    raw_count="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
    if [[ "$raw_count" =~ ^[0-9]+$ ]]; then
        fail_count="$raw_count"
    fi
fi

icecast_ok=false
liquidsoap_ok=false
stream_ok=false

if systemctl is-active --quiet icecast2; then
    icecast_ok=true
fi

if systemctl is-active --quiet localfarts; then
    liquidsoap_ok=true
fi

admin_user="$(grep -oPm1 '(?<=<admin-user>).*?(?=</admin-user>)' /etc/icecast2/icecast.xml 2>/dev/null || true)"
admin_pass="$(grep -oPm1 '(?<=<admin-password>).*?(?=</admin-password>)' /etc/icecast2/icecast.xml 2>/dev/null || true)"

if [[ -n "$admin_user" && -n "$admin_pass" ]]; then
    stats_xml="$(curl -fsS --max-time 4 -u "$admin_user:$admin_pass" "$ADMIN_STATS_URL" 2>/dev/null || true)"
    if [[ -n "$stats_xml" ]] && grep -q "<source mount=\"$STREAM_MOUNT\">" <<<"$stats_xml"; then
        stream_ok=true
    fi
fi

if $icecast_ok && $liquidsoap_ok && $stream_ok; then
    echo "0" > "$STATE_FILE"
    exit 0
fi

fail_count=$((fail_count + 1))
echo "$fail_count" > "$STATE_FILE"

echo "$(date '+%Y-%m-%d %H:%M:%S') WARN: fail=$fail_count/$FAIL_THRESHOLD icecast_ok=$icecast_ok liquidsoap_ok=$liquidsoap_ok stream_ok=$stream_ok" >> "$LOG"

if [[ "$fail_count" -lt "$FAIL_THRESHOLD" ]]; then
    exit 0
fi

if ! $icecast_ok; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ACTION: restarting icecast2 + localfarts + localfarts-hls" >> "$LOG"
    systemctl restart icecast2
    sleep 2
    systemctl restart localfarts
    sleep 2
    systemctl restart localfarts-hls
elif ! $liquidsoap_ok || ! $stream_ok; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ACTION: restarting localfarts + localfarts-hls" >> "$LOG"
    systemctl restart localfarts
    sleep 2
    systemctl restart localfarts-hls
fi

echo "0" > "$STATE_FILE"