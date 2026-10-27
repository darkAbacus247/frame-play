"""Draw the app icons (icons/icon-192.png, icons/icon-512.png) from the
favicon's artwork (favicon.svg), with Python's standard library only.

The favicon is four simple shapes on a 32 x 32 grid; each is drawn here as
the SVG does (a rounded square, a framed picture, a gold line with round
joins and a small sun), sampled 4 x 4 times a pixel for smooth edges.
Run: python -B tools/make_icons.py
MIT license, as the rest of the repository.
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIZES = (192, 512)
BG = (0x11, 0x13, 0x16)
TEAL = (0x36, 0xd3, 0xc0)
GOLD = (0xf5, 0xc5, 0x42)
CREAM = (0xec, 0xe8, 0xdf)
LINE = [(9, 20), (14, 14), (18, 18), (21, 15), (24, 20)]


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def in_round_rect(x, y, w=32, h=32, r=6):
    if not (0 <= x <= w and 0 <= y <= h):
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return math.hypot(x - cx, y - cy) <= r


def colour_at(x, y):
    """The artwork's colour at a point on its 32 x 32 grid, or None."""
    if not in_round_rect(x, y):
        return None
    c = BG
    # the frame: a 20 x 14 rectangle at (6, 9), stroked 2 wide on its edge
    if 5 <= x <= 27 and 8 <= y <= 24 and not (7 < x < 25 and 10 < y < 22):
        c = TEAL
    # the gold line, stroked 2 wide (round joins)
    if min(seg_dist(x, y, *LINE[i], *LINE[i + 1]) for i in range(len(LINE) - 1)) <= 1:
        # butt ends: nothing past the first and last points along the line
        if 9 <= x <= 24:
            c = GOLD
    if math.hypot(x - 12, y - 13) <= 1.6:
        c = CREAM
    return c


def render(size, ss=4):
    rows = []
    k = 32 / size
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            r = g = b = a = 0
            for sj in range(ss):
                for si in range(ss):
                    c = colour_at((i + (si + 0.5) / ss) * k, (j + (sj + 0.5) / ss) * k)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = ss * ss
            row += bytes([r // a, g // a, b // a, 255 * a // n] if a else [0, 0, 0, 0])
        rows.append(bytes(row))
    return b''.join(rows)


def png(size, raw):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    head = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', head) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def main():
    out = ROOT / 'icons'
    out.mkdir(exist_ok=True)
    for s in SIZES:
        (out / f'icon-{s}.png').write_bytes(png(s, render(s)))


if __name__ == '__main__':
    main()
