import base64
import json
import re
import threading
import unittest
from pathlib import Path

from server import config, samtext
from server.config import ConfigError, settings_from
from server.limits import Limits
from server.pipeline import Pipeline, sam_text
from server.server import main as server_main
from server.sam_mask import decode_data
from server.standin import DRILLS, StandIn, load_room, make_server, pixel_box
from server.tests import images, standin_replay
from server.tests.test_server import Running


class Shapes(unittest.TestCase):
    def test_pixel_boxes_follow_pixel_centres(self):
        self.assertEqual(pixel_box({'rect': [10, 20, 30, 40]}, 1024, 768), [10, 20, 39, 59])
        self.assertEqual(pixel_box({'ellipse': [100, 100, 10.2, 5]}, 1024, 768), [90, 95, 109, 104])
        self.assertEqual(pixel_box({'rect': [-5, -5, 30, 30]}, 1024, 768)[:2], [0, 0], 'clamped to the picture')
        arc = {'path': [['M', 0, 50], ['A', 50, 50, 50, 50, 180, 360]]}
        self.assertEqual(pixel_box(arc, 1024, 768), [0, 0, 99, 49])

    def test_both_rooms_load(self):
        for rid in ('desk', 'living', 'apartment'):
            room = load_room(rid)
            s = StandIn(rid)
            read = s.read()
            self.assertFalse(read['people_present'])
            self.assertEqual(read['surface']['name'], room['surface']['name'])
            names = [o['name'] for o in read['objects']]
            self.assertEqual(len(names), len(set(names)), 'one entry per noun')
        with self.assertRaises(ValueError):
            load_room('../server/config')


FIXTURE = json.loads((Path(__file__).parent / 'fixtures' / 'desk_1027.json').read_text(encoding='utf-8'))
_REC = (r'\d+<\|box;x1=\d+;y1=\d+;x2=\d+;y2=\d+;w=\d+;h=\d+;c=0\.\d+\|>'
        r'<\|mask;x=0;y=0;c=0\.\d+;data=\d+,\d+,[' + re.escape(samtext.ALPHABET) + r']+\|>')
# the shape of every answer sam-3.1 gave on the first live calls
SHAPE = re.compile(rf'<0f>(?:{_REC}(?:,{_REC})*)?\n')
# the stand-in's desk nouns, and the nouns Muse Spark used for the same things
SAME_THING = {'mug': 'coffee mug', 'desk lamp': 'desk lamp', 'cardboard box': 'cardboard box', 'notebook': 'blue notebook',
              'desk': 'desk', 'coin': 'gold coin', 'cactus': 'potted cactus', 'stack of books': 'book stack'}


class TheRealGrammar(unittest.TestCase):
    """The stand-in rehearses what sam-3.1 really answers."""

    def test_the_recorded_answers_have_this_shape(self):
        for noun, text in FIXTURE['answers'].items():
            self.assertRegex(text, SHAPE, noun)
            self.assertIsNotNone(SHAPE.fullmatch(text), noun)

    def test_every_stand_in_answer_has_the_same_shape(self):
        for rid in ('desk', 'living', 'apartment'):
            s = StandIn(rid)
            room = load_room(rid)
            nouns = {o['name'] for o in room['objects']} | {room['surface']['name']}
            for noun in nouns:
                for W, H in ((room['width'], room['height']), (512, 384)):
                    text = s.find(noun, W, H)
                    self.assertIsNotNone(SHAPE.fullmatch(text), f'{rid} {noun}: {text[:120]}')
                    ids = [int(x) for x in re.findall(r'(\d+)<\|box', text)]
                    self.assertEqual(ids, list(range(len(ids))), 'ids count from 0')
                    p = samtext.parse(text, W, H)
                    self.assertEqual((p.errors, p.warnings), ([], []), noun)
        self.assertEqual(StandIn('desk').find('unicorn', 1024, 768), '<0f>\n', 'no match is the frame alone')

    def test_the_desk_boxes_are_the_ones_sam_found(self):
        s = StandIn('desk')
        for ours, theirs in SAME_THING.items():
            mine = [r['box'] for r in samtext.parse(s.find(ours, 1024, 768), 1024, 768).records]
            real = [r['box'] for r in samtext.parse(FIXTURE['answers'][theirs], 1024, 768).records]
            for b in mine:
                near = min(max(abs(u - v) for u, v in zip(b, r)) for r in real)
                # within 2 px for every object; the desk's own front edge, 3
                self.assertLessEqual(near, 3 if ours == 'desk' else 2, f'{ours}: {b} against {real}')

    def test_the_answer_envelope_is_the_real_one(self):
        status, _, obj = self.post_responses('mug')
        self.assertEqual(status, 200)
        self.assertNotIn('output_text', obj, 'sam-3.1 gives its text only inside output')
        self.assertEqual(obj['status'], 'completed')
        self.assertEqual(obj['metadata'], {'mask_encoding': 'one_bit', 'include_confidence': 'true'})
        part = obj['output'][0]['content'][0]
        self.assertEqual(part['type'], 'output_text')
        self.assertEqual(sam_text(obj), part['text'])

    def test_every_mask_is_real_and_is_the_painter_s_silhouette(self):
        # P5: one_bit payloads that decode (canonically), and decode to the
        # very pixels the painter shows of the thing, for every sample room;
        # a smaller copy's masks decode too, and still cover the thing
        for rid in ('desk', 'living', 'apartment'):
            s = StandIn(rid)
            room = load_room(rid)
            for o in room['objects']:
                text = s.find(o['name'], room['width'], room['height'])
                records = samtext.parse(text, room['width'], room['height']).records
                sil = s.silhouettes[o['id']]
                x0, y0, w, h, flat = sil
                best = 0.0
                for r in records:
                    raster, mw, mh = decode_data(text.split('data=')[1 + r['id']].split('|>')[0])
                    left, top = r['box'][0], r['box'][1]
                    inter = union = 0
                    for yy in range(min(top, y0), max(top + mh, y0 + h)):
                        for xx in range(min(left, x0), max(left + mw, x0 + w)):
                            a = 0 <= xx - left < mw and 0 <= yy - top < mh and raster[(yy - top) * mw + xx - left]
                            b = 0 <= xx - x0 < w and 0 <= yy - y0 < h and flat[(yy - y0) * w + xx - x0]
                            inter += bool(a and b)
                            union += bool(a or b)
                    best = max(best, inter / union)
                self.assertEqual(best, 1.0, f'{rid} {o["id"]}: the mask is the silhouette, pixel for pixel')
            for noun in {o['name'] for o in room['objects']} | {room['surface']['name']}:
                for rec in samtext.parse(s.find(noun, 512, 384), 512, 384).records:
                    shape = samtext.mask_shape(rec, (512, 384))
                    self.assertIsNotNone(shape, f'{rid} {noun} at 512 x 384')
                    self.assertGreater(shape['area'], 0)

    def test_the_drills_speak_the_grammar(self):
        s = StandIn('desk', drill='zero_matches')
        self.assertEqual(s.find('mug', 1024, 768), '<0f>\n')
        s = StandIn('desk', drill='malformed_record')
        p = samtext.parse(s.find('mug', 1024, 768), 1024, 768)
        self.assertEqual((len(p.records), p.errors), (1, ['malformed_record']))

    def test_the_apartment_floor_is_one_match_a_room(self):
        # W1d: a floor plan's floor, as SAM answers "floor": one match a
        # room, never the doorways alone; the read is seen from above, with
        # a point on the open floor of every room and a count for each kind
        s = StandIn('apartment')
        p = samtext.parse(s.find('floor', 1024, 768), 1024, 768)
        self.assertEqual((p.errors, p.warnings), ([], []))
        # each doorway is in the mask (and so the box) of the first room it
        # opens from: the living room holds two, the kitchen one
        self.assertEqual(sorted(r['box'] for r in p.records),
                         [[54, 54, 534, 434], [54, 434, 520, 714], [534, 54, 970, 394], [534, 394, 970, 714]])
        for r in p.records:
            self.assertIsNotNone(samtext.mask_shape(r, (1024, 768)), 'a real mask')
        read = s.read()
        self.assertEqual(read['view'], 'top_down')
        self.assertEqual(len(read['floor_seeds']), 4)
        counts = {o['name']: o['count'] for o in read['objects']}
        self.assertEqual((counts['coin'], counts['chair'], counts['sofa']), (3, 2, 1))
        self.assertEqual(len(read['objects']), 10, 'ten kinds: more than the old ceiling of 9 calls could look for')
        self.assertEqual(StandIn('desk').read()['view'], 'eye_level')

    def test_the_apartment_golden_reply(self):
        # the pipeline's reply to the stand-in's apartment, field for field
        # (tests/apartment.test.js builds the level from the same file)
        golden = json.loads((Path(__file__).parent / 'fixtures' / 'apartment_rehearsal.json').read_text(encoding='utf-8'))
        self.assertEqual(standin_replay.golden(standin_replay.run('apartment')), golden['reply'])

    def post_responses(self, noun):
        body = {'model': 'sam-3.1', 'stream': False, 'store': False,
                'metadata': {'mask_encoding': 'one_bit', 'include_confidence': 'true'},
                'input': [{'role': 'user', 'content': [
                    {'type': 'input_text', 'text': noun},
                    {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(images.jpeg(1024, 768)).decode()}]}]}
        return StandIn('desk').answer('/v1/responses', {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}, body)


class Rehearsal(unittest.TestCase):
    """The rehearsal door end to end: the page's server in rehearsal mode,
    the stand-in on its own loopback port, the photo over HTTP."""

    def setUp(self):
        self.standin = StandIn('desk')
        self.ssrv = make_server(self.standin, '127.0.0.1', 0)
        threading.Thread(target=self.ssrv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{self.ssrv.server_address[1]}/v1'
        self.settings = settings_from({}, base, 'desk')
        self.limits = Limits()
        self.pipe = Pipeline(self.settings, self.limits, sleep=lambda s: None)
        self.run_ = Running(self.settings, pipeline=self.pipe, limits=self.limits)
        self.pipe.log = self.run_.srv.log

    def tearDown(self):
        self.run_.stop()
        self.ssrv.shutdown()
        self.ssrv.server_close()

    def post(self, w=1024, h=768):
        status, _, body = self.run_.request('POST', '/api/room', images.jpeg(w, h), {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg'})
        self.assertEqual(status, 200)
        return json.loads(body)

    def drill(self, name):
        self.standin.drill = name
        self.standin.drill_used = False

    def test_the_desk_through_the_live_path(self):
        r = self.post()
        self.assertEqual(r['status'], 'ok', r.get('error'))
        self.assertEqual(r['provenance']['mode'], 'rehearsal')
        self.assertEqual(r['provenance']['label'], 'REHEARSAL · local stand-in, not Meta')
        self.assertEqual(r['provenance']['rehearsal']['room'], 'desk')
        self.assertEqual(r['provenance']['models'], [])
        names = sorted((o['name'], o['instance']) for o in r['objects'])
        self.assertIn(('coin', 3), names, 'three coins become three collectibles')
        roles = {o['name']: o['role'] for o in r['objects']}
        self.assertEqual(roles['cactus'], 'avoid')
        self.assertNotIn('picture frame', roles, 'scenery is never sent to SAM')
        self.assertIn('picture frame', [s['name'] for s in r['scene']['scenery']])
        self.assertEqual(r['surface']['name'], 'desk')
        room = load_room('desk')
        mug = next(o for o in room['objects'] if o['id'] == 'mug')
        b = pixel_box(mug['shape'], 1024, 768)
        got = next(o for o in r['objects'] if o['name'] == 'mug')
        self.assertEqual(got['box'], [b[0], b[1], b[2] + 1, b[3] + 1])
        self.assertTrue(all(o['seeds'] for o in r['objects'] if o['name'] != 'coin' or o['instance'] <= 3))
        self.assertEqual(r['warnings'], [])
        self.assertTrue(all(c['model'].startswith('REHEARSAL stand-in for') for c in r['provenance']['calls']))

    def test_drills(self):
        expect = {
            '401': ('error', 'invalid_api_key'),
            '404': ('error', 'model_not_found'),
            '503': ('error', 'unavailable'),
            'content_filter': ('refused', 'content_filter'),
            'people': ('refused', 'people_present'),
        }
        for name, (status, code) in expect.items():
            self.drill(name)
            r = self.post()
            self.assertEqual((r['status'], r['error']['code']), (status, code), name)
        # no match at all: every thing is placed by Muse Spark's points instead
        self.drill('zero_matches')
        r = self.post()
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(r['provenance']['found']['sam'], 0)
        self.assertEqual(r['provenance']['found']['points'], len(r['objects']))
        self.assertTrue(all(o['found_by'] == 'points' for o in r['objects']))
        expect['zero_matches'] = None
        self.drill('429')
        r = self.post()
        self.assertEqual(r['status'], 'ok', 'a 429 with a short Retry-After is retried once')
        self.assertEqual(r['provenance']['calls'][0]['attempt'], 2)
        self.drill('malformed_record')
        r = self.post()
        self.assertEqual(r['status'], 'ok')
        diags = [d for c in r['provenance']['calls'] for d in c.get('diagnostics', [])]
        self.assertIn('malformed_record', diags)
        # SAM busy on every call: the honest busy words and retry_same,
        # never "found none"
        self.drill('sam_busy')
        r = self.post()
        self.assertEqual((r['status'], r['error']['code']), ('error', 'sam_busy'), r.get('error'))
        self.assertTrue(r['error']['retry_same'])
        self.assertNotIn('found none', r['error']['message'])
        # the riddle drills are walked in test_riddles.StandInRiddles
        riddle_drills = {d for d in DRILLS if d.startswith('riddle_')}
        self.assertEqual(riddle_drills, {'riddle_bad_id', 'riddle_point_outside', 'riddle_leak', 'riddle_malformed', 'riddle_none', 'riddle_filter'})
        self.assertEqual(set(expect) | {'429', 'malformed_record', 'sam_busy'} | riddle_drills, set(DRILLS))

    def test_the_stand_in_wants_the_contract(self):
        status, _, obj = self.standin.answer('/v1/responses', {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL},
                                             {'model': 'sam-3.1', 'input': [], 'stream': True})
        self.assertEqual(status, 400)
        status, _, _ = self.standin.answer('/v1/chat/completions', {'Authorization': 'Bearer something-else'}, {})
        self.assertEqual(status, 401)

    def test_a_smaller_copy_gets_scaled_boxes(self):
        r = self.post(512, 384)
        self.assertEqual(r['status'], 'ok')
        self.assertTrue(all(o['box'][2] <= 512 and o['box'][3] <= 384 for o in r['objects']))


class Door(unittest.TestCase):
    def test_the_rehearsal_door_refuses_live_variables_and_public(self):
        with self.assertRaises(ConfigError):
            settings_from({'MODEL_API_KEY': 'x'}, 'http://127.0.0.1:8192/v1')
        self.assertEqual(server_main(['--rehearse', 'http://127.0.0.1:8192/v1', '--public']), 2)
        self.assertEqual(server_main(['--rehearse', 'http://example.com:8192/v1']), 2)


if __name__ == '__main__':
    unittest.main()
