#!/usr/bin/env python
"""EdgeBetter —— Windows 输入辅助：把最新 Edge 窗口置顶并点击指定屏幕坐标

用法: python tools/click-point.py X Y
坐标为物理屏幕像素（窗口矩形 + 元素在窗口内的偏移）。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

SW_RESTORE = 9
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_SHOWWINDOW = 0x0040
SWP_NOACTIVATE = 0x0010

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


def find_edge_window():
    """找最新启动的 Edge 主窗口（标题含 probe 的优先）"""
    procs = []
    # 用 EnumWindows 找所有可见的 Edge 窗口
    result = []

    def enum_cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if "Microsoft" not in title and "Edge" not in title:
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)
        if h:
            try:
                exe = ctypes.create_unicode_buffer(260)
                size = wt.DWORD(260)
                ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, exe, ctypes.byref(size))
                if "msedge.exe" in exe.value.lower():
                    result.append((hwnd, title))
            finally:
                ctypes.windll.kernel32.CloseHandle(h)
        return True

    EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    user32.EnumWindows(EnumWindowsProc(enum_cb), 0)
    # 优先标题含 probe 的窗口（测试窗口）
    for hwnd, title in result:
        if "probe" in title.lower():
            return hwnd, title
    return (result[0] if result else (None, None))


def raise_edge(hwnd):
    """把 Edge 窗口真正抬到最前。

    只调 SetWindowPos(HWND_TOPMOST) 不够：本机实测后台进程改不动 z 序，
    窗口仍被 IDE 全屏窗口压着，鼠标点击全落在 IDE 上。
    这里用经典组合拳：attach 到当前前台线程的输入队列再抢前台，
    最后 SwitchToThisWindow 兜底。返回是否真的成为前台窗口。
    """
    fg = user32.GetForegroundWindow()
    tid_fg = user32.GetWindowThreadProcessId(fg, None)
    tid_me = kernel32.GetCurrentThreadId()
    user32.AttachThreadInput(tid_me, tid_fg, True)
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    user32.SetFocus(hwnd)
    user32.AttachThreadInput(tid_me, tid_fg, False)
    user32.SwitchToThisWindow(hwnd, True)
    time.sleep(0.4)
    return user32.GetForegroundWindow() == hwnd


def main():
    if sys.argv[1] == "--key":
        # 发一个按键（SendInput）。气泡里的按钮对注入的鼠标点击不响应，
        # 但「名称」输入框有焦点，回车会触发默认按钮（完成）。
        vk = int(sys.argv[2])
        KEYEVENTF_KEYUP = 0x0002

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                        ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]

        class _INPUTunion(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT), ("padding", ctypes.c_byte * 24)]

        class INPUT(ctypes.Structure):
            _fields_ = [("type", wt.DWORD), ("u", _INPUTunion)]

        def send(flags):
            inp = INPUT(type=1)
            inp.u.ki = KEYBDINPUT(vk, 0, flags, 0, None)
            user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

        send(0)
        time.sleep(0.05)
        send(KEYEVENTF_KEYUP)
        print(f"OK key vk={vk}")
        return

    if sys.argv[1] == "--raw":
        # 原样点击：只移动光标 + 点击，不抬窗口、不抢焦点。
        # 点收藏气泡这类"失焦即关"的弹层时必须用它——raise_edge 会把焦点
        # 抢回主窗口，气泡立刻关闭。
        x, y = int(sys.argv[2]), int(sys.argv[3])
        pt = wt.POINT(x, y)
        hit = user32.WindowFromPoint(pt)
        root = user32.GetAncestor(hit, 2)  # GA_ROOT：点到的是子窗口时回溯到顶层窗口
        n = user32.GetWindowTextLengthW(root)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(root, buf, n + 1)
        user32.SetCursorPos(x, y)
        time.sleep(0.15)
        cur = wt.POINT()
        user32.GetCursorPos(ctypes.byref(cur))
        # 光标实际落点处是哪个窗口（验证 SetCursorPos 与坐标空间一致）
        root2 = user32.GetAncestor(user32.WindowFromPoint(cur), 2)
        n2 = user32.GetWindowTextLengthW(root2)
        buf2 = ctypes.create_unicode_buffer(n2 + 1)
        user32.GetWindowTextW(root2, buf2, n2 + 1)
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        print(f"OK raw click=({x},{y}) root={root} rootTitle='{buf.value}' "
              f"cursor=({cur.x},{cur.y}) cursorRoot={root2} cursorTitle='{buf2.value}'")
        return

    if sys.argv[1] == "--focus":
        # 只把 Edge 窗口抬到最前（不点击），供整屏抓取 / 真实点击使用：
        # 浏览器气泡（收藏气泡等）是独立 HWND，PrintWindow 抓不到，
        # 而点击必须落到 Edge 上而不是压着它的窗口。
        hwnd, title = find_edge_window()
        if hwnd is None:
            print("NO_WINDOW")
            sys.exit(1)
        ok = raise_edge(hwnd)
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        cx, cy = (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2
        pt = wt.POINT(cx, cy)
        user32.WindowFromPoint(ctypes.byref(pt))
        top = user32.WindowFromPoint(pt)
        print(f"OK hwnd={hwnd} foreground={ok} onTopHere={top == hwnd} "
              f"rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) title='{title}'")
        return

    x, y = int(sys.argv[1]), int(sys.argv[2])
    hwnd, title = find_edge_window()
    if hwnd is None:
        print("NO_WINDOW")
        sys.exit(1)
    # 必须先真正抬到最前，否则点击落到压着它的窗口上
    ok = raise_edge(hwnd)
    user32.SetCursorPos(x, y)
    time.sleep(0.15)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    pt = wt.POINT(x, y)
    top = user32.WindowFromPoint(pt)
    print(f"OK hwnd={hwnd} foreground={ok} onTopHere={top == hwnd} title='{title}' click=({x},{y})")


if __name__ == "__main__":
    main()
