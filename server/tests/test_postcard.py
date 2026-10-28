"""A room postcard (server/postcard.py, POST /api/postcard): the exact image
request, the switch, the caps, the drills, the read-back and the comparer."""
import base64
import dataclasses
import json
import threading
import unittest

from server import config, postcard
from server.config import settings_from
from server.imageinfo import sniff
from server.limits import Limits
from server.meta_api import CallError, Transport
from server.pipeline import Pipeline
from server.server import POSTCARD_ROUTE, build_server
from server.standin import POSTCARD_JPEG, POSTCARD_JPEG_B64, StandIn, make_server
from server.tests.fakemeta import FakeMeta, ok_json
from server.tests.test_config import TEST_VALUE
from server.tests.test_server import Running

PHOTO = 'data:image/jpeg;base64,AAAA'
ROOM = 'The Desk Top'


def spark_readback(lines, tin=2100, tout=400):
    return ok_json({'choices': [{'finish_reason': 'stop',
                                 'message': {'content': json.dumps({'lines': lines})}}],
                    'usage': {'prompt_tokens': tin, 'completion_tokens': tout, 'total_tokens': tin + tout}})


def postcard_answer(b64=POSTCARD_JPEG_B64):
    return ok_json({'created': 1, 'data': [{'b64_json': b64}],
                    'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}})


class ImageBody(unittest.TestCase):
    def test_the_exact_request_body(self):
        from server.meta_api import image_body
        body = image_body(postcard.postcard_prompt(ROOM), PHOTO, 'visitor')
        self.assertEqual(body, {
            'model': 'muse-image-1.0',
            'prompt': body['prompt'],
            'images': [{'image_url': PHOTO}],
            'n': 1,
            'size': '1536x1024',
            'response_format': 'b64_json',
            'output_format': 'jpeg',
            'reasoning_strength': 'low',
            'tool_enablement': {'enable_image_search': False, 'enable_web_search': False, 'enable_shell': False},
            'user': 'visitor',
        })
        for forbidden in ('mask', 'input_fidelity', 'partial_images', 'moderation', 'seed'):
            self.assertNotIn(forbidden, body)
        self.assertIn('No people, no faces.', body['prompt'])
        self.assertIn('Greetings from ' + ROOM, body['prompt'])

    def test_the_switch_is_off_unless_the_environment_says_yes(self):
        self.assertEqual((config.POSTCARD_USD, config.POSTCARD_DAY_CAP), (0.01, 100))
        self.assertFalse(settings_from({}).image)
        self.assertFalse(settings_from({'FRAMEPLAY_IMAGE': 'no'}).image)
        self.assertFalse(settings_from({'FRAMEPLAY_IMAGE': 'YES'}).image, 'only the exact word yes')
        self.assertTrue(settings_from({'FRAMEPLAY_IMAGE': 'yes'}).image)
        self.assertTrue(settings_from({'FRAMEPLAY_IMAGE': ' yes '}).image)
        self.assertTrue(settings_from({}, 'http://127.0.0.1:9/v1').image is False)


class ImageCall(unittest.TestCase):
    def setUp(self):
        self.fake = FakeMeta()
        self.t = Transport(self.fake.base, config.REHEARSAL_CREDENTIAL)

    def tearDown(self):
        self.fake.close()

    def edit(self, **kw):
        return postcard.edit_postcard(self.t, ROOM, PHOTO, 'visitor', kw.get('deadline', 30),
                                      sleep=lambda s: None, clock=lambda: 0.0)

    def test_the_first_answer_s_b64_and_usage_come_back(self):
        self.fake.on('/images/edits', postcard_answer())
        b64, usage, sends = self.edit()
        self.assertEqual((b64, sends), (POSTCARD_JPEG_B64, 1))
        self.assertEqual(usage, {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0})
        body = self.fake.requests[0]['body']
        self.assertEqual(body['model'], 'muse-image-1.0')
        self.assertEqual(body['tool_enablement'],
                         {'enable_image_search': False, 'enable_web_search': False, 'enable_shell': False})
        for forbidden in ('mask', 'input_fidelity', 'partial_images', 'moderation', 'seed'):
            self.assertNotIn(forbidden, body)
        self.assertIn('No people, no faces.', body['prompt'])

    def test_a_400_content_policy_violation_is_a_plain_refusal_with_no_retry(self):
        self.fake.on('/images/edits', (400, {}, b'{"error": {"code": "content_policy_violation", "message": "no"}}'))
        with self.assertRaises(CallError) as e:
            self.edit()
        self.assertEqual(e.exception.code, 'refused')
        self.assertFalse(e.exception.transient)
        self.assertTrue(e.exception.message.endswith('.'))
        self.assertEqual(len(self.fake.requests), 1)

    def test_a_503_is_sent_once_more(self):
        self.fake.on('/images/edits', (503, {}, b'{"error": {"code": "unavailable", "message": "busy"}}'),
                     postcard_answer())
        b64, _, sends = self.edit()
        self.assertEqual(b64, POSTCARD_JPEG_B64)
        self.assertEqual(len(self.fake.requests), 2)
        self.assertEqual(sends, 2, 'the retry is counted, so the spend settles both sends')


class StandInPostcard(unittest.TestCase):
    def answer(self, drill=None):
        from server.meta_api import image_body
        s = StandIn('desk', drill)
        body = image_body(postcard.postcard_prompt(ROOM), PHOTO, 'visitor')
        return s.answer('/v1/images/edits', {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}, body)

    def test_the_stand_in_answers_a_small_fixed_jpeg(self):
        status, _, j = self.answer()
        self.assertEqual(status, 200)
        self.assertEqual(j['data'], [{'b64_json': POSTCARD_JPEG_B64}])
        self.assertIn('usage', j)
        raw = base64.b64decode(j['data'][0]['b64_json'])
        self.assertEqual(raw, POSTCARD_JPEG)
        self.assertEqual(sniff(raw), 'image/jpeg')

    def test_both_drills(self):
        from server.meta_api import image_body
        status, _, j = self.answer('postcard_refused')
        self.assertEqual(status, 400)
        self.assertEqual(j['error']['code'], 'content_policy_violation')
        s = StandIn('desk', 'postcard_busy')
        body = image_body(postcard.postcard_prompt(ROOM), PHOTO, 'visitor')
        auth = {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}
        self.assertEqual(s.answer('/v1/images/edits', auth, body)[0], 503)
        self.assertEqual(s.answer('/v1/images/edits', auth, body)[0], 200, 'busy once, then the picture')

    def test_the_stand_in_wants_the_contract(self):
        from server.meta_api import image_body
        s = StandIn('desk')
        auth = {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}
        body = image_body(postcard.postcard_prompt(ROOM), PHOTO, 'visitor')
        for bad in ({**body, 'model': 'other'}, {**body, 'size': '1024x1024'},
                    {k: v for k, v in body.items() if k != 'user'}):
            self.assertEqual(s.answer('/v1/images/edits', auth, bad)[0], 400, bad.get('model', 'missing user'))


class Readback(unittest.TestCase):
    def test_the_body_is_built_like_the_riddle_body(self):
        body = postcard.readback_body(postcard.READBACK_PROMPT, PHOTO)
        self.assertEqual(body['model'], config.SPARK_MODEL)
        self.assertEqual(body['reasoning_effort'], 'low')
        self.assertEqual(body['max_completion_tokens'], config.READBACK_MAX_COMPLETION_TOKENS)
        rf = body['response_format']
        self.assertEqual((rf['type'], rf['json_schema']['strict']), ('json_schema', True))
        self.assertEqual(rf['json_schema']['schema'],
                         {'type': 'object', 'additionalProperties': False, 'required': ['lines'],
                          'properties': {'lines': {'type': 'array', 'items': {'type': 'string'}}}})
        self.assertEqual(body['messages'][0]['content'][1]['image_url']['url'], PHOTO)
        self.assertNotIn('temperature', body)

    def test_a_strict_answer_reads(self):
        j = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({'lines': ['Greetings from here']})}}],
             'usage': {'prompt_tokens': 2100, 'completion_tokens': 12}}
        self.assertEqual(postcard.read_readback(j), (['Greetings from here'], 2100, 12))

    def test_a_refusal_and_a_broken_answer_raise(self):
        j = {'choices': [{'finish_reason': 'content_filter', 'message': {'content': ''}}], 'usage': {}}
        with self.assertRaises(CallError) as e:
            postcard.read_readback(j)
        self.assertEqual(e.exception.code, 'content_filter')
        for bad in ({'choices': []}, {'choices': [{'finish_reason': 'stop', 'message': {'content': 'not json'}}]},
                    {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({'lines': 'x'})}}]}):
            with self.assertRaises(CallError, msg=str(bad)) as e:
                postcard.read_readback(bad)
            self.assertEqual(e.exception.code, 'malformed')

    def test_the_comparer(self):
        self.assertEqual(postcard.compare_readback(['Greetings from The Desk Top'], ROOM),
                         {'match': True, 'difference': ''})
        self.assertEqual(postcard.compare_readback(['greetings, from the desk top!'], ROOM)['match'], True,
                         'case and punctuation are normalised')
        first = postcard.compare_readback(['Greetings from The Living Room'], ROOM)
        self.assertFalse(first['match'])
        self.assertIn('Desk', first['difference'])
        self.assertIn('Living', first['difference'])
        short = postcard.compare_readback(['Greetings from'], ROOM)
        self.assertEqual((short['match'], short['difference']), (False, 'missing "the"'))


class Route(unittest.TestCase):
    """POST /api/postcard against the stand-in, with LIVE switched on over it."""

    def setUp(self, environ=None):
        self.standin = StandIn('desk')
        self.ssrv = make_server(self.standin, '127.0.0.1', 0)
        threading.Thread(target=self.ssrv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{self.ssrv.server_address[1]}/v1'
        settings = settings_from(environ or {}, base, 'desk')
        # LIVE over the stand-in: the rehearsal transport carries the calls,
        # the switch says postcards are on
        settings = dataclasses.replace(settings, mode='live', image=True,
                                       key=config.KeyHolder(TEST_VALUE), key_present=True)
        self.limits = Limits(clients=False)
        self.pipe = Pipeline(settings, self.limits, sleep=lambda s: None)
        self.run_ = Running(settings, pipeline=self.pipe, limits=self.limits)
        self.pipe.log = self.run_.srv.log

    def tearDown(self):
        self.run_.stop()
        self.ssrv.shutdown()
        self.ssrv.server_close()

    def post(self, photo=PHOTO, room=ROOM):
        body = json.dumps({'photo': photo, 'room': room}).encode()
        status, _, raw = self.run_.request('POST', POSTCARD_ROUTE, body,
                                           {'X-FramePlay-Request': '1', 'Content-Type': 'application/json'})
        return status, json.loads(raw)

    def test_a_postcard_comes_back_labelled_with_its_readback(self):
        status, j = self.post()
        self.assertEqual(status, 200, j)
        self.assertEqual(j['image'], POSTCARD_JPEG_B64)
        self.assertEqual(j['label'], 'Made by Muse Image (AI)')
        self.assertEqual(j['mode'], 'live')
        # the stand-in's chat answer is the room read, not a read-back: the
        # read-back fails and the postcard still comes back
        self.assertEqual(j['readback']['lines'], [])
        self.assertFalse(j['readback']['match'])
        self.assertTrue(j['readback']['difference'].endswith('.') or j['readback']['difference'])

    def test_a_readback_that_matches_is_reported(self):
        orig = StandIn.answer

        def answer(self, path, headers, body):
            if path == '/v1/chat/completions':
                name = (body.get('response_format') or {}).get('json_schema', {}).get('name')
                if name == 'postcard_readback':
                    return 200, {}, {'choices': [{'finish_reason': 'stop', 'message': {
                        'content': json.dumps({'lines': ['Greetings from The Desk Top']})}}],
                        'usage': {'prompt_tokens': 2100, 'completion_tokens': 12, 'total_tokens': 2112}}
            return orig(self, path, headers, body)
        StandIn.answer = answer
        try:
            status, j = self.post()
        finally:
            StandIn.answer = orig
        self.assertEqual(status, 200, j)
        self.assertEqual(j['readback']['lines'], ['Greetings from The Desk Top'])
        self.assertEqual((j['readback']['match'], j['readback']['difference']), (True, ''))

    def test_the_switch_off_refusal_sends_nothing(self):
        self.run_.srv.settings = dataclasses.replace(self.run_.srv.settings, image=False)
        before = len(self.standin.requests)
        status, j = self.post()
        self.assertEqual(status, 409)
        self.assertEqual(j['error']['code'], 'image_off')
        self.assertTrue(j['error']['message'].endswith('.'))
        self.assertEqual(len(self.standin.requests), before)

    def test_not_live_is_refused_with_no_outbound_call(self):
        self.run_.srv.settings = dataclasses.replace(self.run_.srv.settings, mode='rehearsal')
        before = len(self.standin.requests)
        status, j = self.post()
        self.assertEqual(status, 409)
        self.assertEqual(j['error']['code'], 'live_off')
        self.assertEqual(len(self.standin.requests), before)

    def test_the_day_cap_is_refused_with_no_outbound_call(self):
        self.run_.srv.postcards_today = config.POSTCARD_DAY_CAP
        before = len(self.standin.requests)
        status, j = self.post()
        self.assertEqual(status, 429)
        self.assertEqual(j['error']['code'], 'postcard_day_cap')
        self.assertEqual(len(self.standin.requests), before)

    def test_the_spend_stop_reserves_the_picture_plus_the_readback_worst(self):
        seen = []
        reserve = self.limits.reserve

        def spy(usd):
            seen.append(usd)
            return reserve(usd)
        self.limits.reserve = spy
        status, j = self.post()
        self.assertEqual(status, 200, j)
        self.assertEqual(seen, [postcard.POSTCARD_WORST])
        worst = config.POSTCARD_USD + config.SPARK_WORST_IN_TOKENS * config.PRICE_SPARK_IN \
            + config.READBACK_MAX_COMPLETION_TOKENS * config.PRICE_SPARK_OUT
        self.assertAlmostEqual(postcard.POSTCARD_WORST, worst)
        from server.limits import Refusal
        self.limits.reserve = lambda usd: (_ for _ in ()).throw(Refusal('spend_stop', 'This server reached its spending stop.'))
        before = len(self.standin.requests)
        status, j = self.post()
        self.assertEqual(status, 429)
        self.assertEqual(j['error']['code'], 'spend_stop')
        self.assertEqual(len(self.standin.requests), before, 'the spend stop reserves before anything is sent')

    def test_both_drills_through_the_route(self):
        self.standin.drill = 'postcard_refused'
        status, j = self.post()
        self.assertEqual(status, 400)
        self.assertEqual(j['error']['code'], 'refused')
        self.standin.drill = 'postcard_busy'
        self.standin.drill_used = False
        status, j = self.post()
        self.assertEqual(status, 200, 'one 503 is retried')
        self.assertEqual(j['image'], POSTCARD_JPEG_B64)

    def test_a_bad_request_is_400(self):
        for photo, room in ((None, ROOM), (PHOTO, ''), ('not-a-data-url', ROOM)):
            status, j = self.post(photo, room)
            self.assertEqual(status, 400, (photo, room))
            self.assertEqual(j['error']['code'], 'bad_request')

    def test_health_lists_the_postcard_switch_and_its_ceilings(self):
        _, _, raw = self.run_.request('GET', '/api/health')
        h = json.loads(raw)
        self.assertEqual(h['postcard'], 'on')
        self.assertIn('Muse Image', h['postcard_reason'])
        self.assertEqual(h['ceilings']['postcards_per_day'], 100)
        self.assertEqual(h['ceilings']['postcard_usd'], 0.01)
        self.assertEqual(h['ceilings']['postcard_readback_max_completion_tokens'],
                         config.READBACK_MAX_COMPLETION_TOKENS)
        self.assertEqual(h['ceilings']['riddle_spark_calls_per_photo'], 1, 'the riddle ceilings stay beside them')
        self.run_.srv.settings = dataclasses.replace(self.run_.srv.settings, image=False)
        _, _, raw = self.run_.request('GET', '/api/health')
        h = json.loads(raw)
        self.assertEqual(h['postcard'], 'off')
        self.assertIn('FRAMEPLAY_IMAGE', h['postcard_reason'])

    def test_build_server_starts_with_the_switch_off(self):
        srv = build_server(settings_from({}), '127.0.0.1', 0)
        try:
            self.assertEqual(srv.health()['postcard'], 'off')
            self.assertEqual(srv.health()['ceilings']['postcards_per_day'], config.POSTCARD_DAY_CAP)
        finally:
            srv.server_close()


if __name__ == '__main__':
    unittest.main()
