#!/usr/bin/env python3
import os
import sys
import time
import requests
import mutagen
from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.mp3 import MP3

# ==========================================
# КОНФИГУРАЦИЯ
# ==========================================
MUSIC_DIR = "/srv/radio/music"
LASTFM_API_KEY = "82b4019044515156d499a6ee83f0fbc0"

# Расширили список мусора
BLACKLIST_TAGS = {
    'seen live', 'under 2000 listeners', 'favorites', 'awesome', 
    'my favorite', 'loved', 'beautiful', 'love', '00s', '10s', '20s', '90s', '80s'
}

# ==========================================
# ЛОГИКА
# ==========================================

def get_tags_from_lastfm(artist, title, retries=3):
    """Стучится в Last.fm с учетом Rate Limit и ретраев"""
    url = "http://ws.audioscrobbler.com/2.0/"
    params = {
        'method': 'track.getInfo',
        'api_key': LASTFM_API_KEY,
        'artist': artist,
        'track': title,
        'format': 'json',
        'autocorrect': 1
    }
    
    for attempt in range(retries):
        try:
            # Спим 0.25 сек, чтобы не ддосить Last.fm (макс 4 запроса в секунду)
            time.sleep(0.25)
            
            r = requests.get(url, params=params, timeout=10)
            r.raise_for_status() # Бросит ошибку, если статус 4xx или 5xx
            
            data = r.json()
            
            if 'error' in data:
                print(f"   ⚠️ API Error: {data.get('message', 'Unknown')}", flush=True)
                return None

            tags = []
            # Безопасный парсинг JSON-дерева
            if data.get('track', {}).get('toptags', {}).get('tag'):
                for tag in data['track']['toptags']['tag']:
                    name = tag.get('name', '').lower().strip()
                    if name and name not in BLACKLIST_TAGS and len(name) > 2:
                        tags.append(name.title()) 
            
            return ", ".join(tags[:3]) if tags else None
            
        except requests.exceptions.RequestException as e:
            print(f"   ⏳ Network/HTTP Error on attempt {attempt+1}: {e}", flush=True)
            time.sleep(1) # Ждем секунду перед повтором
        except ValueError: # Ловим ошибки парсинга JSON
            print("   ❌ Invalid JSON received from Last.fm", flush=True)
            break
            
    return None

def process_file(filepath):
    """Открывает файл, проверяет жанр, обновляет его и сохраняет права"""
    try:
        # Запоминаем текущие права и владельца файла (DevOps safety)
        file_stat = os.stat(filepath)
        original_uid = file_stat.st_uid
        original_gid = file_stat.st_gid

        ext = os.path.splitext(filepath)[1].lower()
        
        audio = None
        if ext == '.mp3':
            audio = MP3(filepath, ID3=EasyID3)
        elif ext == '.flac':
            audio = FLAC(filepath)
        elif ext == '.ogg':
            audio = OggVorbis(filepath)
        
        if audio is None:
            return

        # Инициализация тегов, если файл вообще девственно чист (особенно MP3)
        if audio.tags is None:
            audio.add_tags()

        # Безопасное чтение с очисткой от пробелов
        artist = str(audio.get('artist', [''])[0]).strip()
        title = str(audio.get('title', [''])[0]).strip()
        current_genre = str(audio.get('genre', [''])[0]).strip()

        if current_genre and len(current_genre) > 2:
            return 

        if not artist or not title:
            print(f"⏭️  Skipping (No Artist/Title): {os.path.basename(filepath)}", flush=True)
            return

        print(f"🔍 Digging: {artist} - {title}...", flush=True)
        new_genre = get_tags_from_lastfm(artist, title)
        
        if new_genre:
            audio['genre'] = new_genre
            audio.save()
            
            # Возвращаем владельца на место, если save() его сбросил
            if os.geteuid() == 0: # Делаем chown только если скрипт запущен от root
                os.chown(filepath, original_uid, original_gid)
                
            print(f"   ✅ Tagged: {new_genre}", flush=True)
        else:
            print("   💨 No tags found", flush=True)

    except Exception as e:
        print(f"   ☠️ File Error ({os.path.basename(filepath)}): {e}", flush=True)

def main():
    if len(sys.argv) > 1:
        target = sys.argv[1]
        if os.path.isfile(target):
            process_file(target)
        elif os.path.isdir(target):
            # Если передали папку (для первого глобального сканирования)
            print("🚀 Deep Scanning Directory...", flush=True)
            for root, dirs, files in os.walk(target):
                for file in files:
                    if file.lower().endswith(('.mp3', '.flac', '.ogg')):
                        process_file(os.path.join(root, file))
    else:
        print("Usage: auto_tagger.py <file_or_directory>")

if __name__ == "__main__":
    main()