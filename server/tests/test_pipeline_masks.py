"""SAM 3.1's masks through the pipeline: each kept match's mask is decoded
once, within the photo's time; one that does not decode is said so on its
call, and the page traces inside that box instead."""
import json
import time
import unittest

from server import config, samtext
from server.config import settings_from
from server.imageinfo import check_photo
from server.limits import Limits
from server.pipeline import Pipeline, choose_matches, on_mask
from server.sam_mask import _signed_area, decode_data, encode_one_bit, mask_shape
from server.tests import images, recorded


def call_for(r, noun):
    return next(c for c in r['provenance']['calls'] if c.get('noun') == noun and not c.get('surface'))


class LateClock:
    """A clock that runs out once the SAM calls are answered."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class LateTransport(recorded.RecordedTransport):
    def __init__(self, clock):
        super().__init__()
        self.clock = clock

    def post(self, route, body, deadline, sleep=None, clock=None):
        out = super().post(route, body, deadline, sleep, clock)
        if route == '/responses':
            self.clock.now = 10 * config.PHOTO_TIMEOUT_S
        return out


class Decoding(unittest.TestCase):
    def test_every_kept_match_of_the_recorded_desk_is_decoded(self):
        r = recorded.run()
        self.assertEqual(r['status'], 'ok')
        sam = [o for o in r['objects'] if o['found_by'] == 'sam']
        self.assertEqual(len(sam), 9)
        for o in sam:
            self.assertEqual(o['mask']['encoding'], 'one_bit')
            self.assertTrue(o['mask']['decoded'], o['name'])
        for c in r['provenance']['calls']:
            self.assertNotIn('diagnostics', c, c.get('noun'))

    def test_a_mask_that_does_not_decode_falls_back_and_says_so(self):
        r = recorded.run({'coffee mug': recorded.spoilt(recorded.FIXTURE['answers']['coffee mug'])})
        self.assertEqual(r['status'], 'ok')
        mug = next(o for o in r['objects'] if o['name'] == 'coffee mug')
        self.assertEqual(mug['found_by'], 'sam', 'the match is still SAM 3.1\'s box')
        self.assertFalse(mug['mask']['decoded'])
        self.assertEqual(call_for(r, 'coffee mug')['diagnostics'], ['mask_undecodable'])
        others = [o for o in r['objects'] if o['found_by'] == 'sam' and o['name'] != 'coffee mug']
        self.assertTrue(all(o['mask']['decoded'] for o in others))

    def test_no_mask_is_decoded_after_the_photo_runs_out_of_time(self):
        clock = LateClock()
        pipe = Pipeline(settings_from({}, 'http://127.0.0.1:9/v1', 'desk'), Limits(), transport=LateTransport(clock),
                        clock=clock, sleep=lambda s: None)
        r = pipe.run(check_photo(images.jpeg(recorded.W, recorded.H), config.MAX_SIDE))
        self.assertEqual(r['status'], 'ok', 'what was found is kept')
        self.assertTrue(all(not o['mask']['decoded'] for o in r['objects']))
        self.assertIn('mask_time', call_for(r, 'gold coin')['diagnostics'])

    def test_the_largest_recorded_mask_keeps_to_the_time(self):
        # the desk surface, 1024 x 368: decoded (with its canonical round
        # trip) and turned into shapes well inside the photo's 60 s
        data = recorded.FIXTURE['answers']['desk'].split('data=')[1].split('|>')[0]
        best = None
        for _ in range(2):
            t = time.perf_counter()
            raster, w, h = decode_data(data)
            mask_shape(raster, w, h, 0, 319)
            took = time.perf_counter() - t
            best = took if best is None else min(best, took)
        self.assertEqual((w, h), (1024, 368))
        print(f'\n  the desk surface mask (1024 x 368): decoded and outlined in {best:.3f} s')
        self.assertLess(best, 2.0)
        # every mask of a whole read, decoded through the pipeline
        t = time.perf_counter()
        recorded.run()
        self.assertLess(time.perf_counter() - t, 6.0)

    def test_each_mask_is_decoded_once_per_photo(self):
        seen = []
        real = samtext.sam_mask.decode_mask

        def counting(encoding, payload, width, height):
            seen.append(payload)
            return real(encoding, payload, width, height)
        samtext.sam_mask.decode_mask = counting
        try:
            recorded.run()
        finally:
            samtext.sam_mask.decode_mask = real
        self.assertEqual(len(seen), len(set(seen)), 'no payload decoded twice')
        self.assertGreater(len(seen), 0)



def ring_raster(w, h):
    """A frame: the box's edge two pixels deep, open in the middle."""
    return bytes(int(x < 2 or y < 2 or x >= w - 2 or y >= h - 2) for y in range(h) for x in range(w))


class Shapes(unittest.TestCase):
    def test_the_reply_carries_each_mask_outline_with_its_holes(self):
        r = recorded.run()
        mug = next(o for o in r['objects'] if o['name'] == 'coffee mug')
        self.assertEqual(mug['outline_source'], 'sam_mask')
        m = mug['mask']
        self.assertEqual(len(m['rings']), 2, 'the mug, and the hole in its handle')
        self.assertEqual(sorted(_signed_area(ring) > 0 for ring in m['rings']), [False, True])
        self.assertEqual(m['bounds'], [560, 383, 670, 482])
        self.assertGreater(m['area'], 0.5 * 110 * 99)
        self.assertNotIn('payload', m, 'the payload stays on the server')
        self.assertNotIn('raster', m)
        coins = [o for o in r['objects'] if o['name'] == 'gold coin']
        for c in coins:
            x0, y0, x1, y1 = c['box']
            self.assertTrue(all(x0 <= x <= x1 and y0 <= y <= y1 for ring in c['mask']['rings'] for x, y in ring))

    def test_points_pick_the_match_whose_mask_they_fall_on(self):
        # two matches for one name, the point inside both boxes: in the
        # middle of a frame (the more confident match, not on its pixels)
        # and on a small solid square (the other)
        frame = encode_one_bit(ring_raster(40, 40), 40, 40)
        square = encode_one_bit(bytes([1]) * 121, 11, 11)
        text = samtext.compose([{'box': [0, 0, 39, 39], 'confidence': 0.95, 'payload': frame},
                                {'box': [15, 15, 25, 25], 'confidence': 0.9, 'payload': square}], 100, 100)
        records = samtext.parse(text, 100, 100).records
        seeds = [[20.0, 20.0]]
        by_box, _ = choose_matches(records, seeds, 'exit', 100, 100)
        self.assertEqual(by_box[0][0]['box'], [0, 0, 40, 40], 'by boxes alone, the more confident')
        holds = lambda r, p: on_mask(samtext.mask_shape(r, (100, 100)), p)
        by_mask, _ = choose_matches(records, seeds, 'exit', 100, 100, holds=holds)
        self.assertEqual(by_mask[0][0]['box'], [15, 15, 26, 26], 'the one the point is on')
        self.assertTrue(by_mask[0][1], 'kept as seeded')

    def test_on_mask(self):
        text = samtext.compose([{'box': [10, 10, 49, 49], 'confidence': 0.9, 'payload': encode_one_bit(ring_raster(40, 40), 40, 40)}], 100, 100)
        shape = samtext.mask_shape(samtext.parse(text, 100, 100).records[0], (100, 100))
        self.assertTrue(on_mask(shape, (10.2, 10.9)))
        self.assertFalse(on_mask(shape, (30, 30)))
        self.assertFalse(on_mask(shape, (5, 5)))
        self.assertFalse(on_mask(None, (10, 10)))


if __name__ == '__main__':
    unittest.main()
