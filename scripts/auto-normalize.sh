#!/bin/bash

# Файл лога
LOGFILE="/var/log/radio_normalize.log"

echo "========================================" >> $LOGFILE
echo "START: $(date)" >> $LOGFILE
echo "Запуск автоматической нормализации (Target: 94dB)..." >> $LOGFILE

# --- ЗАПУСК MP3GAIN ---
# ionice -c 3 : Режим "Idle". Процесс получит доступ к диску, только когда он никому не нужен.
# nice -n 19  : Минимальный приоритет процессора.
# -r : Track Gain (выравнивает каждый трек)
# -k : Clipping Protection (автоматически снижает громкость, если трек хрипит)
# -d 5 : Добавляет +5dB к стандарту (89+5 = 94dB). Это стандарт вещания.
# -c : Игнорировать предупреждения (так как -k их обрабатывает)
# -p : Сохранять дату файла

if ionice -c 3 nice -n 19 find /srv/radio/music -type f -name "*.mp3" -exec mp3gain -r -k -d 5 -c -p {} + >> $LOGFILE 2>&1; then
    echo "SUCCESS: Нормализация завершена успешно." >> $LOGFILE
else
    echo "ERROR: Возникли ошибки при нормализации." >> $LOGFILE
fi

echo "END: $(date)" >> $LOGFILE
echo "========================================" >> $LOGFILE
