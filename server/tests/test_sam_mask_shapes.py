"""From a decoded mask to what the game needs: the outline (holes kept),
the area and the occupancy grid, on sam-3.1's recorded masks of a coin, the
mug, the cactus and the desk surface."""
import json
import re
import unittest
from pathlib import Path

from server.sam_mask import decode_data, mask_outline, mask_shape, occupancy_grid
from server.tests.test_sam_mask_desk import SILHOUETTES, in_box, iou

ANSWERS = json.loads((Path(__file__).parent / 'fixtures' / 'desk_1027.json').read_text(encoding='utf-8'))['answers']


def recorded(noun, index=0):
    """(raster, width, height, left, top) of a recorded match."""
    found = re.findall(r'box;x1=(\d+);y1=(\d+)[^|]*\|><\|mask;[^|]*data=([^|]*)\|>', ANSWERS[noun])
    x1, y1, data = found[index]
    raster, w, h = decode_data(data)
    return raster, w, h, int(x1), int(y1)


def signed_area(ring):
    return sum(ax * by - bx * ay for (ax, ay), (bx, by) in zip(ring[-1:] + ring[:-1], ring)) / 2


def fill(rings, left, top, w, h):
    """Even-odd fill of the rings at the pixel centres of a w x h window (as src/raster.js fills)."""
    out = bytearray(w * h)
    edges = [(ring[i - 1], ring[i]) for ring in rings for i in range(len(ring))]
    for r in range(h):
        py = top + r + 0.5
        xs = sorted(ax + (py - ay) * (bx - ax) / (by - ay)
                    for (ax, ay), (bx, by) in edges if (ay > py) != (by > py))
        for a, b in zip(xs[0::2], xs[1::2]):
            for c in range(w):
                if a <= left + c + 0.5 < b:
                    out[r * w + c] = 1
    return out


def ring_bounds(ring):
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


class Outline(unittest.TestCase):
    CASES = (('gold coin', 0, 'coin2'), ('coffee mug', 0, 'mug'), ('potted cactus', 0, 'cactus'), ('desk', 0, 'surface'))

    def test_unsimplified_rings_fill_back_to_the_mask_exactly(self):
        for noun, i, _ in self.CASES:
            raster, w, h, left, top = recorded(noun, i)
            rings = mask_outline(raster, w, h, left, top, tolerance=0)
            self.assertEqual(fill(rings, left, top, w, h), bytearray(raster), noun)

    def test_simplified_rings_stay_on_the_mask_and_the_object(self):
        for noun, i, name in self.CASES:
            raster, w, h, left, top = recorded(noun, i)
            shape = mask_shape(raster, w, h, left, top)
            filled = fill(shape['rings'], left, top, w, h)
            self.assertGreaterEqual(iou(filled, raster), 0.97, noun)
            self.assertGreaterEqual(iou(filled, in_box(SILHOUETTES[name]['vis'], left, top, w, h)), 0.93, noun)
            self.assertEqual(shape['area'], sum(raster))
            polygon = sum(signed_area(r) for r in shape['rings'])
            self.assertAlmostEqual(polygon / shape['area'], 1, delta=0.03, msg=noun)
            for ring in shape['rings']:                      # picture pixels, inside the box
                x0, y0, x1, y1 = ring_bounds(ring)
                self.assertTrue(left <= x0 and top <= y0 and x1 <= left + w and y1 <= top + h, noun)

    def test_a_coin_is_one_small_ring(self):
        raster, w, h, left, top = recorded('gold coin', 0)
        self.assertEqual((left, top, w, h), (725, 552, 34, 21))
        shape = mask_shape(raster, w, h, left, top)
        self.assertEqual(len(shape['rings']), 1)
        ring = shape['rings'][0]
        self.assertGreater(signed_area(ring), 0)             # an outline runs clockwise on screen
        self.assertLessEqual(len(ring), 20)
        self.assertEqual(shape['bounds'], [725, 552, 759, 573])
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        self.assertAlmostEqual(cx, 725 + 17, delta=1.5)
        self.assertAlmostEqual(cy, 552 + 10.5, delta=1.5)

    def test_the_mug_keeps_its_handle_hole(self):
        raster, w, h, left, top = recorded('coffee mug')
        rings = mask_shape(raster, w, h, left, top)['rings']
        outer = [r for r in rings if signed_area(r) > 0]
        holes = [r for r in rings if signed_area(r) < 0]
        self.assertEqual((len(outer), len(holes)), (1, 1))
        hx0, hy0, hx1, hy1 = ring_bounds(holes[0])
        self.assertGreater(hx0, left + w * 0.6)             # the handle is on the right
        self.assertTrue(top + h * 0.25 < hy0 < hy1 < top + h * 0.85)
        self.assertGreater(-signed_area(holes[0]), 300)
        own = in_box(SILHOUETTES['mug']['own'], left, top, w, h)
        middle = (int((hy0 + hy1) / 2) - top) * w + int((hx0 + hx1) / 2) - left
        self.assertEqual(own[middle], 0)                     # the painter's mug is open there too

    def test_the_cactus_is_one_ring_with_its_arms(self):
        raster, w, h, left, top = recorded('potted cactus')
        rings = mask_shape(raster, w, h, left, top)['rings']
        self.assertEqual(len(rings), 1)
        self.assertGreater(signed_area(rings[0]), 0)
        self.assertGreater(len(rings[0]), 20)                # arms and pot, not a blob
        self.assertLess(len(rings[0]), 160)

    def test_the_desk_is_one_outline_with_a_hole_under_each_thing_inside_it(self):
        raster, w, h, left, top = recorded('desk')
        rings = mask_shape(raster, w, h, left, top)['rings']
        outer = [r for r in rings if signed_area(r) > 0]
        holes = [r for r in rings if signed_area(r) < 0]
        self.assertEqual(len(outer), 1)
        self.assertGreaterEqual(len(holes), 4)
        boxes = [ring_bounds(r) for r in holes]
        for name in ('mug', 'notebook', 'coin2', 'coin3'):   # wholly on the desk: each sits in a hole
            x0, y0, sw, sh, _ = SILHOUETTES[name]['vis']
            cx, cy = x0 + sw / 2, y0 + sh / 2
            self.assertTrue(any(a <= cx <= c and b <= cy <= d for a, b, c, d in boxes), name)


class Grid(unittest.TestCase):
    def test_the_grid_is_the_mask_at_a_coarser_scale_on_the_picture_grid(self):
        raster, w, h, left, top = recorded('potted cactus')
        for cell in (4, 8, 16):
            g = occupancy_grid(raster, w, h, left, top, cell=cell)
            self.assertEqual((g['col0'], g['row0']), (left // cell, top // cell))
            self.assertEqual(g['cols'], (left + w - 1) // cell - left // cell + 1)
            self.assertEqual(g['rows'], (top + h - 1) // cell - top // cell + 1)
            for j, line in enumerate(g['cells']):           # brute force, square by square
                for i, v in enumerate(line):
                    n = sum(raster[(py - top) * w + px - left]
                            for py in range((g['row0'] + j) * cell, (g['row0'] + j + 1) * cell)
                            for px in range((g['col0'] + i) * cell, (g['col0'] + i + 1) * cell)
                            if top <= py < top + h and left <= px < left + w)
                    self.assertEqual(v, int(n * 2 >= cell * cell and n > 0))

    def test_a_coin_occupies_its_middle_squares(self):
        raster, w, h, left, top = recorded('gold coin', 0)
        g = occupancy_grid(raster, w, h, left, top, cell=8)
        self.assertEqual((g['col0'], g['row0'], g['cols'], g['rows']), (90, 69, 5, 3))
        self.assertEqual(g['cells'][1][2:4], [1, 1])
        full = sum(map(sum, occupancy_grid(raster, w, h, left, top, cell=8, threshold=1)['cells']))
        self.assertTrue(0 < full < sum(map(sum, g['cells'])))    # wholly covered squares are fewer
        self.assertEqual(sum(map(sum, occupancy_grid(raster, w, h, left, top, cell=1)['cells'])), sum(raster))

    def test_the_desk_grid_is_open_under_the_mug_and_walkable_beside_it(self):
        raster, w, h, left, top = recorded('desk')
        g = mask_shape(raster, w, h, left, top, cell=16)['grid']
        self.assertEqual((g['cols'], g['rows']), (64, 24))

        def at(px, py):
            return g['cells'][py // 16 - g['row0']][px // 16 - g['col0']]
        self.assertEqual(at(615, 440), 0)                    # inside the mug
        self.assertEqual(at(520, 620), 1)                    # bare desk
        self.assertEqual(at(850, 420), 0)                    # inside the cactus


class Offsets(unittest.TestCase):
    def test_the_box_and_the_masks_x_and_y_shift_everything_alike(self):
        raster, w, h, _, _ = recorded('coffee mug')
        a = mask_shape(raster, w, h, 100, 200, x=0, y=0)
        b = mask_shape(raster, w, h, 90, 190, x=10, y=10)
        c = mask_shape(raster, w, h, 0, 0)
        self.assertEqual(a, b)
        self.assertEqual(a['bounds'], [c['bounds'][0] + 100, c['bounds'][1] + 200,
                                       c['bounds'][2] + 100, c['bounds'][3] + 200])
        self.assertEqual(a['rings'], [[[px + 100, py + 200] for px, py in r] for r in c['rings']])

    def test_a_single_pixel_and_an_empty_mask(self):
        one = mask_shape(b'\x01', 1, 1, 5, 7, tolerance=0)
        self.assertEqual(one['rings'], [[[5.0, 7.5], [5.5, 7.0], [6.0, 7.5], [5.5, 8.0]]])
        self.assertEqual((one['area'], one['bounds']), (1, [5, 7, 6, 8]))
        empty = mask_shape(bytes(6), 3, 2)
        self.assertEqual((empty['rings'], empty['area'], empty['bounds']), ([], 0, None))
        with self.assertRaises(ValueError):
            mask_shape(bytes(5), 3, 2)


if __name__ == '__main__':
    unittest.main()
