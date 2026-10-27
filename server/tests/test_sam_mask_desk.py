"""Proof against reality: every mask sam-3.1 sent for the desk sample
picture (the recorded answers, fixtures/desk_1027.json) is decoded and laid
over the painter's exact silhouette of the thing it found
(fixtures/desk_silhouettes.json, made from src/painter.js and
rooms/desk.json by tests/desk_silhouettes.js).

The comparison is inside SAM's box, with what the picture shows of the
painter's object (its visible part: what stands in front of it is not it).
An object counts as hidden when other things cover more than 5% of it
inside the box; every other object must reach IoU 0.9.
"""
import json
import re
import sys
import unittest
from pathlib import Path

from server.sam_mask import decode_data

FIXTURES = Path(__file__).parent / 'fixtures'
ANSWERS = json.loads((FIXTURES / 'desk_1027.json').read_text(encoding='utf-8'))['answers']
TRUTH = json.loads((FIXTURES / 'desk_silhouettes.json').read_text(encoding='utf-8'))

# What each recorded match is in the painted room. SAM answered "blue
# notebook" twice: the notebook, and the teal book on top of the book stack.
EXPECTED = {
    ('coffee mug', 0): 'mug',
    ('desk lamp', 0): 'lamp',
    ('cardboard box', 0): 'box',
    ('blue notebook', 0): 'notebook',
    ('blue notebook', 1): 'books',
    ('desk', 0): 'surface',
    ('gold coin', 0): 'coin2',
    ('gold coin', 1): 'coin3',
    ('gold coin', 2): 'coin1',
    ('potted cactus', 0): 'cactus',
    ('book stack', 0): 'books',
}
HIDDEN_ABOVE = 0.05
IOU_BAR = 0.9

_RECORD = re.compile(r'(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>')


def fields(body):
    return dict(part.split('=', 1) for part in body.split(';') if '=' in part)


def records(text):
    """(id, box x1 y1 x2 y2 inclusive, mask x, mask y, data) of each record."""
    out = []
    for rid, box, mask in _RECORD.findall(text):
        b, m = fields(box), fields(mask)
        out.append((int(rid), tuple(int(b[k]) for k in ('x1', 'y1', 'x2', 'y2')),
                    int(m['x']), int(m['y']), m['data']))
    return out


def unrun(crop):
    flat = bytearray()
    value = 0
    for run in crop['runs']:
        flat += bytes([value]) * run
        value ^= 1
    return crop['x0'], crop['y0'], crop['w'], crop['h'], bytes(flat)


SILHOUETTES = {o['id']: {k: unrun(o[k]) for k in ('own', 'vis')} for o in TRUTH['objects']}
SILHOUETTES['surface'] = {k: unrun(TRUTH['surface'][k]) for k in ('own', 'vis')}


def in_box(sil, left, top, w, h):
    """The silhouette's pixels inside a w x h window at (left, top), row major."""
    x0, y0, sw, sh, flat = sil
    out = bytearray(w * h)
    for y in range(max(top, y0), min(top + h, y0 + sh)):
        for x in range(max(left, x0), min(left + w, x0 + sw)):
            out[(y - top) * w + x - left] = flat[(y - y0) * sw + x - x0]
    return out


def iou(a, b):
    inter = sum(1 for p, q in zip(a, b) if p and q)
    union = sum(1 for p, q in zip(a, b) if p or q)
    return inter / union if union else 1.0


def compare_all():
    rows = []
    for noun, text in ANSWERS.items():
        for index, (rid, (x1, y1, x2, y2), mx, my, data) in enumerate(records(text)):
            raster, w, h = decode_data(data)
            left, top = x1 + mx, y1 + my
            name = EXPECTED[(noun, index)]
            own = in_box(SILHOUETTES[name]['own'], left, top, w, h)
            vis = in_box(SILHOUETTES[name]['vis'], left, top, w, h)
            hidden = 1 - sum(vis) / max(1, sum(own))
            best = max(SILHOUETTES, key=lambda k: iou(raster, in_box(SILHOUETTES[k]['vis'], left, top, w, h)))
            rows.append({'match': f'{noun} #{index}', 'object': name, 'box': (x1, y1, x2, y2), 'size': (h, w),
                         'mask_px': sum(raster), 'hidden': hidden, 'iou': iou(raster, vis),
                         'iou_own': iou(raster, own), 'best': best})
    return rows


def table(rows):
    lines = ['', 'SAM 3.1 masks (decoded) vs the painter, inside SAM\'s box',
             f'{"match":<17} {"object":<9} {"rows x cols":>11} {"mask px":>8} {"hidden":>7} '
             f'{"IoU seen":>8} {"IoU whole":>9}  bar']
    for r in rows:
        bar = 'n/a (hidden)' if r['hidden'] > HIDDEN_ABOVE else ('ok' if r['iou'] >= IOU_BAR else 'FAIL')
        lines.append(f'{r["match"]:<17} {r["object"]:<9} {"%d x %d" % r["size"]:>11} {r["mask_px"]:>8} '
                     f'{r["hidden"]:>6.1%} {r["iou"]:>8.3f} {r["iou_own"]:>9.3f}  {bar}')
    return '\n'.join(lines) + '\n'


class RecordedDeskMasks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = compare_all()
        sys.stderr.write(table(cls.rows))

    def test_all_eleven_matches_decode(self):
        self.assertEqual([r['match'] for r in self.rows],
                         [f'{n} #{i}' for n, i in EXPECTED])
        for r in self.rows:
            self.assertGreater(r['mask_px'], 0, r['match'])

    def test_every_object_not_hidden_reaches_iou_09(self):
        checked = [r for r in self.rows if r['hidden'] <= HIDDEN_ABOVE]
        self.assertGreaterEqual(len(checked), 9)
        for r in checked:
            self.assertGreaterEqual(r['iou'], IOU_BAR, r['match'])

    def test_each_mask_lands_on_its_own_object(self):
        for r in self.rows:
            self.assertEqual(r['best'], r['object'], r['match'])

    def test_the_desk_mask_is_the_surface_without_the_things_on_it(self):
        desk = next(r for r in self.rows if r['object'] == 'surface')
        self.assertGreater(desk['hidden'], 0.15)          # the things on it cover a lot of it
        self.assertGreaterEqual(desk['iou'], IOU_BAR)     # and SAM leaves them out
        self.assertLess(desk['iou_own'], desk['iou'] - 0.1)


if __name__ == '__main__':
    unittest.main()
