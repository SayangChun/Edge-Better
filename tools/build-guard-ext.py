#!/usr/bin/env python
"""构建一个「注入 beforeunload guard」的扩展副本，供 bfcache 对照实验使用

用法:
  python tools/build-guard-ext.py        # 输出临时目录路径
"""
import json
import os
import shutil
import sys
import tempfile

SRC = r"E:\project\EdgeBetter"


def main() -> str:
    d = tempfile.mkdtemp(prefix="edge-better-guardext-")
    for name in os.listdir(SRC):
        if name in ("node_modules", ".git", "tools", "test") or name.endswith(".zip"):
            continue
        s, t = os.path.join(SRC, name), os.path.join(d, name)
        shutil.copytree(s, t) if os.path.isdir(s) else shutil.copy2(s, t)

    os.makedirs(os.path.join(d, "cs"), exist_ok=True)
    open(os.path.join(d, "cs", "guard.js"), "w", encoding="utf-8").write(
        "window.addEventListener('beforeunload', function (e) {"
        "  e.preventDefault(); e.returnValue = 'x'; return 'x';"
        "});"
    )
    mf = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    mf["content_scripts"] = [{
        "matches": ["http://*/*", "https://*/*"],
        "js": ["cs/guard.js"],
        "run_at": "document_start",
        "all_frames": False,
    }]
    json.dump(mf, open(os.path.join(d, "manifest.json"), "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)
    return d


if __name__ == "__main__":
    print(main())
