#!/usr/bin/env python
"""EdgeBetter —— Edge 窗口捕获（含浏览器 UI：地址栏、星标）

用 PrintWindow(PW_RENDERFULLCONTENT) 直接渲染窗口内容，
不受窗口遮挡 / z-order 影响，输出 PNG。

用法: python tools/capture-window.py <输出.png> [窗口标题关键字，默认 probe]
"""
import ctypes
import ctypes.wintypes as wt
import sys

from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

# 关键：进程默认 DPI-unaware 时，GetWindowRect/DC 操作与 DWM 窗口的渲染坐标空间
# 不一致，PrintWindow 只会渲染出窗口的一部分。先声明为 per-monitor v2 感知。
# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def find_edge_window(title_filter):
    """枚举窗口，找标题含关键字、且进程为 msedge.exe 的窗口，返回 (hwnd, title)"""
    found = {}

    def enum_cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_filter.lower() not in buf.value.lower():
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not h:
            return True
        try:
            exe = ctypes.create_unicode_buffer(260)
            size = wt.DWORD(260)
            kernel32.QueryFullProcessImageNameW(h, 0, exe, ctypes.byref(size))
            if "msedge.exe" in exe.value.lower():
                found["hwnd"] = hwnd
                found["title"] = buf.value
                return False  # 停止枚举
        finally:
            kernel32.CloseHandle(h)
        return True

    user32.EnumWindows(EnumWindowsProc(enum_cb), 0)
    if "hwnd" not in found:
        return None, None
    return found["hwnd"], found["title"]


def capture(hwnd, out_path):
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w <= 0 or h <= 0:
        raise RuntimeError(f"BAD_RECT {w}x{h}")

    hdc_screen = user32.GetDC(None)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    # 2 = PW_RENDERFULLCONTENT：DWM 合成窗口也能渲染（含被遮挡的情况）
    ok = user32.PrintWindow(hwnd, hdc_mem, 2)

    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.biWidth = w
    bmi.biHeight = -h  # 负值 = 自顶向下
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0  # BI_RGB
    buf = ctypes.create_string_buffer(w * h * 4)
    got = gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bmi), 0)  # DIB_RGB_COLORS

    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(None, hdc_screen)

    if not ok or got != h:
        raise RuntimeError(f"capture failed: PrintWindow={ok} GetDIBits={got}/{h}")

    img = Image.frombuffer("RGBA", (w, h), buf.raw, "raw", "BGRA", 0, 1)
    img.save(out_path, "PNG")
    return w, h


def main():
    out_path = sys.argv[1]
    title_filter = sys.argv[2] if len(sys.argv) > 2 else "probe"
    hwnd, title = find_edge_window(title_filter)
    if hwnd is None:
        print("NO_WINDOW")
        sys.exit(1)
    w, h = capture(hwnd, out_path)
    print(f"OK title='{title}' {w}x{h}")


if __name__ == "__main__":
    main()
