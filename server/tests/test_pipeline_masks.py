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
from server.pipeline import Pipeline
from server.sam_mask import decode_data, mask_shape
from server.tests import images, recorded


def call_for(r, noun):
    return next(c for c in r['provenance']['calls'] if c.get('noun') == noun and not c.get('surface'))


def broken(text):
    """The same answer with every mask payload spoilt (still in the alphabet)."""
    parts = text.split('data=')
    out = [parts[0]]
    for part in parts[1:]:
        rows, cols, rest = part.split(',', 2)
        payload, tail = rest.split('|>', 1)
        out.append(f'{rows},{cols},{payload[:-3]}abc|>{tail}')
    return 'data='.join(out)


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
        r = recorded.run({'coffee mug': broken(recorded.FIXTURE['answers']['coffee mug'])})
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


if __name__ == '__main__':
    unittest.main()
