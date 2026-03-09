#!/bin/bash

# ==============================================================================
# DEPLOY RADIO — Вебхук-деплой из GitHub
# ==============================================================================
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO_DIR="/root/radio-backup"
LOG_FILE="/var/log/radio_deploy.log"

exec >> "$LOG_FILE" 2>&1

echo "========================================="
echo "🚀 ЗАПУСК ДЕПЛОЯ: $(date)"

cd "$REPO_DIR" || { echo "❌ Папка не найдена!"; exit 1; }

echo "Связываюсь с GitHub..."
git fetch origin main || { echo "❌ Ошибка сети!"; exit 1; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "✅ Изменений нет."
    exit 0
fi

echo "Обнаружены изменения!"
CHANGED_FILES=$(git diff --name-only "$LOCAL" "$REMOTE")
echo "$CHANGED_FILES"

# ==============================================================================
# ФЛАГИ
# ==============================================================================
RESTART_LIQUIDSOAP=0
RESTART_ICECAST=0
RELOAD_NGINX=0
RELOAD_DAEMON=0
RESTART_SSE=0
RESTART_ADMIN=0
UPDATE_WEBSITE=0
UPDATE_SCRIPTS=0

if echo "$CHANGED_FILES" | grep -qE "^liquidsoap/"; then RESTART_LIQUIDSOAP=1; fi
if echo "$CHANGED_FILES" | grep -qE "^icecast/"; then RESTART_ICECAST=1; fi
if echo "$CHANGED_FILES" | grep -qE "^nginx/"; then RELOAD_NGINX=1; fi
if echo "$CHANGED_FILES" | grep -qE "^systemd/"; then RELOAD_DAEMON=1; fi
if echo "$CHANGED_FILES" | grep -qE "sse_server\.py"; then RESTART_SSE=1; fi
if echo "$CHANGED_FILES" | grep -qE "^admin-panel/"; then RESTART_ADMIN=1; fi
if echo "$CHANGED_FILES" | grep -qE "^frontend/"; then UPDATE_WEBSITE=1; fi
if echo "$CHANGED_FILES" | grep -qE "^scripts/"; then UPDATE_SCRIPTS=1; fi

# ==============================================================================
# ПРИМЕНЕНИЕ
# ==============================================================================
git reset --hard origin/main

echo "Раскладываю файлы..."

# -- Systemd --
if [ $RELOAD_DAEMON -eq 1 ]; then
    echo "📋 Обновляю systemd сервисы..."
    cp ./systemd/*.service /etc/systemd/system/ 2>/dev/null || true
fi

# -- Скрипты --
if [ $UPDATE_SCRIPTS -eq 1 ]; then
    echo "📜 Обновляю скрипты..."
    cp ./scripts/*.py /usr/local/bin/ 2>/dev/null || true
    cp ./scripts/*.sh /usr/local/bin/ 2>/dev/null || true
    chmod +x /usr/local/bin/*.py /usr/local/bin/*.sh 2>/dev/null || true
fi

# -- Admin Panel --
if [ $RESTART_ADMIN -eq 1 ]; then
    echo "🖥️ Обновляю Admin Panel..."
    mkdir -p /srv/radio/admin-api /srv/radio/admin
    cp ./admin-panel/main.py /srv/radio/admin-api/main.py 2>/dev/null || true
    cp ./admin-panel/index.html /srv/radio/admin/index.html 2>/dev/null || true
fi

# -- Фронтенд сайта (Vite build) --
if [ $UPDATE_WEBSITE -eq 1 ]; then
    echo "🌐 Собираю сайт..."
    cd "$REPO_DIR/frontend" || exit 1
    npm install
    npm run build
    rsync -a --delete --chown=www-data:www-data ./dist/ /var/www/html/
    cd "$REPO_DIR"
fi

# -- Nginx --
if [ $RELOAD_NGINX -eq 1 ] && [ -d "./nginx" ]; then
    echo "🔧 Обновляю Nginx конфиги..."
    cp ./nginx/nginx.conf /etc/nginx/nginx.conf 2>/dev/null || true
    cp -r ./nginx/sites-available/* /etc/nginx/sites-available/ 2>/dev/null || true
    if [ -d "./nginx/snippets" ]; then
        mkdir -p /etc/nginx/snippets
        cp ./nginx/snippets/* /etc/nginx/snippets/ 2>/dev/null || true
    fi
fi

# -- Icecast --
if [ $RESTART_ICECAST -eq 1 ] && [ -f "./icecast/icecast.xml" ]; then
    cp ./icecast/icecast.xml /etc/icecast2/icecast.xml
    chown icecast2:icecast /etc/icecast2/icecast.xml
fi

# ==============================================================================
# РЕСТАРТЫ
# ==============================================================================
if [ $RELOAD_DAEMON -eq 1 ]; then
    echo "🔄 daemon-reload..."
    systemctl daemon-reload

    for svc_file in $(echo "$CHANGED_FILES" | grep "^systemd/" | sed 's|systemd/||'); do
        echo "  🔄 Рестарт: $svc_file"
        systemctl restart "$svc_file" 2>/dev/null || true
    done
fi

if [ $RESTART_ICECAST -eq 1 ]; then
    echo "🔄 Рестарт Icecast..."
    systemctl restart icecast2.service
fi

if [ $RESTART_SSE -eq 1 ]; then
    echo "🔄 Рестарт SSE..."
    systemctl restart localfarts-sse.service 2>/dev/null || true
fi

if [ $RESTART_ADMIN -eq 1 ]; then
    echo "🔄 Рестарт Admin Panel..."
    systemctl restart localfarts-admin.service 2>/dev/null || true
fi

if [ $RELOAD_NGINX -eq 1 ]; then
    echo "🔧 Проверяю Nginx..."
    if nginx -t >/dev/null 2>&1; then
        echo "✅ Nginx OK, reload..."
        systemctl reload nginx
    else
        echo "❌ ОШИБКА: сломан конфиг Nginx! Reload отменён."
    fi
fi

if [ $RESTART_LIQUIDSOAP -eq 1 ]; then
    echo "🎵 Проверяю Liquidsoap..."
    if /usr/local/bin/liquidsoap-opam --check ./liquidsoap/localfarts.liq; then
        echo "✅ Liquidsoap OK, копирую и рестартую..."
        cp ./liquidsoap/localfarts.liq /etc/liquidsoap/localfarts.liq
        systemctl restart localfarts.service
    else
        echo "❌ ОШИБКА в конфиге Liquidsoap! Рестарт отменён."
    fi
else
    echo "Конфиг радио не менялся."
fi

echo "🎉 Деплой завершён!"
echo "========================================="
