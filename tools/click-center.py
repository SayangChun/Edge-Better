#!/usr/bin/env python
"""点最新 Edge 窗口的中心（制造 sticky user activation）

真机测试用：beforeunload 的关闭确认和 bfcache 资格都取决于「用户是否交互过」，
而 CDP 合成的点击不可用于 bfcache 实验（CDP 附着本身会禁用 bfcache），
所以只能用真实鼠标事件。

用法: python tools/click-center.py [窗口标题关键字，默认 Edge]
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.windll.user32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
SW_RESTORE = 9


def find_windows(keyword):
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
        if keyword in buf.value and cls.value == "Chrome_WidgetWin_1":
            r = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            out.append((hwnd, buf.value, r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else "Edge"
    wins = [w for w in find_windows(keyword) if w[4] > 400 and w[5] > 300]
    if not wins:
        print("NO_WINDOW")
        return 1
    hwnd, title, l, t, w, h = max(wins, key=lambda x: x[4] * x[5])
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.8)
    if user32.GetForegroundWindow() != hwnd:
        print(f"NOT_FOREGROUND hwnd={hwnd} title={title}")
        return 2

    x, y = l + w // 2, t + h // 2
    user32.SetCursorPos(x, y)
    time.sleep(0.15)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    print(f"CLICKED {x},{y} on {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
