#!/usr/bin/env python3
"""Fit a generated key-art image to the menu background's 1600x836 frame.

Generated art tends to arrive letterboxed and at the wrong aspect. Cropping to
1.91:1 outright would cut the squad and the barrel out of the side thirds, so
instead: strip the bars, scale to full width, then extend the short top/bottom
edges with a gradient sampled from the art's own edge rows. The menu lays a dark
gradient over those bands anyway, so the extension is invisible in game.

usage: python scripts/fit_menu_bg.py <input image> [output jpg]
"""
import sys

from PIL import Image

TARGET_W, TARGET_H = 1600, 836
BAR_LUMA = 14          # rows dimmer than this count as letterbox
BAR_MAX_FRAC = 0.25    # never strip more than this much off one end


def row_luma(px, w, y):
    step = max(1, w // 64)
    vals = []
    for x in range(0, w, step):
        r, g, b = px[x, y][:3]
        vals.append(0.299 * r + 0.587 * g + 0.114 * b)
    return sum(vals) / len(vals)


def strip_bars(im):
    w, h = im.size
    px = im.load()
    limit = int(h * BAR_MAX_FRAC)
    top = 0
    while top < limit and row_luma(px, w, top) < BAR_LUMA:
        top += 1
    bot = h - 1
    while (h - 1 - bot) < limit and row_luma(px, w, bot) < BAR_LUMA:
        bot -= 1
    if top == 0 and bot == h - 1:
        return im
    return im.crop((0, top, w, bot + 1))


def extend_edges(im):
    """Scale to target width, then grow to target height from the edge rows."""
    w, h = im.size
    new_h = max(1, round(h * TARGET_W / w))
    im = im.resize((TARGET_W, new_h), Image.LANCZOS)
    if new_h >= TARGET_H:                      # tall enough: centre-crop
        off = (new_h - TARGET_H) // 2
        return im.crop((0, off, TARGET_W, off + TARGET_H))

    pad = TARGET_H - new_h
    pad_t, pad_b = pad // 2, pad - pad // 2
    out = Image.new('RGB', (TARGET_W, TARGET_H))
    out.paste(im, (0, pad_t))

    # fade each sampled edge row toward black so the seam never shows
    for src_y, dst0, n, up in ((0, pad_t - 1, pad_t, True),
                               (new_h - 1, pad_t + new_h, pad_b, False)):
        if n <= 0:
            continue
        row = im.crop((0, src_y, TARGET_W, src_y + 1))
        for i in range(n):
            f = 1.0 - (i + 1) / float(n + 1)
            faded = Image.blend(Image.new('RGB', (TARGET_W, 1)), row, f ** 0.7)
            out.paste(faded, (0, dst0 - i if up else dst0 + i))
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    dst = sys.argv[2] if len(sys.argv) > 2 else 'assets/menu_bg.jpg'
    im = Image.open(sys.argv[1]).convert('RGB')
    before = im.size
    im = strip_bars(im)
    stripped = im.size
    im = extend_edges(im)
    im.save(dst, 'JPEG', quality=86, optimize=True, progressive=True)
    import os
    print('%s %s -> bars stripped %s -> %s  (%d bytes)'
          % (sys.argv[1], before, stripped, im.size, os.path.getsize(dst)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
