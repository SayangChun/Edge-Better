#!/usr/bin/env python
"""探针：真实点窗口 X（等价 WM_CLOSE）时，content script 的 beforeunload 能否拦住关闭

不接任何调试器 —— CDP 附着会改变 Chromium 的行为，这类问题只能在真机上看。
用 PostMessage(WM_CLOSE) 模拟用户点右上角 X（走同一条正常关闭流程，含 beforeunload）。

两组对照：
  A 无 guard  → 发 WM_CLOSE 后窗口应消失（确认 WM_CLOSE 这条路本身有效）
  B 有 guard  → 发 WM_CLOSE 后窗口应仍在（关闭被拦），截图确认弹了原生确认框

用法:
  python tools/probe-wmclose.py
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SRC_EXT = r"E:\project\EdgeBetter"
WM_CLOSE = 0x0010
SW_RESTORE = 9

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def build_ext(guard: bool) -> str:
    d = tempfile.mkdtemp(prefix="edge-better-wmclose-ext-")
    for name in os.listdir(SRC_EXT):
        if name in ("node_modules", ".git", "tools", "test") or name.endswith(".zip"):
            continue
        s = os.path.join(SRC_EXT, name)
        t = os.path.join(d, name)
        if os.path.isdir(s):
            shutil.copytree(s, t)
        else:
            shutil.copy2(s, t)
    mf = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    if guard:
        os.makedirs(os.path.join(d, "cs"), exist_ok=True)
        open(os.path.join(d, "cs", "guard.js"), "w", encoding="utf-8").write(
            "window.addEventListener('beforeunload',(e)=>{e.preventDefault();"
            "e.returnValue='x';return 'x';});"
        )
        mf["content_scripts"] = [
            {"matches": ["http://*/*", "https://*/*"], "js": ["cs/guard.js"],
             "run_at": "document_start", "all_frames": False}
        ]
    open(os.path.join(d, "manifest.json"), "w", encoding="utf-8").write(
        json.dumps(mf, indent=2, ensure_ascii=False)
    )
    return d


def edge_pids() -> set:
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq msedge.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, errors="ignore",
    ).stdout
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if parts and parts[0].lower() == "msedge.exe":
            try:
                pids.add(int(parts[1]))
            except (IndexError, ValueError):
                pass
    return pids


def find_window_for_pid_tree(pids: set):
    """找属于这些 pid 的可见 Edge 主窗口（class Chrome_WidgetWin_1 且标题非空）"""
    found = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value
        if "Edge" not in title and "guard" not in title.lower():
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids:
            r = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append((hwnd, title, r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def click(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.15)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.2)


def dump_windows(pids: set):
    """列出属于这些 pid 的全部窗口（含不可见），用于定位模态对话框落在哪个 HWND"""
    out = []

    def cb(hwnd, _):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        out.append({
            "hwnd": hwnd, "pid": pid.value, "visible": bool(user32.IsWindowVisible(hwnd)),
            "title": buf.value, "class": cls.value,
            "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
        })
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def run_case(name: str, guard: bool, url: str) -> dict:
    ext = build_ext(guard)
    profile = tempfile.mkdtemp(prefix="edge-better-wmclose-profile-")
    before = edge_pids()
    proc = subprocess.Popen([
        EDGE,
        f"--user-data-dir={profile}",
        f"--load-extension={ext}",
        f"--disable-extensions-except={ext}",
        "--no-first-run", "--no-default-browser-check", "--disable-sync",
        "--window-size=1000,700", "--window-position=200,120",
        "--new-window", url,
    ])
    time.sleep(7)

    mine = edge_pids() - before
    wins = find_window_for_pid_tree(mine)
    res = {"case": name, "windows": len(wins)}
    if not wins:
        res["error"] = "找不到 Edge 窗口"
        proc.kill()
        return res

    hwnd, title, l, t, w, h = max(wins, key=lambda x: x[4] * x[5])

    # 启动瞬间窗口可能处于最小化（rect = -32000），先恢复再读真实矩形
    if l <= -30000 or w < 200:
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(1.2)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        l, t, w, h = r.left, r.top, r.right - r.left, r.bottom - r.top

    res.update(title=title, rect=[l, t, w, h])
    if w < 300 or h < 300:
        res["error"] = f"窗口尺寸异常，放弃本组：{w}x{h}@{l},{t}"
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        return res

    # 置顶 + 点页面正文（制造 sticky user activation，beforeunload 需要）
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(1.0)
    # 安全闸：前台不是我的测试窗口就绝不合成点击（避免误点用户正在用的窗口）
    fg = user32.GetForegroundWindow()
    res["foreground_ok"] = fg == hwnd
    if fg == hwnd:
        click(l + w // 2, t + h // 2)
        time.sleep(0.8)
    else:
        res["warning"] = "前台窗口不匹配，已跳过点击（无 user activation）"

    # 点右上角 X 的等价动作
    user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    time.sleep(3.5)

    res["window_alive"] = bool(user32.IsWindow(hwnd))
    res["edge_procs_alive"] = len(edge_pids() - before)
    res["proc_exit"] = proc.poll()

    if res["window_alive"]:
        alive_pids = edge_pids() - before
        res["all_windows"] = [w for w in dump_windows(alive_pids) if w["rect"][2] > 80]
        # 模态对话框通常是个独立的小窗口
        res["dialog_candidates"] = [
            w for w in res["all_windows"]
            if w["visible"] and w["hwnd"] != hwnd and w["rect"][2] < 900 and w["rect"][3] < 500
        ]

    # 截图留证
    shot = os.path.join(SRC_EXT, "tools", f"_wmclose-{name}.png")
    subprocess.run([sys.executable, os.path.join(SRC_EXT, "tools", "capture-window.py"),
                    shot, "Edge"], capture_output=True)
    res["screenshot"] = shot

    # 收尾
    if res["window_alive"]:
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        time.sleep(1.2)
        # 若仍被拦（说明弹框还在），直接杀进程树
        if user32.IsWindow(hwnd):
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True)
    else:
        time.sleep(0.5)
    if proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    return res


def main():
    import http.server
    import threading

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"<html><head><title>guard probe</title></head><body style='font-size:40px'>GUARD PROBE PAGE</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 8911), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:8911/page"

    for name, guard in (("A-noguard", False), ("B-guard", True)):
        r = run_case(name, guard, url)
        print(json.dumps(r, ensure_ascii=False))
        time.sleep(2)

    srv.shutdown()


if __name__ == "__main__":
    main()
