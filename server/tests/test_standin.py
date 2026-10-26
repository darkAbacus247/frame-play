import json
import threading
import unittest

from server import config
from server.config import ConfigError, settings_from
from server.limits import Limits
from server.pipeline import Pipeline
from server.server import main as server_main
from server.standin import DRILLS, StandIn, load_room, make_server, pixel_box
from server.tests import images
from server.tests.test_server import Running


class Shapes(unittest.TestCase):
    def test_pixel_boxes_follow_pixel_centres(self):
        self.assertEqual(pixel_box({'rect': [10, 20, 30, 40]}, 1024, 768), [10, 20, 39, 59])
        self.assertEqual(pixel_box({'ellipse': [100, 100, 10.2, 5]}, 1024, 768), [90, 95, 109, 104])
        self.assertEqual(pixel_box({'rect': [-5, -5, 30, 30]}, 1024, 768)[:2], [0, 0], 'clamped to the picture')
        arc = {'path': [['M', 0, 50], ['A', 50, 50, 50, 50, 180, 360]]}
        self.assertEqual(pixel_box(arc, 1024, 768), [0, 0, 99, 49])

    def test_both_rooms_load(self):
        for rid in ('desk', 'living'):
            room = load_room(rid)
            s = StandIn(rid)
            read = s.read()
            self.assertFalse(read['people_present'])
            self.assertEqual(read['surface']['name'], room['surface']['name'])
            names = [o['name'] for o in read['objects']]
            self.assertEqual(len(names), len(set(names)), 'one entry per noun')
        with self.assertRaises(ValueError):
            load_room('../server/config')


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
            'zero_matches': ('error', 'nothing_found'),
            'people': ('refused', 'people_present'),
        }
        for name, (status, code) in expect.items():
            self.drill(name)
            r = self.post()
            self.assertEqual((r['status'], r['error']['code']), (status, code), name)
        self.drill('429')
        r = self.post()
        self.assertEqual(r['status'], 'ok', 'a 429 with a short Retry-After is retried once')
        self.assertEqual(r['provenance']['calls'][0]['attempt'], 2)
        self.drill('malformed_record')
        r = self.post()
        self.assertEqual(r['status'], 'ok')
        diags = [d for c in r['provenance']['calls'] for d in c.get('diagnostics', [])]
        self.assertIn('malformed_record', diags)
        self.assertEqual(set(expect) | {'429', 'malformed_record'}, set(DRILLS))

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
