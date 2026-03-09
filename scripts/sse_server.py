#!/usr/bin/env python3
#test
import asyncio
import json
from aiohttp import web
import os

NOW_PLAYING_FILE = "/srv/radio/radio_data/nowplaying.json"
clients = set()

def get_single_line_json():
    """Читает JSON файл и возвращает его строго одной строкой (без переносов)"""
    if not os.path.exists(NOW_PLAYING_FILE):
        return None
    try:
        with open(NOW_PLAYING_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f) # Парсим красивый многострочный JSON
            return json.dumps(data) # Возвращаем плоскую строку без \n
    except Exception as e:
        print(f"Ошибка чтения JSON: {e}")
        return None

async def sse_handler(request):
    response = web.StreamResponse(
        status=200,
        headers={
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        }
    )
    await response.prepare(request)
    clients.add(response)
    
    try:
        # Отправляем текущий трек сразу при подключении
        flat_json = get_single_line_json()
        if flat_json:
            await response.write(f'data: {flat_json}\n\n'.encode('utf-8'))
        
        # Пинг каждые 15 сек для удержания соединения Nginx
        while True:
            await asyncio.sleep(15)
            await response.write(b': ping\n\n')
    except asyncio.CancelledError:
        pass
    except Exception:
        # ConnectionResetError / BrokenPipeError on client disconnect — not an error
        pass
    finally:
        clients.discard(response)
        return response

async def trigger_update(request):
    """Прием сигнала о смене трека от Liquidsoap"""
    flat_json = get_single_line_json()
    if flat_json:
        for client in list(clients):
            try:
                # Отправляем строго в формате одной строки data: {...}\n\n
                await client.write(f'data: {flat_json}\n\n'.encode('utf-8'))
            except Exception:
                clients.discard(client)
    return web.Response(text=f"Успешно отправлено {len(clients)} слушателям")

app = web.Application()
app.router.add_get('/events', sse_handler)
app.router.add_post('/internal/update', trigger_update)

if __name__ == "__main__":
    web.run_app(app, host='127.0.0.1', port=7890)