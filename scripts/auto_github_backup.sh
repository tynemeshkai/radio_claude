#!/bin/bash

# ==============================================================================
# AUTO GITHUB BACKUP — LOCAL FARTS Radio
# Бекапит все конфиги сервера в Git для управления через VS Code
# ==============================================================================
set -euo pipefail

BACKUP_DIR="/root/radio-backup"

if [ ! -d "$BACKUP_DIR" ]; then
    echo "❌ ОШИБКА: Папка $BACKUP_DIR не найдена! Прерываю бекап."
    exit 1
fi

cd "$BACKUP_DIR" || exit 1

# ==============================================================================
# СТРУКТУРА РЕПОЗИТОРИЯ
# ==============================================================================
mkdir -p liquidsoap icecast scripts website nginx systemd cron playlists admin-panel

# ==============================================================================
# ОЧИСТКА ОТ ПРИЗРАКОВ
# ==============================================================================
rm -rf ./website/* ./nginx/* ./scripts/* ./systemd/* ./admin-panel/*

# ==============================================================================
# 1. АУДИО-ЯДРО
# ==============================================================================
cp /etc/liquidsoap/localfarts.liq ./liquidsoap/ || true
cp /etc/icecast2/icecast.xml ./icecast/ || true

# ==============================================================================
# 2. NGINX
# ==============================================================================
cp -r /etc/nginx/sites-available ./nginx/ || true
cp /etc/nginx/nginx.conf ./nginx/ || true

# ==============================================================================
# 3. SYSTEMD СЕРВИСЫ
# ==============================================================================
cp /etc/systemd/system/localfarts.service ./systemd/ 2>/dev/null || true
cp /etc/systemd/system/*hls*.service ./systemd/ 2>/dev/null || true
cp /etc/systemd/system/*slicer*.service ./systemd/ 2>/dev/null || true
cp /etc/systemd/system/localfarts-sse.service ./systemd/ 2>/dev/null || true
cp /etc/systemd/system/localfarts-admin.service ./systemd/ 2>/dev/null || true

# ==============================================================================
# 4. СКРИПТЫ (/usr/local/bin + /srv/radio/scripts)
# ==============================================================================
cp /usr/local/bin/*.py ./scripts/ 2>/dev/null || true
cp /usr/local/bin/*.sh ./scripts/ 2>/dev/null || true
cp /srv/radio/scripts/* ./scripts/ 2>/dev/null || true

# ==============================================================================
# 5. ADMIN PANEL (бэкенд + фронтенд)
# ==============================================================================
cp /srv/radio/admin-api/main.py ./admin-panel/ 2>/dev/null || true
cp /srv/radio/admin/index.html ./admin-panel/ 2>/dev/null || true

# ==============================================================================
# 6. САЙТ (фронтенд радио)
# ==============================================================================
cp -r /var/www/html/* ./website/ || true

# ==============================================================================
# 7. ПЛЕЙЛИСТЫ
# ==============================================================================
cp /srv/radio/*.m3u ./playlists/ 2>/dev/null || true

# ==============================================================================
# 8. CRON
# ==============================================================================
crontab -l > ./cron/root_crontab.txt 2>/dev/null || true

# ==============================================================================
# 9. GIT PUSH
# ==============================================================================
if [[ $(git status --porcelain) ]]; then
    git add .
    git commit -m "Auto-backup: $(date +'%Y-%m-%d %H:%M:%S')"
    if git push origin main; then
        echo "✅ Бекап отправлен в GitHub"
    else
        echo "❌ ОШИБКА: Не удалось отправить в GitHub!"
        exit 1
    fi
else
    echo "ℹ️ Изменений нет"
    exit 0
fi
