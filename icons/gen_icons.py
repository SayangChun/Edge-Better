#!/usr/bin/env python3
"""生成 EdgeBetter 扩展图标（16/32/48/128）。

设计：蓝色渐变圆角方块 + 白色粗箭头（↗，寓意"在新标签页打开"）。
512px 超采样绘制后 LANCZOS 缩放到各尺寸，保证小尺寸清晰。

用法: python icons/gen_icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, '..', 'icons')
SIZES = [128, 48, 32, 16]
SS = 512  # 超采样画布

TOP = (96, 165, 250)    # #60a5fa
BOTTOM = (37, 99, 235)  # #2563eb
WHITE = (255, 255, 255, 255)


def base_square():
    """垂直渐变圆角方块"""
    img = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(SS):
        t = y / (SS - 1)
        c = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (SS, y)], fill=c)
    mask = Image.new('L', (SS, SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SS - 1, SS - 1], radius=int(SS * 0.22), fill=255)
    img.putalpha(mask)
    return img


def glyph_arrow():
    """白色粗箭头（指向右上）"""
    layer = Image.new('RGBA', (SS, SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # 箭杆
    d.line([(178, 334), (306, 206)], fill=WHITE, width=44)
    # 箭头：尖端朝右上，与箭杆方向一致
    d.polygon([(372, 140), (372, 268), (244, 396)], fill=WHITE)
    return layer


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icon = base_square()
    icon.alpha_composite(glyph_arrow())
    for size in SIZES:
        out = icon.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, f'icon{size}.png')
        out.save(path)
        print('written', path)


if __name__ == '__main__':
    main()
