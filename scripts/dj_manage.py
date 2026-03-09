#!/usr/bin/env python3
"""
DJ Manager для LOCAL FARTS Radio
Управление диджеями из командной строки.

Использование:
  dj_manage.py list                              — список DJ
  dj_manage.py add <user> <password> <name> [max_min]  — добавить DJ
  dj_manage.py remove <user>                     — удалить DJ
  dj_manage.py enable <user>                     — включить DJ
  dj_manage.py disable <user>                    — выключить DJ
  dj_manage.py passwd <user> <new_password>      — сменить пароль
  dj_manage.py settime <user> <minutes>          — установить лимит времени
  dj_manage.py kick                              — отключить текущего DJ
  dj_manage.py status                            — кто сейчас в эфире
"""

import json
import sys
import os
import socket
from datetime import datetime

DJ_FILE = "/srv/radio/djs.json"
TELNET_HOST = "127.0.0.1"
TELNET_PORT = 1234
SESSION_FILE = "/tmp/dj_current_session.json"


def load_djs():
    try:
        with open(DJ_FILE, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        print("ОШИБКА: djs.json повреждён")
        sys.exit(1)


def save_djs(djs):
    tmp = DJ_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(djs, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, DJ_FILE)


def hash_password(password):
    """Хешируем пароль через bcrypt"""
    try:
        import bcrypt
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    except ImportError:
        print("ВНИМАНИЕ: bcrypt не установлен, пароль сохранён как plaintext")
        print("  Установи: pip install bcrypt --break-system-packages")
        return password


def telnet_cmd(cmd):
    """Отправить команду в Liquidsoap telnet"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect((TELNET_HOST, TELNET_PORT))
        s.sendall((cmd + "\n").encode())

        response = b""
        while True:
            try:
                chunk = s.recv(4096)
                if not chunk:
                    break
                response += chunk
                if b"END" in chunk:
                    break
            except socket.timeout:
                break

        s.sendall(b"quit\n")
        s.close()
        return response.decode("utf-8", errors="replace").strip()
    except Exception as e:
        return f"ОШИБКА telnet: {e}"


def cmd_list():
    djs = load_djs()
    if not djs:
        print("Нет зарегистрированных DJ")
        return

    print(f"{'Username':<20} {'Имя':<25} {'Лимит':<12} {'Статус':<10}")
    print("-" * 67)
    for user, info in sorted(djs.items()):
        name = info.get("name", "—")
        max_min = info.get("max_minutes", 0)
        limit = f"{max_min} мин" if max_min > 0 else "∞"
        status = "✅ вкл" if info.get("enabled", False) else "❌ выкл"
        print(f"{user:<20} {name:<25} {limit:<12} {status:<10}")

    print(f"\nВсего: {len(djs)} DJ")


def cmd_add(user, password, name, max_minutes=60):
    if len(password) < 8:
        print("ОШИБКА: пароль должен быть минимум 8 символов")
        return

    # Только латиница, цифры, подчёркивание
    if not all(c.isalnum() or c == '_' for c in user):
        print("ОШИБКА: username может содержать только буквы, цифры и _")
        return

    djs = load_djs()

    if user in djs:
        print(f"ОШИБКА: DJ '{user}' уже существует")
        return

    djs[user] = {
        "password_hash": hash_password(password),
        "name": name,
        "max_minutes": int(max_minutes),
        "enabled": True
    }
    save_djs(djs)
    print(f"✅ DJ '{user}' ({name}) добавлен, лимит: {max_minutes} мин")


def cmd_remove(user):
    djs = load_djs()
    if user not in djs:
        print(f"ОШИБКА: DJ '{user}' не найден")
        return

    name = djs[user].get("name", user)
    del djs[user]
    save_djs(djs)
    print(f"✅ DJ '{user}' ({name}) удалён")


def cmd_enable(user):
    djs = load_djs()
    if user not in djs:
        print(f"ОШИБКА: DJ '{user}' не найден")
        return

    djs[user]["enabled"] = True
    save_djs(djs)
    print(f"✅ DJ '{user}' включён")


def cmd_disable(user):
    djs = load_djs()
    if user not in djs:
        print(f"ОШИБКА: DJ '{user}' не найден")
        return

    djs[user]["enabled"] = False
    save_djs(djs)
    print(f"✅ DJ '{user}' выключен")

    # Если DJ сейчас в эфире — кикаем
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r") as f:
                session = json.load(f)
            if session.get("user") == user:
                print("   DJ сейчас в эфире — кикаю...")
                cmd_kick()
        except Exception:
            pass


def cmd_passwd(user, new_password):
    if len(new_password) < 8:
        print("ОШИБКА: пароль должен быть минимум 8 символов")
        return

    djs = load_djs()
    if user not in djs:
        print(f"ОШИБКА: DJ '{user}' не найден")
        return

    djs[user]["password_hash"] = hash_password(new_password)
    save_djs(djs)
    print(f"✅ Пароль DJ '{user}' обновлён")


def cmd_settime(user, minutes):
    djs = load_djs()
    if user not in djs:
        print(f"ОШИБКА: DJ '{user}' не найден")
        return

    djs[user]["max_minutes"] = int(minutes)
    save_djs(djs)
    limit = f"{minutes} мин" if int(minutes) > 0 else "без лимита"
    print(f"✅ DJ '{user}' — лимит: {limit}")


def cmd_kick():
    """Кикнуть текущего DJ через telnet"""
    result = telnet_cmd("live_harbor.stop")
    if "Done" in result or "done" in result.lower():
        print("✅ DJ отключён")
    else:
        print(f"Ответ Liquidsoap: {result}")


def cmd_status():
    """Проверить кто сейчас в эфире"""
    result = telnet_cmd("live_harbor.status")
    print(f"Harbor статус: {result}")

    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r") as f:
                session = json.load(f)
            user = session.get("user", "?")
            name = session.get("name", "?")
            started = session.get("connected_at", "?")
            max_min = session.get("max_minutes", 0)
            print(f"\nТекущий DJ: {name} ({user})")
            print(f"Подключён: {started}")
            if max_min > 0:
                print(f"Лимит: {max_min} мин")
        except Exception:
            pass
    else:
        if "no source" in result.lower() or "not connected" in result.lower():
            print("\nНикто не в эфире (autodj)")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]

    if cmd == "list":
        cmd_list()
    elif cmd == "add":
        if len(sys.argv) < 5:
            print("Использование: dj_manage.py add <username> <password> <name> [max_minutes]")
            return
        max_min = sys.argv[5] if len(sys.argv) > 5 else 60
        cmd_add(sys.argv[2], sys.argv[3], sys.argv[4], max_min)
    elif cmd == "remove":
        if len(sys.argv) < 3:
            print("Использование: dj_manage.py remove <username>")
            return
        cmd_remove(sys.argv[2])
    elif cmd == "enable":
        if len(sys.argv) < 3:
            print("Использование: dj_manage.py enable <username>")
            return
        cmd_enable(sys.argv[2])
    elif cmd == "disable":
        if len(sys.argv) < 3:
            print("Использование: dj_manage.py disable <username>")
            return
        cmd_disable(sys.argv[2])
    elif cmd == "passwd":
        if len(sys.argv) < 4:
            print("Использование: dj_manage.py passwd <username> <new_password>")
            return
        cmd_passwd(sys.argv[2], sys.argv[3])
    elif cmd == "settime":
        if len(sys.argv) < 4:
            print("Использование: dj_manage.py settime <username> <minutes>")
            return
        cmd_settime(sys.argv[2], sys.argv[3])
    elif cmd == "kick":
        cmd_kick()
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Неизвестная команда: {cmd}")
        print(__doc__)


if __name__ == "__main__":
    main()