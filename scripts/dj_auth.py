#!/usr/bin/env python3
"""
DJ Auth для LOCAL FARTS Radio
Stdin: user\npassword\naddress (три строки)
Stdout: "true" или "false"
Также записывает сессию в /tmp/dj_current_session.json при успехе.
"""

import json
import sys
import os
import time
import fcntl
from contextlib import contextmanager
from datetime import datetime

DJ_FILE = "/srv/radio/djs.json"
LOG_FILE = "/var/log/localfarts/dj.log"
SESSION_FILE = "/tmp/dj_current_session.json"
FAIL_FILE = "/tmp/dj_auth_fails.json"
FAIL_LOCK_FILE = "/tmp/dj_auth_fails.lock"

MAX_FAILS = 5
FAIL_WINDOW = 300


@contextmanager
def _fail_lock():
    """Exclusive lock on FAIL_FILE to prevent concurrent read-modify-write races."""
    fh = open(FAIL_LOCK_FILE, "a")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def log_event(msg):
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def check_rate_limit(address):
    try:
        with _fail_lock():
            fails = {}
            if os.path.exists(FAIL_FILE):
                with open(FAIL_FILE, "r") as f:
                    fails = json.load(f)
            now = time.time()
            if address in fails:
                fails[address] = [t for t in fails[address] if now - t < FAIL_WINDOW]
                if len(fails[address]) >= MAX_FAILS:
                    return False
            return True
    except Exception:
        return True


def record_fail(address):
    try:
        with _fail_lock():
            fails = {}
            if os.path.exists(FAIL_FILE):
                with open(FAIL_FILE, "r") as f:
                    fails = json.load(f)
            now = time.time()
            if address not in fails:
                fails[address] = []
            fails[address].append(now)
            fails[address] = [t for t in fails[address] if now - t < FAIL_WINDOW]
            with open(FAIL_FILE, "w") as f:
                json.dump(fails, f)
    except Exception:
        pass


def clear_fails(address):
    try:
        with _fail_lock():
            if os.path.exists(FAIL_FILE):
                with open(FAIL_FILE, "r") as f:
                    fails = json.load(f)
                if address in fails:
                    del fails[address]
                    with open(FAIL_FILE, "w") as f:
                        json.dump(fails, f)
    except Exception:
        pass


def main():
    lines = sys.stdin.read().strip().split("\n")
    if len(lines) < 2:
        print("false")
        return

    user = lines[0].strip()
    password = lines[1].strip()
    address = lines[2].strip() if len(lines) > 2 else "unknown"

    if not check_rate_limit(address):
        log_event(f"RATE-LIMIT {user} from {address}")
        print("false")
        return

    try:
        with open(DJ_FILE, "r") as f:
            djs = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log_event(f"ERROR loading djs.json: {e}")
        print("false")
        return

    if user not in djs:
        log_event(f"AUTH-FAIL {user} from {address} (unknown user)")
        record_fail(address)
        print("false")
        return

    dj = djs[user]

    if not dj.get("enabled", False):
        log_event(f"AUTH-FAIL {user} from {address} (disabled)")
        print("false")
        return

    stored = dj.get("password_hash", "")

    if stored.startswith("$2"):
        try:
            import bcrypt
            if not bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8")):
                log_event(f"AUTH-FAIL {user} from {address} (wrong password)")
                record_fail(address)
                print("false")
                return
        except ImportError:
            log_event("ERROR bcrypt not installed, rejecting")
            print("false")
            return
    else:
        if stored != password:
            log_event(f"AUTH-FAIL {user} from {address} (wrong password)")
            record_fail(address)
            print("false")
            return

    # Успех
    clear_fails(address)
    name = dj.get("name", user)
    max_minutes = dj.get("max_minutes", 0)

    session = {
        "user": user,
        "name": name,
        "max_minutes": max_minutes,
        "connected_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "connected_ts": datetime.now().timestamp()
    }
    with open(SESSION_FILE, "w") as f:
        json.dump(session, f)

    log_event(f"AUTH-OK {user} \"{name}\" from {address} (limit: {max_minutes}min)")
    print("true")


if __name__ == "__main__":
    main()