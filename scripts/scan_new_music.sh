#!/bin/bash
exec 200>/var/lock/radio_music_scan.lock
flock -n 200 || exit 0

STAMP_FILE="/var/log/radio_music_scan.stamp"
NEW_STAMP_FILE="/var/log/radio_music_scan.stamp.new"
touch "$NEW_STAMP_FILE"
LOG_FILE="/var/log/radio_music_scan.log"
PROCESSED_COUNT=0
MUSIC_DIR="/srv/radio/music" 
PLAYLIST_FILE="/srv/radio/music.m3u"

if [ ! -f "$STAMP_FILE" ]; then
    echo "⚠️ Штамп не найден! Запускаем полное сканирование (Deep Scan)..." | tee -a "$LOG_FILE"
    touch -d "1970-01-01 00:00:00" "$STAMP_FILE"
fi

# УМНОЕ СКАНИРОВАНИЕ (Только жанровое тегирование)
while IFS= read -r -d '' file; do
    PROCESSED_COUNT=$((PROCESSED_COUNT + 1))
    
    echo "🎵 Обработка нового файла: $file" >> "$LOG_FILE"
    
    # Тегируем жанр
    if /usr/bin/python3 /usr/local/bin/auto_tagger.py "$file" >> "$LOG_FILE" 2>&1; then
        echo "   ✅ Жанр успешно добавлен" >> "$LOG_FILE"
    else
        echo "   ❌ Ошибка авто-теггера" >> "$LOG_FILE"
    fi
    
done < <(find "$MUSIC_DIR" -type f \( -iname "*.mp3" -o -iname "*.flac" -o -iname "*.ogg" -o -iname "*.m4a" \) -cnewer "$STAMP_FILE" -print0)

# ФИНАЛИЗАЦИЯ
if [ "$PROCESSED_COUNT" -gt 0 ]; then
    mv "$NEW_STAMP_FILE" "$STAMP_FILE"
    
    # БЕЗОПАСНАЯ генерация плейлиста
    if find "$MUSIC_DIR" -type f \( -iname "*.mp3" -o -iname "*.flac" -o -iname "*.ogg" -o -iname "*.m4a" \) > "${PLAYLIST_FILE}.tmp"; then
        mv "${PLAYLIST_FILE}.tmp" "$PLAYLIST_FILE"
        if command -v nc >/dev/null; then
            # Передаем правильную команду перезагрузки для плейлиста music_fallback
            echo "music_fallback.reload" | nc -w 1 127.0.0.1 1234 >> "$LOG_FILE" 2>&1
        fi
    else
        echo "❌ КРИТИЧЕСКАЯ ОШИБКА: find не смог собрать файлы! Плейлист не изменен." >> "$LOG_FILE"
    fi
else
    rm -f "$NEW_STAMP_FILE"
fi

# Лог каждого запуска (даже холостого)
echo "$(date '+%Y-%m-%d %H:%M:%S') — Scan complete. Processed: $PROCESSED_COUNT files." >> "$LOG_FILE"