#!/usr/bin/env python
"""用真实输入模拟「触控板捏合」：Ctrl + 滚轮

Chromium 把触控板捏合合成为 ctrl+wheel，所以真实 Ctrl+滚轮与它走同一条
浏览器缩放路径（CDP 注入的合成事件不触发 page zoom，不能用）。

用法:
  python tools/wheel-zoom.py --focus --click --wheel -600
    --focus   把 Edge 窗口置前
    --click   先点窗口中心（制造 user activation，并确保焦点在页面上）
    --wheel   N  发一次 Ctrl+滚轮，N 为滚轮增量（正=放大，负=缩小）
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.windll.user32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
SW_RESTORE = 9
VK_CONTROL = 0x11
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_WHEEL = 0x0800


def find_window(keyword):
    out = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if keyword.lower() in buf.value.lower() and cls.value == "Chrome_WidgetWin_1":
            r = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            out.append((hwnd, buf.value, r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def main():
    args = sys.argv[1:]
    focus = "--focus" in args
    do_click = "--click" in args
    keyword = "pinch probe"
    if "--title" in args:
        keyword = args[args.index("--title") + 1]
    wheel = 0
    if "--wheel" in args:
        wheel = int(args[args.index("--wheel") + 1])

    wins = [w for w in find_window(keyword) if w[4] > 400 and w[5] > 300]
    if not wins:
        print("NO_WINDOW")
        return 1
    hwnd, title, l, t, w, h = max(wins, key=lambda x: x[4] * x[5])

    if focus:
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.8)
        if user32.GetForegroundWindow() != hwnd:
            print("NOT_FOREGROUND")
            return 2

    cx, cy = l + w // 2, t + h // 2

    if do_click:
        user32.SetCursorPos(cx, cy)
        time.sleep(0.15)
        user32.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.06)
        user32.mouse_event(0x0004, 0, 0, 0, 0)
        time.sleep(0.4)

    if wheel:
        user32.SetCursorPos(cx, cy)
        time.sleep(0.15)
        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, ctypes.c_long(wheel).value, 0)
        time.sleep(0.08)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.3)

    print(f"OK hwnd={hwnd} title={title} click={do_click} wheel={wheel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
