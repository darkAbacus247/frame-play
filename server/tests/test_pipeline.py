import json
import os
import re
import socket
import unittest
from pathlib import Path

from server import config
from server.config import KeyHolder, Settings, settings_from
from server.imageinfo import check_photo
from server.limits import Limits
from server.meta_api import Transport
from server.pipeline import Pipeline, clean_read, name_problem
from server.samtext import envelope
from server.server import Log
from server.tests import images
from server.tests.fakemeta import FakeMeta, ok_json, sam_answer, spark_answer
from server.tests.test_config import TEST_VALUE
from server.tests.test_server import Running

W, H = 64, 48
ROOT = Path(__file__).resolve().parents[2]

READ = {
    'people_present': False,
    'surface': {'name': 'desk'},
    'objects': [
        {'name': 'mug', 'role': 'solid', 'reason': 'Too hot to hold', 'on_surface': True, 'seeds': [{'x': 200, 'y': 500}]},
        {'name': 'coin', 'role': 'collect', 'reason': 'Shiny and small', 'on_surface': True, 'seeds': []},
        {'name': 'cactus', 'role': 'avoid', 'reason': 'Spiky', 'on_surface': True, 'seeds': []},
        {'name': 'box', 'role': 'exit', 'reason': 'Hop in to leave', 'on_surface': True, 'seeds': []},
        {'name': 'picture frame', 'role': 'solid', 'reason': 'On the wall', 'on_surface': False, 'seeds': []},
        {'name': 'left hand', 'role': 'solid', 'reason': 'x', 'on_surface': True, 'seeds': []},
        {'name': 'lamp', 'role': 'solid', 'reason': 'Bright', 'on_surface': True, 'seeds': []},
    ],
    'title': 'The Desk',
    'theme_line': 'Gather the coins.',
}
M = envelope('abc')
ANSWERS = {
    'desk': f'<0f><w>{W}<h>{H}<id>1<box>0 20 63 47<c>0.97<mask>{M}',
    'mug': f'<0f><w>{W}<h>{H}<id>1<box>5 20 14 30<c>0.91<mask>{M}<id>2<box>40 40 41 41<c>0.2<mask>{M}',
    'coin': (f'<0f><w>{W}<h>{H}<id>1<box>20 30 23 33<c>0.8<mask>{M}<id>2<box>30 30 33 33<c>0.9<mask>{M}'
             f'<id>3<box>40 30 43 33<c>0.7<mask>{M}<id>4<box>50 30 53 33<c>0.6<mask>{M}'),
    'cactus': f'<0f><w>{W}<h>{H}<id>1<box>50 20 55 28<c>0.88<mask>{M}<id>2<box>10 40 12 42<c>0.5<mask>{M}',
    'box': f'<0f><w>{W}<h>{H}<id>1<box>25 21 35 27<c>0.95<mask>{M}',
    'lamp': f'<0f><w>{W}<h>{H}',
}


def sam_by_noun(answers):
    def answer(req, handler):
        noun = req['body']['input'][0]['content'][0]['text']
        return sam_answer(answers[noun])
    return answer


def photo():
    return check_photo(images.jpeg(W, H), config.MAX_SIDE)


class WithFake(unittest.TestCase):
    def setUp(self):
        self.fake = FakeMeta()
        self.lines = []
        self.settings = settings_from({}, self.fake.base, 'desk')
        self.limits = Limits()
        self.pipe = Pipeline(self.settings, self.limits, log=Log(stream=self.lines), sleep=lambda s: None)
        self.fake.always('/responses', sam_by_noun(ANSWERS))

    def tearDown(self):
        self.fake.stop()


class Reads(WithFake):
    def test_the_reply_shape(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        r = self.pipe.run(photo())
        self.assertEqual(r['schema'], 'frameplay.room.reply/2')
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(r['provenance']['mode'], 'rehearsal')
        self.assertEqual(r['provenance']['models'], [], 'a rehearsal claims no model')
        self.assertEqual(r['provenance']['stand_in_for'], ['muse-spark-1.3', 'sam-3.1'])
        self.assertTrue(all(c['model'].startswith('REHEARSAL stand-in for ') for c in r['provenance']['calls']))
        self.assertEqual(r['received']['width'], W)
        self.assertGreater(r['received']['metadata_bytes_removed'], 0)
        self.assertEqual(r['scene']['title'], 'The Desk')
        self.assertEqual(r['scene']['scenery'], [{'name': 'picture frame', 'reason': 'On the wall'}])
        self.assertEqual(r['surface'], {'name': 'desk', 'box': [0, 20, 64, 48], 'confidence': 0.97})
        names = [(o['name'], o['instance']) for o in r['objects']]
        self.assertEqual(names, [('mug', 1), ('coin', 1), ('coin', 2), ('coin', 3), ('cactus', 1), ('box', 1)])
        coins = [o for o in r['objects'] if o['name'] == 'coin']
        self.assertEqual([c['confidence'] for c in coins], [0.9, 0.8, 0.7], 'every match counts, up to 3, best first')
        mug = r['objects'][0]
        self.assertEqual(mug['box'], [5, 20, 15, 31], 'half-open boxes')
        self.assertEqual(mug['seeds'], [[12.8, 24.0]], 'seeds in pixels, inside the box')
        self.assertEqual(mug['mask'], {'height': H, 'width': W, 'encoding': 'one_bit', 'decoded': False, 'payload_chars': 3})
        self.assertIn('not found: lamp', r['warnings'])
        self.assertTrue(any('left hand' in w for w in r['warnings']), 'a body word is dropped')
        self.assertEqual(r['usage']['spark_calls'], 1)
        self.assertEqual(r['usage']['sam_calls'], 6, 'the surface and five on-surface nouns; scenery is never sent')
        self.assertEqual(r['usage']['calls'], 7)
        self.assertGreater(r['usage']['estimated_usd'], 0.01)

    def test_the_spark_call_follows_the_rules(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.pipe.run(photo())
        body = next(q['body'] for q in self.fake.requests if q['path'] == '/v1/chat/completions')
        self.assertEqual(body['model'], 'muse-spark-1.3')
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertEqual(body['max_completion_tokens'], 2400)
        self.assertNotIn('temperature', body)
        rf = body['response_format']
        self.assertEqual((rf['type'], rf['json_schema']['strict']), ('json_schema', True))

        def strict(node):
            if isinstance(node, dict) and node.get('type') == 'object':
                self.assertIs(node['additionalProperties'], False)
                self.assertEqual(sorted(node['required']), sorted(node['properties']))
                for v in node['properties'].values():
                    strict(v)
            if isinstance(node, dict) and node.get('type') == 'array':
                strict(node['items'])
        strict(rf['json_schema']['schema'])
        content = body['messages'][0]['content']
        self.assertEqual(body['messages'][0]['role'], 'user')
        self.assertEqual([c['type'] for c in content], ['text', 'image_url'])
        self.assertTrue(content[1]['image_url']['url'].startswith('data:image/jpeg;base64,'))
        sam = [q['body'] for q in self.fake.requests if q['path'] == '/v1/responses']
        for b in sam:
            self.assertEqual(b['model'], 'sam-3.1')
            self.assertIs(b['stream'], False)
            self.assertIs(b['store'], False)
            self.assertEqual(b['metadata'], {'mask_encoding': 'one_bit', 'include_confidence': 'true'})
            self.assertEqual(b['input'][0]['content'][0]['type'], 'input_text')
            self.assertEqual(b['input'][0]['content'][1]['type'], 'input_image')

    def test_people_stop_the_read_before_any_sam_call(self):
        self.fake.on('/chat/completions', spark_answer({**READ, 'people_present': True}))
        r = self.pipe.run(photo())
        self.assertEqual(r['status'], 'refused')
        self.assertEqual(r['error']['code'], 'people_present')
        self.assertEqual(r['error']['message'], 'This photo seems to show a person. Please use one with no people.')
        self.assertEqual(self.fake.count('/responses'), 0)

    def test_content_filter_is_a_refusal_not_retried(self):
        self.fake.on('/chat/completions', spark_answer(READ, finish='content_filter'))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('refused', 'content_filter'))
        self.assertEqual(self.fake.count('/chat/completions'), 1)
        self.assertEqual(self.fake.count('/responses'), 0)

    def test_zero_matches(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.fake.always('/responses', sam_answer(f'<0f><w>{W}<h>{H}'))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('error', 'nothing_found'))
        self.assertIn('not found: mug', r['warnings'])

    def test_a_malformed_read_keeps_a_short_redacted_excerpt(self):
        bad = ok_json({'choices': [{'finish_reason': 'stop', 'message': {'content': 'Sure! ' + TEST_VALUE + ' ' + 'z' * 800}}]})
        self.fake.on('/chat/completions', bad)
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('error', 'malformed'))
        call = r['provenance']['calls'][0]
        self.assertLessEqual(len(call['excerpt']), 300)
        self.assertNotIn(TEST_VALUE, json.dumps(r))
        self.assertEqual(self.fake.count('/chat/completions'), 1, 'never retried')

    def test_a_size_mismatch_is_not_used(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        wrong = dict(ANSWERS, mug=ANSWERS['mug'].replace(f'<w>{W}', '<w>999'))
        self.fake.always('/responses', sam_by_noun(wrong))
        r = self.pipe.run(photo())
        self.assertNotIn('mug', [o['name'] for o in r['objects']])
        self.assertTrue(any('different picture size' in w for w in r['warnings']))

    def test_the_spend_stop(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.limits.usd_stop = 0.001
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('refused', 'spend_stop'))
        self.assertEqual(len(self.fake.requests), 0, 'nothing is sent past the stop')

    def test_the_photo_log_line(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        r = self.pipe.run(photo())
        line = json.loads(self.lines[-1])
        self.assertEqual(line['event'], 'photo')
        self.assertEqual(line['request_id'], r['request_id'])
        self.assertEqual(line['sha256'], r['provenance']['image_sha256'])
        for word in ('Spiky', 'coin', 'You are reading', 'base64'):
            self.assertNotIn(word, self.lines[-1], 'no prompt, no answer, no photo in the log')


class Names(unittest.TestCase):
    def test_the_rules(self):
        self.assertIsNone(name_problem('desk lamp'))
        self.assertIsNone(name_problem("children's book".replace("children's", 'picture')))
        for bad in ('mug and coin', 'left mug', 'person', 'a very big red mug', 'mug, coin', 'hand', '', 'mug2'):
            self.assertIsNotNone(name_problem(bad), bad)
        warnings = []
        room = clean_read({**READ, 'title': 'x' * 90, 'objects': READ['objects'] + [READ['objects'][0]]}, 100, 100, warnings)
        self.assertEqual(len(room['title']), 60)
        self.assertEqual([o['name'] for o in room['objects']].count('mug'), 1, 'a repeated name merges')


class OverHttp(unittest.TestCase):
    """The server routes in rehearsal, with the stand-in fake behind them."""

    def setUp(self):
        self.fake = FakeMeta()
        self.fake.always('/responses', sam_by_noun(ANSWERS))
        s = settings_from({}, self.fake.base, 'desk')
        self.limits = Limits()
        self.lines = []
        self.pipe = Pipeline(s, self.limits, sleep=lambda x: None)
        self.run_ = Running(s, pipeline=self.pipe, limits=self.limits)
        self.pipe.log = self.run_.srv.log

    def tearDown(self):
        self.run_.stop()
        self.fake.stop()

    def post(self, accept='application/json'):
        return self.run_.request('POST', '/api/room', images.jpeg(W, H),
                                 {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg', 'Accept': accept})

    def test_progress_lines_then_the_reply(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        status, h, body = self.post('application/x-ndjson')
        self.assertEqual(status, 200)
        self.assertTrue(h['Content-Type'].startswith('application/x-ndjson'))
        lines = [json.loads(x) for x in body.decode().splitlines()]
        self.assertEqual([x['type'] for x in lines], ['progress', 'progress', 'reply'])
        self.assertEqual([x.get('words') for x in lines[:2]], ['Reading your room', 'Finding every object'])
        self.assertEqual(lines[2]['reply']['status'], 'ok')
        self.assertEqual(self.limits.counters()['photos_in_flight'], 0)

    def test_the_stream_is_chunked_and_ends_with_its_terminating_chunk(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        body = images.jpeg(W, H)
        s = socket.create_connection(('127.0.0.1', self.run_.port), timeout=10)
        try:
            s.sendall(b'POST /api/room HTTP/1.1\r\nHost: 127.0.0.1\r\nX-FramePlay-Request: 1\r\n'
                      b'Content-Type: image/jpeg\r\nAccept: application/x-ndjson\r\n'
                      + b'Content-Length: %d\r\n\r\n' % len(body) + body)
            raw = b''
            while True:
                part = s.recv(65536)
                if not part:
                    break
                raw += part
        finally:
            s.close()
        head, _, rest = raw.partition(b'\r\n\r\n')
        self.assertIn(b'Transfer-Encoding: chunked', head)
        self.assertTrue(rest.endswith(b'\r\n0\r\n\r\n'), 'the stream says it is complete')

    def test_a_read_that_breaks_after_the_headers_still_ends_the_stream_in_words(self):
        def broken(photo, progress=None):
            progress('read', 'Reading your room')
            raise RuntimeError('broken mid-way')
        self.pipe.run = broken
        status, h, body = self.post('application/x-ndjson')
        self.assertEqual(status, 200)
        lines = [json.loads(x) for x in body.decode().splitlines()]
        self.assertEqual([x['type'] for x in lines], ['progress', 'reply'])
        reply = lines[-1]['reply']
        self.assertEqual(reply['status'], 'error')
        self.assertEqual(reply['provenance']['mode'], 'rehearsal')
        self.assertEqual(reply['error']['message'], 'The server could not finish reading this photo. Please try again.')
        self.assertNotIn('broken mid-way', body.decode(), 'no internal error text reaches the page')
        self.assertEqual(self.limits.counters()['photos_in_flight'], 0)

    def test_one_json_object_without_the_stream(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        status, h, body = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['status'], 'ok')

    def test_429_past_a_ceiling(self):
        self.limits.max_in_flight = 0
        status, h, body = self.post()
        self.assertEqual(status, 429)
        self.assertIn('Retry-After', h)
        self.assertEqual(json.loads(body)['error']['code'], 'busy')
        self.assertEqual(len(self.fake.requests), 0)

    def test_health_counts(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.post()
        j = json.loads(self.run_.request('GET', '/api/health')[2])
        self.assertEqual(j['counters']['photos_today'], 1)
        self.assertEqual(j['counters']['calls_sent'], 7)


class TheKeyNeverLeaks(unittest.TestCase):
    """Live-shaped settings with a test value in the holder, against a
    loopback fake that even echoes the Authorization header back."""

    def test_no_reply_and_no_log_holds_it(self):
        fake = FakeMeta()
        try:
            def echo(req, handler):
                return 401, {}, json.dumps({'error': {'code': 'bad_key', 'message': 'got ' + req['headers'].get('Authorization', '')}}).encode()
            fake.always('/chat/completions', echo)
            holder = KeyHolder(TEST_VALUE)
            s = Settings('live', 'test', holder, config.API_BASE, 200, 5.0, '', True)
            lines = []
            pipe = Pipeline(s, Limits(), log=Log(stream=lines, holder=holder), transport=Transport(fake.base, holder), sleep=lambda x: None)
            run_ = Running(s, pipeline=pipe, limits=pipe.limits)
            pipe.log = run_.srv.log
            try:
                status, _, body = run_.request('POST', '/api/room', images.jpeg(W, H), {'X-FramePlay-Request': '1'})
                health = run_.request('GET', '/api/health')[2]
            finally:
                run_.stop()
            self.assertEqual(status, 200)
            reply = json.loads(body)
            self.assertEqual(reply['error']['code'], 'bad_key')
            self.assertEqual(reply['provenance']['models'], ['muse-spark-1.3', 'sam-3.1'])
            for text in (body.decode(), health.decode(), '\n'.join(run_.lines), '\n'.join(lines)):
                self.assertNotIn(TEST_VALUE, text)
            self.assertIn('present (never shown)', health.decode())
            self.assertEqual(fake.requests[0]['headers']['Authorization'], 'Bearer ' + TEST_VALUE, 'sent only as the bearer token, only to the base')
        finally:
            fake.stop()


class MockNeverCalls(unittest.TestCase):
    def test_mock_mode_sends_nothing(self):
        fake = FakeMeta()
        run_ = Running(settings_from({}), use_build=True)
        try:
            self.assertIsNone(run_.srv.pipeline)
            status, _, _ = run_.request('POST', '/api/room', images.jpeg(W, H), {'X-FramePlay-Request': '1'})
            self.assertEqual(status, 409)
            self.assertEqual(fake.requests, [])
        finally:
            run_.stop()
            fake.stop()


class ContributorGuard(unittest.TestCase):
    def test_no_file_names_a_contributor_model(self):
        word = '-contri' + 'butor'
        skip = {'.git', 'node_modules', 'tmp', '__pycache__'}
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for f in filenames:
                p = Path(dirpath) / f
                try:
                    text = p.read_text(encoding='utf-8')
                except (UnicodeDecodeError, OSError):
                    continue
                if re.search(re.escape(word), text, re.I):
                    found.append(str(p.relative_to(ROOT)))
        self.assertEqual(found, [])


if __name__ == '__main__':
    unittest.main()
