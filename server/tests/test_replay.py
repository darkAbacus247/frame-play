"""Our kitchen photo's recorded answers, replayed (server/replay.py): the
same Pipeline as a live read, its transport the answers Meta's models gave
on 2026-10-27; nothing is sent anywhere, and the reply says it is a replay.
POST /api/replay/kitchen serves it in every mode."""
import hashlib
import http.client
import json
import re
import unittest
from pathlib import Path
from unittest import mock

from server import config
from server.config import settings_from
from server.imageinfo import check_photo
from server.limits import Refusal
from server.meta_api import Transport
from server.replay import (ANSWERS, PHOTO, PHOTO_SHA256, RIDDLES, RIDDLES_LABEL, RIDDLES_WORDS, WORDS, ReplayLimits,
                           ReplayPipeline, ReplayTransport, kitchen_photo, load_answers, recorded_riddles)
from server.tests.test_server import Running

ROOT = Path(__file__).resolve().parent.parent.parent
NOUNS = ['counter', 'door', 'floor', 'kitchen island', 'refrigerator', 'stove']


def no_network(*a, **k):
    raise AssertionError('a replay never opens a connection')


class Photo(unittest.TestCase):
    def test_the_photo_and_its_answers(self):
        data = PHOTO.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), PHOTO_SHA256)
        photo = check_photo(data, config.MAX_SIDE)
        self.assertEqual((photo['width'], photo['height'], photo['type']), (1024, 399, 'image/jpeg'))
        self.assertEqual(photo['bytes'], data, 'no camera data to remove: the photo is sent as it is stored')
        self.assertEqual(photo['metadata_bytes_removed'], 0)
        read, sam = load_answers()
        self.assertEqual(sorted(sam), NOUNS)
        self.assertEqual(read['model'], config.SPARK_MODEL)
        files = sorted(ANSWERS.glob('*.json'))
        self.assertEqual(len(files), 7, 'one Muse Spark answer and six SAM 3.1 answers')
        for f in files:
            rec = json.loads(f.read_text(encoding='utf-8'))
            self.assertIn(rec['model'], config.MODELS)
            self.assertIn(rec['route'], ('/chat/completions', '/responses'))
            if rec['route'] == '/responses':
                self.assertIn('<|mask;', json.dumps(rec['answer']), 'real masks')

    def test_the_labels_agree_with_the_page(self):
        page = (ROOT / 'src' / 'level.js').read_text(encoding='utf-8')
        self.assertIn(f"replay: '{config.LABELS['replay']}'", page)
        own = (ROOT / 'src' / 'own.js').read_text(encoding='utf-8')
        self.assertIn(f"REPLAY_WORDS = '{WORDS}'", own)
        self.assertIn(f"sha256: '{PHOTO_SHA256}'", own)


class Replay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with mock.patch('http.client.HTTPConnection', no_network), mock.patch('http.client.HTTPSConnection', no_network):
            cls.pipe = ReplayPipeline()
            cls.said = []
            cls.reply = cls.pipe.run(kitchen_photo(), progress=lambda stage, words: cls.said.append(words))

    def test_the_same_pipeline_with_the_recorded_answers(self):
        self.assertIsInstance(self.pipe.transport, ReplayTransport)
        self.assertNotIsInstance(self.pipe.transport, Transport)
        self.assertIsInstance(self.pipe.limits, ReplayLimits)
        self.assertIsNone(self.pipe.settings.key)
        self.assertIsNone(self.pipe.settings.credential())
        self.assertEqual(self.pipe.transport.asked[0], ('read', None))
        self.assertEqual(sorted(n for _, n in self.pipe.transport.asked[1:]), NOUNS, 'every recorded answer asked for, once')

    def test_the_reply_says_it_is_a_replay(self):
        r, p = self.reply, self.reply['provenance']
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(p['mode'], 'replay')
        self.assertEqual(p['label'], config.LABELS['replay'])
        self.assertEqual(p['models'], [], 'no model is called now')
        self.assertEqual(p['replay']['recorded'], '2026-10-27')
        self.assertEqual(p['replay']['models'], list(config.MODELS))
        self.assertEqual(p['replay']['words'], WORDS)
        self.assertEqual(p['replay']['photo_sha256'], PHOTO_SHA256)
        self.assertEqual(p['image_sha256'], PHOTO_SHA256)
        self.assertTrue(all(c['replayed'] for c in p['calls']))
        self.assertEqual(r['usage']['calls'], 0)
        self.assertEqual(r['usage']['estimated_usd'], 0.0)
        self.assertGreater(p['replay']['recorded_usage']['tokens_out'], 0, 'what the read cost then is kept apart')
        self.assertEqual(self.said, ['Replaying Muse Spark’s recorded read', 'Replaying SAM 3.1’s recorded answers'])

    def test_as_the_live_read_went(self):
        r = self.reply
        self.assertEqual(r['received']['width'], 1024)
        self.assertEqual(r['received']['height'], 399)
        self.assertEqual(r['scene']['title'], 'Golden Kitchen Quest')
        self.assertEqual(len(r['objects']) + len(r['scene']['scenery']), 8, 'Muse Spark named 8 things')
        self.assertEqual(sorted(o['name'] for o in r['objects']), ['counter', 'door', 'kitchen island', 'refrigerator', 'stove'])
        self.assertTrue(all(o['mask']['decoded'] for o in r['objects']), "SAM 3.1's masks give 5 exact outlines")
        self.assertEqual(r['surface']['name'], 'floor')
        self.assertEqual(r['floor']['mask']['matches'], 1, "and SAM 3.1's floor mask")
        self.assertGreater(r['floor']['mask']['area'], 50000)
        self.assertEqual(r['provenance']['found']['masks'], 5)

    def test_a_noun_not_recorded_is_not_invented(self):
        t = ReplayTransport()
        body = {'input': [{'content': [{'type': 'input_text', 'text': 'teapot'}]}]}
        with self.assertRaises(Exception) as e:
            t.post('/responses', body, 0)
        self.assertEqual(e.exception.code, 'not_recorded')

    def test_ask_the_room_replays_muse_spark_s_recorded_riddles_with_no_call(self):
        asked = len(self.pipe.transport.asked)
        line = self.pipe.riddles(kitchen_photo(), self.reply)
        self.assertEqual(len(self.pipe.transport.asked), asked, 'no call, not even a replayed one')
        self.assertEqual(line['schema'], 'frameplay.riddles/1')
        self.assertEqual(line['request_id'], self.reply['request_id'])
        self.assertEqual(line['status'], 'ok')
        p = line['provenance']
        self.assertEqual((p['mode'], p['models'], p['calls'], p['label']), ('replay', [], [], RIDDLES_LABEL))
        self.assertEqual(p['replay'], {'recorded': '2026-10-28', 'models': [config.SPARK_MODEL], 'words': RIDDLES_WORDS})
        self.assertEqual(line['recorded'], 'Oct 28, 2026')
        self.assertEqual(line['usage']['spark_calls'], 0)
        self.assertEqual(line['usage']['estimated_usd'], 0.0)
        rec = json.loads(RIDDLES.read_text(encoding='utf-8'))
        self.assertEqual(rec['photo_sha256'], PHOTO_SHA256)
        by_id = {o['id']: o['name'] for o in self.reply['objects']}
        self.assertEqual([[by_id[a] for a in r['answers']] for r in line['riddles']], [['refrigerator'], ['stove']])
        # Muse Spark's words, through the clean and sentence-case rules only
        self.assertEqual([r['text'] for r in line['riddles']], [rec['riddles'][0]['text'][0].upper() + rec['riddles'][0]['text'][1:] + '.',
                                                               rec['riddles'][1]['text'][0].upper() + rec['riddles'][1]['text'][1:] + '.'])
        # its points back where the 10-28 read put them, to the tenth of a pixel
        self.assertEqual([r['points'] for r in line['riddles']],
                         [[[x, y, rec['riddles'][i]['replay_answers'][a]] for x, y, a in rec['riddles'][i]['points']] for i in (0, 1)])
        self.assertEqual(line['warnings'], ['riddle 3 of 2026-10-28 is not replayed: none of its four points falls inside a thing the 2026-10-27 answers found'])

    def test_recorded_riddles_are_never_put_on_another_photo(self):
        with self.assertRaises(ValueError):
            recorded_riddles(self.reply['objects'], 1024, 400, [])
        with mock.patch('server.replay.PHOTO_SHA256', 'ab' * 32):
            line = self.pipe.riddles({'width': 1024, 'height': 399}, self.reply)
        self.assertEqual(line['status'], 'error', 'the room stays; its riddles are not replayed')
        self.assertEqual(line['riddles'], [])

    def test_another_photo_is_never_replayed(self):
        with mock.patch('server.replay.PHOTO_SHA256', 'ab' * 32):
            with self.assertRaises(ValueError):
                kitchen_photo()


class Route(unittest.TestCase):
    """The route on a server in MOCK mode: no key, no live pipeline."""

    @classmethod
    def setUpClass(cls):
        cls.run_ = Running(settings_from({}), use_build=True)

    @classmethod
    def tearDownClass(cls):
        cls.run_.stop()

    def test_health_names_the_replay(self):
        _, _, body = self.run_.request('GET', '/api/health')
        h = json.loads(body)
        self.assertEqual(h['mode'], 'mock')
        self.assertEqual(h['replay']['kitchen']['route'], 'api/replay/kitchen')
        self.assertEqual(h['models_called'], [])

    def test_the_photo_is_one_of_the_page_files(self):
        status, h, body = self.run_.request('GET', '/rooms/kitchen.jpg')
        self.assertEqual(status, 200)
        self.assertEqual(h['Content-Type'], 'image/jpeg')
        self.assertEqual(body, PHOTO.read_bytes())
        for path in ('/rooms/other.jpg', '/rooms/kitchen.jpeg', '/server/replay/kitchen/20261027T144859Z_009.json'):
            self.assertEqual(self.run_.request('GET', path)[0], 404, path)

    def test_replay_in_mock_mode(self):
        with mock.patch('server.meta_api.Transport.post_once', side_effect=AssertionError('nothing is sent')):
            status, h, body = self.run_.request('POST', '/api/replay/kitchen', b'', {'X-FramePlay-Request': '1'})
        self.assertEqual(status, 200)
        r = json.loads(body)
        self.assertEqual(r['provenance']['mode'], 'replay')
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(len(r['objects']), 5)
        # the room route still sends nothing in MOCK
        status, _, body = self.run_.request('POST', '/api/room', b'x', {'X-FramePlay-Request': '1'})
        self.assertEqual(status, 409)

    def test_streamed_with_its_own_words(self):
        with mock.patch('server.meta_api.Transport.post_once', side_effect=AssertionError('nothing is sent')):
            status, h, body = self.run_.request('POST', '/api/replay/kitchen', b'', {'X-FramePlay-Request': '1', 'Accept': 'application/x-ndjson'})
        self.assertEqual(status, 200)
        text = re.sub(rb'(?m)^[0-9a-f]+\r\n', b'', body).decode('utf-8')
        lines = [json.loads(x) for x in text.splitlines() if x.strip().startswith('{')]
        self.assertEqual([x['words'] for x in lines if x['type'] == 'progress'], ['Replaying Muse Spark’s recorded read', 'Replaying SAM 3.1’s recorded answers'])
        self.assertEqual([x['type'] for x in lines], ['progress', 'progress', 'reply', 'riddles'])
        reply, line = lines[2]['reply'], lines[3]['riddles']
        self.assertEqual(reply['provenance']['mode'], 'replay')
        # Ask the room: the recorded riddles, for this very request, no model called now
        self.assertEqual(line['request_id'], reply['request_id'])
        self.assertEqual((line['status'], line['provenance']['mode'], line['provenance']['models']), ('ok', 'replay', []))
        self.assertEqual(len(line['riddles']), 2)

    def test_only_the_page_and_only_post(self):
        self.assertEqual(self.run_.request('POST', '/api/replay/kitchen', b'')[0], 403)
        self.assertEqual(self.run_.request('POST', '/api/replay/kitchen', b'', {'X-FramePlay-Request': '1', 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.run_.request('GET', '/api/replay/kitchen')[0], 405)
        self.assertEqual(self.run_.request('PUT', '/api/replay/kitchen')[0], 405)
        self.assertEqual(self.run_.request('POST', '/api/replay/kitchen', b'x' * 65, {'X-FramePlay-Request': '1'})[0], 413, 'a replay carries no photo')
        self.assertEqual(self.run_.request('POST', '/api/replay/desk', b'', {'X-FramePlay-Request': '1'})[0], 404)


class Rate(unittest.TestCase):
    """The replay has its own places, never LIVE's, and its own rate per client."""

    def test_each_client_at_most_its_replays_a_minute(self):
        clock = [100.0]
        lim = ReplayLimits(clock=lambda: clock[0])
        self.assertEqual((config.REPLAY_IN_FLIGHT, config.REPLAY_PER_MINUTE), (4, 10))
        for _ in range(10):
            lim.admit('a')
            lim.finish()
        with self.assertRaises(Refusal) as c:
            lim.admit('a')
        self.assertEqual(c.exception.code, 'replay_rate')
        self.assertTrue(c.exception.message.endswith('.'))
        self.assertTrue(0 < c.exception.retry_after <= 61)
        lim.admit('b')  # another client is not held by the first one's replays
        lim.finish()
        clock[0] += 60
        lim.admit('a')
        self.assertEqual(ReplayLimits(per_minute=99, in_flight=99).per_minute, 10, 'a setting never raises a ceiling')

    def test_the_route_never_waits_behind_live_and_is_held_to_its_rate(self):
        run_ = Running(settings_from({}), use_build=True)
        self.addCleanup(run_.stop)
        run_.srv.replay_pipeline().limits.per_minute = 2
        run_.srv.limits.in_flight = run_.srv.limits.max_in_flight  # every LIVE place taken
        h = {'X-FramePlay-Request': '1'}
        for _ in range(2):
            self.assertEqual(run_.request('POST', '/api/replay/kitchen', b'', h)[0], 200)
        status, headers, body = run_.request('POST', '/api/replay/kitchen', b'', h)
        self.assertEqual((status, json.loads(body)['error']['code']), (429, 'replay_rate'))
        self.assertIn('Retry-After', headers)
        self.assertEqual(run_.srv.replay_pipeline().limits.in_flight, 0)


if __name__ == '__main__':
    unittest.main()
