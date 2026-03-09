#!/usr/bin/env bash
set -Eeuo pipefail

# === CONFIG ===
DATA_DIR="/srv/radio/radio_data"
HISTORY_FILE="$DATA_DIR/history.txt"
HISTORY_TMP="$DATA_DIR/history.tmp"
HISTORY_JSON_FILE="$DATA_DIR/history.json"
HISTORY_JSON_TMP="$DATA_DIR/history.json.tmp"
NOWPLAYING_FILE="$DATA_DIR/nowplaying.json"
NOWPLAYING_TMP="$DATA_DIR/nowplaying.tmp"
SEQ_FILE="$DATA_DIR/nowplaying.seq"
SEQ_TMP="$DATA_DIR/nowplaying.seq.tmp"
LOCK_FILE="/var/lib/liquidsoap/radio_history.lock"

TRACK_NAME="${1:-}"

if [[ -z "$TRACK_NAME" ]]; then
    exit 0
fi

mkdir -p "$DATA_DIR"

json_escape() {
    local s="$1"
    # Strip control chars U+0000–U+0008, U+000B, U+000C, U+000E–U+001F
    # (tab \x09, newline \x0A, CR \x0D are handled below as space replacements)
    s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/ }"
    s="${s//$'\r'/ }"
    s="${s//$'\t'/ }"
    printf '%s' "$s"
}

unix_ms_now() {
    local ms
    ms="$(date -u +%s%3N 2>/dev/null || true)"
    if [[ "$ms" =~ ^[0-9]{13}$ ]]; then
        printf '%s' "$ms"
    else
        printf '%s' "$(( $(date -u +%s) * 1000 ))"
    fi
}

split_artist_title() {
    local full="$1"
    ARTIST=""
    TITLE="$full"
    if [[ "$full" == *" - "* ]]; then
        ARTIST="${full%% - *}"
        TITLE="${full#* - }"
    fi
}

utc_to_ms() {
    local ts="$1"
    local ms sec
    ms="$(date -u -d "$ts" +%s%3N 2>/dev/null || true)"
    if [[ "$ms" =~ ^[0-9]{13}$ ]]; then
        printf '%s' "$ms"
        return
    fi

    sec="$(date -u -d "$ts" +%s 2>/dev/null || true)"
    if [[ "$sec" =~ ^[0-9]+$ ]]; then
        printf '%s' "$((sec * 1000))"
        return
    fi

    printf '0'
}

write_history_json() {
    local now_utc="$1"
    local now_ms="$2"
    local line ts track
    local first=1
    local idx=0

    cat > "$HISTORY_JSON_TMP" <<EOF
{
  "updated_at_utc": "$now_utc",
  "updated_at_unix_ms": $now_ms,
  "items": [
EOF

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        case "$line" in
            *" || "*)
                ts="${line%% || *}"
                track="${line#* || }"
                ;;
            *)
                continue
                ;;
        esac

        split_artist_title "$track"

        local ts_esc track_esc artist_esc title_esc started_ms
        ts_esc="$(json_escape "$ts")"
        track_esc="$(json_escape "$track")"
        artist_esc="$(json_escape "$ARTIST")"
        title_esc="$(json_escape "$TITLE")"
        started_ms="$(utc_to_ms "$ts")"

        idx="$((idx + 1))"

        if [[ "$first" -eq 0 ]]; then
            printf ',\n' >> "$HISTORY_JSON_TMP"
        fi
        first=0

        printf '    {"index": %s, "started_at_utc": "%s", "started_at_unix_ms": %s, "track": "%s", "artist": "%s", "title": "%s"}' \
            "$idx" "$ts_esc" "$started_ms" "$track_esc" "$artist_esc" "$title_esc" >> "$HISTORY_JSON_TMP"
    done < "$HISTORY_FILE"

    cat >> "$HISTORY_JSON_TMP" <<'EOF'

  ]
}
EOF

    mv -f "$HISTORY_JSON_TMP" "$HISTORY_JSON_FILE"
    chmod 644 "$HISTORY_JSON_FILE"
}

(
    flock -x -w 10 200 || exit 1

    touch "$HISTORY_FILE"
    [[ -f "$SEQ_FILE" ]] || printf '0\n' > "$SEQ_FILE"

    NOW_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    NOW_MS="$(unix_ms_now)"

    # Определяем artist/title ДО вызова write_history_json — он перезаписывает глобальные ARTIST/TITLE
    split_artist_title "$TRACK_NAME"
    HISTORY_TRACK_NAME="$TRACK_NAME"
    if [[ "$ARTIST" == LIVE:* ]]; then
        HISTORY_TRACK_NAME="$TITLE"
    fi
    CURRENT_ARTIST="$ARTIST"
    CURRENT_TITLE="$TITLE"

    # history.txt (newest first, keep 20)
    printf "%s || %s\n" "$NOW_UTC" "$HISTORY_TRACK_NAME" > "$HISTORY_TMP"
    head -n 19 "$HISTORY_FILE" >> "$HISTORY_TMP"
    mv -f "$HISTORY_TMP" "$HISTORY_FILE"
    chmod 644 "$HISTORY_FILE"

    # history.json
    write_history_json "$NOW_UTC" "$NOW_MS"

    # sequence (monotonic)
    LAST_SEQ="$(head -n 1 "$SEQ_FILE" 2>/dev/null || true)"
    if [[ ! "$LAST_SEQ" =~ ^[0-9]+$ ]]; then
        LAST_SEQ=0
    fi
    NEXT_SEQ="$((LAST_SEQ + 1))"
    printf "%s\n" "$NEXT_SEQ" > "$SEQ_TMP"
    mv -f "$SEQ_TMP" "$SEQ_FILE"
    chmod 644 "$SEQ_FILE"

    TRACK_ESC="$(json_escape "$TRACK_NAME")"
    ARTIST_ESC="$(json_escape "$CURRENT_ARTIST")"
    TITLE_ESC="$(json_escape "$CURRENT_TITLE")"

    cat > "$NOWPLAYING_TMP" <<EOF
{
  "sequence": $NEXT_SEQ,
  "track": "$TRACK_ESC",
  "artist": "$ARTIST_ESC",
  "title": "$TITLE_ESC",
  "is_live": $(if [[ "$CURRENT_ARTIST" == LIVE:* ]]; then echo "true"; else echo "false"; fi),
  "started_at_utc": "$NOW_UTC",
  "started_at_unix_ms": $NOW_MS,
  "updated_at_utc": "$NOW_UTC",
  "updated_at_unix_ms": $NOW_MS
}
EOF
    mv -f "$NOWPLAYING_TMP" "$NOWPLAYING_FILE"
    chmod 644 "$NOWPLAYING_FILE"

    curl -s -X POST http://127.0.0.1:7890/internal/update > /dev/null || true

) 200>"$LOCK_FILE"