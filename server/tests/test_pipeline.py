import json
import os
import re
import socket
import unittest
from pathlib import Path

from server import config, samtext
from server.config import KeyHolder, Settings, settings_from
from server.imageinfo import check_photo
from server.limits import Limits
from server.meta_api import CallError, Transport
from server.pipeline import (Pipeline, choose_matches, clean_read, iou, name_problem, point_regions, settle_claims,
                             held, inside, normalize_name, reply_error, surface_from, surface_like)
from server.samtext import compose
from server.server import Log
from server.tests import images, recorded
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


def ans(*matches):
    """An answer text in sam-3.1's grammar: matches of (x1, y1, x2, y2, c)."""
    return compose([{'box': m[:4], 'confidence': m[4], 'payload': 'abc'} for m in matches], W, H)


ANSWERS = {
    'desk': ans((0, 20, 63, 47, 0.97)),
    'mug': ans((5, 20, 14, 30, 0.91), (40, 40, 41, 41, 0.2)),
    'coin': ans((20, 30, 23, 33, 0.8), (30, 30, 33, 33, 0.9), (40, 30, 43, 33, 0.7), (50, 30, 53, 33, 0.6)),
    'cactus': ans((50, 20, 55, 28, 0.88), (10, 40, 12, 42, 0.5)),
    'box': ans((25, 21, 35, 27, 0.95)),
    'lamp': ans(),
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
        self.assertEqual(mug['mask'], {'height': 11, 'width': 10, 'encoding': 'one_bit', 'decoded': False, 'payload_chars': 3})
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
        self.assertEqual(body['max_completion_tokens'], 4000)
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
        self.assertEqual(r['error']['message'], 'This photo seems to show a person (people in posters, screens, framed photos '
                                                'and mirrors count too). Please use one with no people.')
        self.assertEqual(self.fake.count('/responses'), 0)

    def test_content_filter_is_a_refusal_not_retried(self):
        self.fake.on('/chat/completions', spark_answer(READ, finish='content_filter'))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('refused', 'content_filter'))
        self.assertEqual(self.fake.count('/chat/completions'), 1)
        self.assertEqual(self.fake.count('/responses'), 0)

    def test_zero_matches_fall_back_to_the_points(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.fake.always('/responses', sam_answer('<0f>\n'))
        r = self.pipe.run(photo())
        self.assertEqual(r['status'], 'ok')
        self.assertEqual([(o['name'], o['found_by'], o['confidence']) for o in r['objects']], [('mug', 'points', None)],
                         'only the mug came with a point')
        self.assertEqual(r['objects'][0]['seeds'], [[12.8, 24.0]])
        self.assertEqual(r['provenance']['found'], {'sam': 0, 'points': 1, 'words': 'The stand-in for SAM 3.1 found 0; for 1 more, code traces around Muse Spark’s points.'})
        self.assertIn('not found by SAM 3.1: mug; code traces around Muse Spark’s points for it instead', r['warnings'])
        self.assertIn('not found: coin', r['warnings'], 'no point, no region')

    def test_zero_matches_and_no_points(self):
        read = {**READ, 'objects': [{**o, 'seeds': []} for o in READ['objects']]}
        self.fake.on('/chat/completions', spark_answer(read))
        self.fake.always('/responses', sam_answer('<0f>\n'))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('error', 'nothing_found'))
        self.assertEqual(r['error']['message'], 'SAM 3.1 found none of the things Muse Spark named, and Muse Spark gave no points to trace around instead. Try another photo with clearer edges.')
        self.assertIn('not found: mug', r['warnings'])

    def completion(self, finish, **message):
        return ok_json({'choices': [{'index': 0, 'finish_reason': finish, 'message': {'role': 'assistant', **message}}],
                        'usage': {'prompt_tokens': 1354, 'completion_tokens': 4000}})

    def test_a_read_cut_off_at_the_cap_says_so(self):
        # A2: finish_reason "length" and half a JSON object
        self.fake.on('/chat/completions', self.completion('length', content=json.dumps(READ)[:300]))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('error', 'cut_off'))
        self.assertEqual(r['error']['message'], 'The room read was cut off before it finished. Please try the same photo '
                                                'again; a photo with fewer things in it reads faster.')
        self.assertEqual(self.fake.count('/chat/completions'), 1)
        self.assertEqual(self.fake.count('/responses'), 0)
        self.assertGreater(r['usage']['estimated_usd'], 0, 'a cut-off read is billed')

    def test_a_refusal_in_its_own_field_is_a_refusal(self):
        self.fake.on('/chat/completions', self.completion('stop', content=None, refusal='I cannot help with that.'))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('refused', 'content_filter'))
        self.assertEqual(self.fake.count('/responses'), 0)

    def test_an_empty_read_is_not_called_invalid_json(self):
        self.fake.on('/chat/completions', self.completion('stop', content=None, refusal=None))
        r = self.pipe.run(photo())
        self.assertEqual((r['error']['code'], r['error']['message']), ('malformed', 'The room read came back empty. Please try the same photo again.'))

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
        wrong = dict(ANSWERS, mug=ANSWERS['mug'].replace(f'w={W}', 'w=999'))
        self.fake.always('/responses', sam_by_noun(wrong))
        r = self.pipe.run(photo())
        mug = next(o for o in r['objects'] if o['name'] == 'mug')
        self.assertEqual(mug['found_by'], 'points', 'the box for another size is not used; the mug’s point is')
        self.assertIn('not found by SAM 3.1: mug (the answer was for a different picture size); code traces around Muse Spark’s points for it instead', r['warnings'])

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
        for word in ('Spiky', 'You are reading', 'base64', '<0f>', 'abc', '[5, 20', '0.91', '12.8'):
            self.assertNotIn(word, self.lines[-1], 'no prompt, no reason, no answer text, no box, no point, no photo in the log')
        # per name sent to SAM: how many matches it gave and how many were kept
        self.assertEqual(line['found'], [
            {'name': 'desk', 'matches': 1, 'kept': 1, 'surface': True},
            {'name': 'box', 'matches': 1, 'kept': 1, 'points': 0},
            {'name': 'cactus', 'matches': 2, 'kept': 1, 'points': 0, 'dropped': ['relative']},
            {'name': 'coin', 'matches': 4, 'kept': 3, 'points': 0, 'dropped': ['relative']},
            {'name': 'lamp', 'matches': 0, 'kept': 0, 'points': 0},
            {'name': 'mug', 'matches': 2, 'kept': 1, 'points': 0, 'dropped': ['low']},
        ])

    def test_the_log_shows_a_surprise_without_a_capture(self):
        # SAM answers in a grammar the reader does not know: the log says
        # which name, how many matches, and the reader's codes
        self.fake.on('/chat/completions', spark_answer(READ))
        odd = dict(ANSWERS, mug='<0f>0<|box;x1=5;y1=20;x2=14|>\n')
        self.fake.always('/responses', sam_by_noun(odd))
        self.pipe.run(photo())
        line = json.loads(self.lines[-1])
        mug = next(f for f in line['found'] if f['name'] == 'mug')
        self.assertEqual(mug, {'name': 'mug', 'matches': 0, 'kept': 0, 'points': 1, 'diagnostics': ['malformed_record']})
        self.assertNotIn('x1=', self.lines[-1])


SEEDLESS = {**READ, 'objects': [{**o, 'seeds': []} for o in READ['objects']]}


class Raising:
    """A transport whose calls raise the given errors (route -> CallError),
    and otherwise answer as the recorded desk does."""

    def __init__(self, spark=None, sam=None):
        self.spark, self.sam = spark, sam
        self.inner = recorded.RecordedTransport()

    def post(self, route, body, deadline, sleep=None, clock=None):
        err = self.spark if route == '/chat/completions' else self.sam
        if err is not None:
            raise err
        return self.inner.post(route, body, deadline, sleep, clock)


def latched(code, status):
    e = CallError(code, f'The Model API said {status}. The owner of this server must fix this; the sample rooms still work.', status, billed=False)
    e.latched = True
    return e


class SamTrouble(WithFake):
    """A1: SAM calls that failed are told apart from a true "found none"."""

    def assertNotBlamingThePhoto(self, r):
        self.assertNotIn('clearer edges', r['error']['message'])
        self.assertFalse([w for w in r['warnings'] if w.startswith('not found')], r['warnings'])

    def test_busy(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.fake.always('/responses', ok_json({'error': {'code': 'rate_limited'}}, 429))
        r = self.pipe.run(photo())
        self.assertEqual((r['status'], r['error']['code']), ('error', 'sam_busy'))
        self.assertEqual(r['error']['message'], 'SAM 3.1 is busy right now. Please try the same photo again in a minute.')
        self.assertNotBlamingThePhoto(r)
        self.assertEqual(r['objects'], [], 'no room from points alone while SAM was busy')
        self.assertIn('not looked for: mug (The Model API is busy); code traces around Muse Spark’s points for it instead', r['warnings'])
        self.assertIn('not looked for: coin (The Model API is busy)', r['warnings'])
        self.assertIn('not looked for: desk (the play surface; The Model API is busy); the full width below the horizon is used', r['warnings'])

    def test_unavailable(self):
        self.fake.on('/chat/completions', spark_answer(SEEDLESS))
        self.fake.always('/responses', ok_json({'error': {'code': 'down'}}, 503))
        r = self.pipe.run(photo())
        self.assertEqual(r['error']['code'], 'sam_unavailable')
        self.assertEqual(r['error']['message'], 'SAM 3.1 could not be reached just now. Please try the same photo again in a minute.')
        self.assertNotBlamingThePhoto(r)

    def test_unreadable(self):
        self.fake.on('/chat/completions', spark_answer(SEEDLESS))
        self.fake.always('/responses', sam_answer('garbage'))
        r = self.pipe.run(photo())
        self.assertEqual(r['error']['code'], 'sam_unreadable')
        self.assertEqual(r['error']['message'], "SAM 3.1 answered in a form this app could not read. This is the app's fault, not your photo's.")
        self.assertNotIn('clearer edges', r['error']['message'])

    def test_a_lasting_failure_says_its_own_words(self):
        self.fake.on('/chat/completions', spark_answer(SEEDLESS))
        self.fake.always('/responses', ok_json({'error': {'code': 'bad'}}, 400))
        r = self.pipe.run(photo())
        self.assertEqual(r['error']['code'], 'sam_error')
        self.assertEqual(r['error']['message'], 'The Model API could not accept this request. Please try another photo.')
        self.assertNotBlamingThePhoto(r)

    def test_a_lasting_failure_still_traces_around_the_points(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.fake.always('/responses', ok_json({'error': {'code': 'bad'}}, 400))
        r = self.pipe.run(photo())
        self.assertEqual(r['status'], 'ok', 'trying again would not help, so the points make the room')
        self.assertEqual([o['found_by'] for o in r['objects']], ['points'])

    def test_one_failed_call_among_good_ones(self):
        self.fake.on('/chat/completions', spark_answer(READ))

        def answer(req, handler):
            noun = req['body']['input'][0]['content'][0]['text']
            return ok_json({'error': {'code': 'rate_limited'}}, 429) if noun == 'cactus' else sam_answer(ANSWERS[noun])
        self.fake.always('/responses', answer)
        r = self.pipe.run(photo())
        self.assertEqual(r['status'], 'ok')
        self.assertIn('not looked for: cactus (The Model API is busy)', r['warnings'])
        self.assertIn('not found: lamp', r['warnings'], 'a clean empty answer is still "not found"')
        cactus = next(c for c in r['provenance']['calls'] if c.get('noun') == 'cactus')
        self.assertEqual((cactus['status'], cactus['error']), (429, 'rate_limited'))

    def test_a_clean_empty_answer_is_still_nothing_found(self):
        self.fake.on('/chat/completions', spark_answer(SEEDLESS))
        self.fake.always('/responses', sam_answer('<0f>\n'))
        r = self.pipe.run(photo())
        self.assertEqual(r['error']['code'], 'nothing_found')

    def test_an_account_problem_turns_the_picker_off(self):
        for spark, sam in ((latched('bad_key', 401), None), (None, latched('model_not_found', 404))):
            pipe = Pipeline(self.settings, Limits(), transport=Raising(spark, sam), sleep=lambda s: None)
            r = pipe.run(photo())
            self.assertEqual((r['status'], r['error']['code']), ('error', 'live_unavailable'))
            self.assertEqual(r['error']['status'], (spark or sam).status)
            self.assertTrue(r['error']['message'].endswith('the sample rooms still work.'))

    def test_never_more_than_four_sam_calls_at_once(self):
        import threading
        import time as time_
        self.fake.on('/chat/completions', spark_answer(READ))
        lock, now, most = threading.Lock(), [0], [0]
        order = []

        def answer(req, handler):
            noun = req['body']['input'][0]['content'][0]['text']
            with lock:
                order.append(noun)
                now[0] += 1
                most[0] = max(most[0], now[0])
            time_.sleep(0.05)
            with lock:
                now[0] -= 1
            return sam_answer(ANSWERS[noun])
        self.fake.always('/responses', answer)
        r = self.pipe.run(photo())
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(most[0], 4)
        self.assertEqual(set(order[:4]), {'box', 'coin', 'desk', 'cactus'}, 'the exit and the things to collect first')

    def test_what_was_found_is_kept_past_the_deadline(self):
        # G23: every call kept to the photo's time; a slow last answer does
        # not throw away the room
        t = [0.0]

        class Slow(recorded.RecordedTransport):
            def post(self, route, body, deadline, sleep=None, clock=None):
                out = super().post(route, body, deadline, sleep, clock)
                t[0] += config.PHOTO_TIMEOUT_S
                return out
        pipe = Pipeline(self.settings, Limits(), transport=Slow(), clock=lambda: t[0], sleep=lambda s: None)
        r = pipe.run(check_photo(images.jpeg(recorded.W, recorded.H), config.MAX_SIDE))
        self.assertEqual(r['status'], 'ok')


class SameAgain(WithFake):
    """A4: every error says in whole sentences what happened, and whether
    the same photo, sent again, could be read (error.retry_same)."""

    def check(self, spark, sam, code, retry_same):
        fake = FakeMeta()
        try:
            fake.always('/chat/completions', spark)  # retried answers stay the same
            fake.always('/responses', sam)
            pipe = Pipeline(settings_from({}, fake.base, 'desk'), Limits(), sleep=lambda s: None)
            r = pipe.run(photo())
        finally:
            fake.stop()
        e = r['error']
        self.assertEqual(e['code'], code)
        self.assertIs(e['retry_same'], retry_same, code)
        self.assertRegex(e['message'], r'^[A-Z].*[.!?]$', code)
        plain = re.sub(r'Model API|Muse Spark|SAM 3\.1|JSON', 'it', e['message'])
        self.assertNotRegex(plain, r'[a-z0-9)] [A-Z]', 'no sentence runs into the next: ' + e['message'])
        return r

    def test_each_error(self):
        empty = sam_answer('<0f>\n')
        cut = ok_json({'choices': [{'finish_reason': 'length', 'message': {'content': '{"objects": ['}}]})
        for spark, sam, code, again in (
                (ok_json({'error': {'code': 'slow_down'}}, 429), empty, 'slow_down', True),
                (ok_json({'error': {'code': 'oops'}}, 500), empty, 'oops', True),
                (ok_json({'error': {'code': 'bad'}}, 400), empty, 'bad', False),
                (cut, empty, 'cut_off', True),
                (ok_json({'choices': [{'finish_reason': 'stop', 'message': {'content': 'not json'}}]}), empty, 'malformed', True),
                (spark_answer(READ, finish='content_filter'), empty, 'content_filter', False),
                (spark_answer({**READ, 'people_present': True}), empty, 'people_present', False),
                (spark_answer(SEEDLESS), ok_json({'error': {'code': 'rate_limited'}}, 429), 'sam_busy', True),
                (spark_answer(SEEDLESS), ok_json({'error': {'code': 'down'}}, 502), 'sam_unavailable', True),
                (spark_answer(SEEDLESS), sam_answer('garbage'), 'sam_unreadable', False),
                (spark_answer(SEEDLESS), empty, 'nothing_found', False)):
            self.check(spark, sam, code, again)

    def test_the_people_words_say_what_counts(self):
        r = self.check(spark_answer({**READ, 'people_present': True}), sam_answer('<0f>\n'), 'people_present', False)
        self.assertIn('posters, screens, framed photos and mirrors', r['error']['message'])

    def test_an_ok_reply_has_no_error(self):
        self.fake.on('/chat/completions', spark_answer(READ))
        self.assertIsNone(self.pipe.run(photo())['error'])

    def test_busy_over_http_and_a_broken_read(self):
        self.assertTrue(Pipeline.failed_reply(self.pipe)['error']['retry_same'])
        self.assertEqual(reply_error({'code': 'busy', 'message': 'Wait a moment'}),
                         {'code': 'busy', 'message': 'Wait a moment.', 'retry_same': True})
        self.assertIs(reply_error({'code': 'hour_cap', 'message': 'Later.'})['retry_same'], False)


class RecordedDesk(unittest.TestCase):
    """The first live answers (10-27) for the desk sample picture, played
    back through the whole pipeline by a test double: nothing is sent."""

    def test_the_right_nine_objects(self):
        r = recorded.run()
        self.assertEqual(r['status'], 'ok', r.get('error'))
        got = sorted((o['name'], o['role']) for o in r['objects'])
        self.assertEqual(got, sorted([('gold coin', 'collect')] * 3 + [
            ('blue notebook', 'collect'), ('coffee mug', 'solid'), ('desk lamp', 'solid'),
            ('potted cactus', 'avoid'), ('book stack', 'solid'), ('cardboard box', 'exit')]))
        boxes = {(o['name'], o['instance']): o['box'] for o in r['objects']}
        self.assertEqual(boxes[('blue notebook', 1)], [293, 429, 477, 522], 'the notebook, not the book stack’s spine')
        self.assertEqual(sorted(b for (n, _), b in boxes.items() if n == 'gold coin'),
                         [[283, 444, 317, 465], [453, 332, 487, 353], [725, 552, 759, 573]])
        self.assertEqual(r['surface']['box'], [0, 319, 1024, 687])
        self.assertEqual([s['name'] for s in r['scene']['scenery']], ['picture frame'])

    def test_what_was_dropped_is_said(self):
        r = recorded.run()
        self.assertEqual(r['warnings'], ['not used: a match for blue notebook at 59% (none of Muse Spark’s points for it fell in it)'])
        self.assertEqual(r['provenance']['found'], {'sam': 9, 'points': 0, 'words': 'The stand-in for SAM 3.1 found 9.'})
        self.assertTrue(all(o['found_by'] == 'sam' for o in r['objects']))
        calls = {c.get('noun'): c for c in r['provenance']['calls'] if c['stage'] == 'find'}
        self.assertEqual((calls['blue notebook']['matches'], calls['blue notebook']['kept'], calls['blue notebook']['dropped']), (2, 1, ['no_point']))
        self.assertEqual((calls['gold coin']['matches'], calls['gold coin']['kept']), (3, 3))
        self.assertNotIn('diagnostics', calls['gold coin'], 'the real answers parse with no surprise')

    def test_the_log_line_for_the_recorded_desk(self):
        lines = []
        recorded.run(log=Log(stream=lines))
        found = json.loads(lines[-1])['found']
        self.assertEqual([(f['name'], f['matches'], f['kept']) for f in found], [
            ('desk', 1, 1), ('blue notebook', 2, 1), ('book stack', 1, 1), ('cardboard box', 1, 1), ('coffee mug', 1, 1),
            ('desk lamp', 1, 1), ('gold coin', 3, 3), ('potted cactus', 1, 1)])
        self.assertEqual(found[1].get('dropped'), ['no_point'])
        # on 10-27 this line would have read 0 kept for every name, with the
        # reader's codes beside them, and no capture would have been needed

    def test_a_surface_in_two_matches_is_one_box(self):
        # A3, through the pipeline: the desk answered as two patches
        two = samtext.compose([{'box': [0, 400, 499, 767], 'confidence': 0.8, 'payload': 'abc'},
                               {'box': [500, 380, 1023, 767], 'confidence': 0.7, 'payload': 'abc'}], recorded.W, recorded.H)
        r = recorded.run({'desk': two})
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(r['surface'], {'name': 'desk', 'box': [0, 380, 1024, 768], 'confidence': 0.8})
        desk = next(c for c in r['provenance']['calls'] if c.get('surface'))
        self.assertEqual((desk['matches'], desk['kept']), (2, 2))

    def test_one_box_is_never_two_objects(self):
        # SAM answers "coffee mug" with the lamp: the lamp holds Muse Spark's
        # lamp points, so it stays the lamp, and the mug is placed by its own
        # point instead
        r = recorded.run({'coffee mug': recorded.FIXTURE['answers']['desk lamp']})
        found = [(o['name'], o['found_by']) for o in r['objects'] if o['name'] in ('desk lamp', 'coffee mug')]
        self.assertEqual(found, [('coffee mug', 'points'), ('desk lamp', 'sam')])
        mug = next(o for o in r['objects'] if o['name'] == 'coffee mug')
        self.assertLess(iou(mug['box'], [161, 170, 298, 386]), 0.01, 'not on the lamp')
        self.assertIn('not used: a match for coffee mug at 82% (the same box was kept for the desk lamp)', r['warnings'])
        self.assertIn('not found by SAM 3.1: coffee mug; code traces around Muse Spark’s points for it instead', r['warnings'])


class DeskRead(recorded.RecordedTransport):
    """The recorded desk with another room read in place of Muse Spark's."""

    def __init__(self, read, answers=None):
        super().__init__(answers)
        self.read = read

    def post(self, route, body, deadline, sleep=None, clock=None):
        j, attempt, ms = super().post(route, body, deadline, sleep, clock)
        if route == '/chat/completions':
            j['choices'][0]['message']['content'] = json.dumps(self.read)
        return j, attempt, ms


def run_desk(change, answers=None):
    read = json.loads(json.dumps(recorded.FIXTURE['read']))
    change(read)
    pipe = Pipeline(settings_from({}, 'http://127.0.0.1:9/v1', 'desk'), Limits(), transport=DeskRead(read, answers),
                    sleep=lambda s: None)
    return pipe.run(check_photo(images.jpeg(recorded.W, recorded.H), config.MAX_SIDE))


def desk_answer(*matches):
    return samtext.compose([{'box': m[:4], 'confidence': m[4], 'payload': 'abc'} for m in matches], recorded.W, recorded.H)


def with_thing(name, seeds=()):
    """A change to the read: one more thing on the desk, in place of the
    picture frame (scenery; a read keeps 8 things)."""
    def change(read):
        read['objects'][-1] = {'name': name, 'role': 'solid', 'reason': 'x', 'on_surface': True,
                               'seeds': [{'x': x, 'y': y} for x, y in seeds]}
    return change


class MatchHygiene(unittest.TestCase):
    """A5, through the pipeline on the recorded desk."""

    def names(self, r):
        return sorted(o['name'] for o in r['objects'])

    def test_the_stray_notebook_match_without_points(self):
        def no_points(read):
            next(o for o in read['objects'] if o['name'] == 'blue notebook')['seeds'] = []
        r = run_desk(no_points)
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(self.names(r).count('blue notebook'), 1)
        self.assertEqual(self.names(r).count('gold coin'), 3)
        self.assertIn('not used: a match for blue notebook at 59% (its confidence was far under its best match’s)', r['warnings'])

    def test_a_match_inside_another_names_box_is_not_a_second_thing(self):
        def no_points(read):
            next(o for o in read['objects'] if o['name'] == 'blue notebook')['seeds'] = []
        r = run_desk(no_points, {'blue notebook': desk_answer((648, 283, 799, 311, 0.594))})
        self.assertNotIn('blue notebook', self.names(r))
        self.assertIn('not used: a match for blue notebook at 59% (it lies inside the book stack)', r['warnings'])
        self.assertIn('not found: blue notebook', r['warnings'])

    def test_the_surface_named_as_a_thing(self):
        r = run_desk(with_thing('desk'))
        self.assertEqual(r['status'], 'ok')
        self.assertNotIn('desk', self.names(r))
        self.assertIn('desk lamp', self.names(r), 'a desk lamp is a lamp')
        self.assertEqual(r['surface']['box'], [0, 319, 1024, 687])
        self.assertIn('not used: a match for desk at 79% (it is the play surface)', r['warnings'])

    def test_the_surface_named_as_a_thing_and_found_only_by_points(self):
        r = run_desk(with_thing('wooden desk', seeds=[(500, 600)]))
        self.assertNotIn('wooden desk', self.names(r))
        self.assertIn('not used: wooden desk (it is the play surface)', r['warnings'])

    def test_a_giant_thing_joins_the_surface(self):
        r = run_desk(with_thing('bed'), {'bed': desk_answer((0, 90, 1023, 767, 0.9))})
        self.assertEqual(r['status'], 'ok')
        self.assertNotIn('bed', self.names(r))
        self.assertEqual(r['surface'], {'name': 'desk', 'box': [0, 90, 1024, 768], 'confidence': 0.7852349281311035})
        self.assertIn('not used: a match for bed at 90% (it fills most of the picture, so it is part of the play surface)', r['warnings'])

    def test_a_giant_thing_is_the_surface_when_there_is_none(self):
        def no_surface(read):
            read['surface'] = {'name': ''}
            with_thing('bed')(read)
        r = run_desk(no_surface, {'bed': desk_answer((0, 90, 1023, 767, 0.9))})
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(r['surface'], {'name': 'bed', 'box': [0, 90, 1024, 768], 'confidence': 0.9})
        self.assertNotIn('bed', self.names(r))
        self.assertIn('not used: a match for bed at 90% (it fills most of the picture, so it is the play surface)', r['warnings'])
        self.assertFalse([w for w in r['warnings'] if 'the full width below the horizon' in w])

    def test_the_surface_found_by_its_namesake_when_sam_missed_it(self):
        r = run_desk(with_thing('wooden desk'),
                     {'desk': '<0f>\n', 'wooden desk': desk_answer((0, 319, 1023, 686, 0.8))})
        self.assertEqual(r['surface'], {'name': 'desk', 'box': [0, 319, 1024, 687], 'confidence': 0.8})
        self.assertNotIn('wooden desk', self.names(r))
        self.assertFalse([w for w in r['warnings'] if 'the full width below the horizon' in w])


DATA = Path(__file__).parent / 'data' / 'desk_1027'


class GoldenDesk(unittest.TestCase):
    """The real answers of 10-27 (server/tests/data/desk_1027, redacted),
    served whole by the loopback fake and read through the real transport
    and pipeline: the right room. (tests/recorded_desk.test.js builds and
    proves the same reply winnable.)"""

    def test_the_real_answers_make_the_right_room(self):
        saved = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(DATA.glob('*.json'))]
        read = next(s['answer'] for s in saved if s['route'] == '/chat/completions')
        by_noun = {s['noun']: s['answer'] for s in saved if s['route'] == '/responses'}
        self.assertEqual(len(by_noun), 8)
        fake = FakeMeta()
        try:
            fake.always('/chat/completions', ok_json(read))
            fake.always('/responses', lambda req, h: ok_json(by_noun[req['body']['input'][0]['content'][0]['text']]))
            pipe = Pipeline(settings_from({}, fake.base, 'desk'), Limits(), sleep=lambda s: None)
            r = pipe.run(check_photo(images.jpeg(recorded.W, recorded.H), config.MAX_SIDE))
        finally:
            fake.stop()
        self.assertEqual(r['status'], 'ok', r['error'])
        self.assertEqual(sorted((o['name'], o['role'], o['found_by']) for o in r['objects']), sorted(
            [('gold coin', 'collect', 'sam')] * 3 + [(n, role, 'sam') for n, role in (
                ('blue notebook', 'collect'), ('coffee mug', 'solid'), ('desk lamp', 'solid'),
                ('potted cactus', 'avoid'), ('book stack', 'solid'), ('cardboard box', 'exit'))]))
        boxes = {(o['name'], o['instance']): o['box'] for o in r['objects']}
        self.assertEqual(boxes[('blue notebook', 1)], [293, 429, 477, 522])
        self.assertEqual(sorted(b for (n, _), b in boxes.items() if n == 'gold coin'),
                         [[283, 444, 317, 465], [453, 332, 487, 353], [725, 552, 759, 573]])
        self.assertEqual(r['surface'], {'name': 'desk', 'box': [0, 319, 1024, 687], 'confidence': 0.7852349281311035})
        self.assertEqual(r['warnings'], ['not used: a match for blue notebook at 59% (none of Muse Spark’s points for it fell in it)'])
        finds = [c for c in r['provenance']['calls'] if c['stage'] == 'find']
        self.assertEqual((len(finds), {c['status'] for c in finds}), (8, {200}))
        self.assertFalse([c for c in finds if c.get('diagnostics')], 'the real answers parse with no surprise')
        self.assertIsNone(r['error'])


class Choosing(unittest.TestCase):
    def rec(self, i, box, c):
        return {'id': i, 'box': box, 'confidence': c, 'mask': None}

    def test_points_pick_their_matches(self):
        recs = [self.rec(0, [10, 10, 20, 20], 0.6), self.rec(1, [50, 50, 60, 60], 0.95), self.rec(2, [80, 10, 90, 20], 0.7)]
        kept, dropped = choose_matches(recs, [[15, 15], [92, 15]], 'collect', 100, 100)
        self.assertEqual([(r['id'], s) for r, s in kept], [(2, True), (0, True)], 'a point 2 px outside a box still counts; best first')
        self.assertEqual([(r['id'], why) for r, why in dropped], [(1, 'no_point')], 'the most confident match holds no point')

    def test_a_point_too_far_counts_for_nothing(self):
        recs = [self.rec(0, [10, 10, 20, 20], 0.9), self.rec(1, [50, 50, 60, 60], 0.45)]
        kept, dropped = choose_matches(recs, [[40, 40]], 'solid', 100, 100)
        self.assertEqual([r['id'] for r, _ in kept], [0], 'no point in any match: the most confident above the floor')
        self.assertEqual([(r['id'], why) for r, why in dropped], [(1, 'below_floor')])

    def test_the_role_caps_and_the_minimum(self):
        recs = [self.rec(k, [10 * k, 0, 10 * k + 5, 5], c) for k, c in enumerate((0.9, 0.88, 0.86, 0.85, 0.2))]
        kept, dropped = choose_matches(recs, [], 'collect', 100, 100)
        self.assertEqual([r['confidence'] for r, _ in kept], [0.9, 0.88, 0.86])
        self.assertEqual(sorted(why for _, why in dropped), ['low', 'over_count'])
        kept, _ = choose_matches(recs, [], 'exit', 100, 100)
        self.assertEqual(len(kept), 1)

    def test_point_regions(self):
        # a lamp's two points are one thing; three coins' points are three
        lamp = point_regions([[251, 211], [257, 373]], 'solid', 1024, 768)
        self.assertEqual(lamp, [([200, 160, 309, 425], [[251, 211], [257, 373]])])
        coins = point_regions([[469.0, 342.5], [328.7, 454.7], [770.0, 561.4]], 'collect', 1024, 768)
        self.assertEqual([len(g) for _, g in coins], [1, 1, 1])
        notebook = point_regions([[394.2, 474.6], [460.8, 472.3]], 'collect', 1024, 768)
        self.assertEqual(len(notebook), 1, 'points closer than 10% of the long side are one thing')
        edge = point_regions([[2, 3]], 'exit', 1024, 768)
        self.assertEqual(edge[0][0], [0, 0, 54, 55], 'held inside the picture')
        self.assertEqual(point_regions([], 'solid', 1024, 768), [])

    def test_the_surface_is_every_match_together(self):
        # A3: a floor split in two is one floor; a weak match is left out
        recs = [self.rec(0, [0, 400, 500, 768], 0.8), self.rec(1, [500, 380, 1024, 768], 0.7), self.rec(2, [0, 0, 50, 50], 0.2)]
        self.assertEqual(surface_from(recs), {'box': [0, 380, 1024, 768], 'confidence': 0.8, 'matches': 2})
        self.assertIsNone(surface_from([self.rec(0, [0, 0, 9, 9], 0.3)]))

    def test_a_far_weaker_extra_match_is_not_a_second_thing(self):
        # A5: with no point to go by, an extra match needs 75% of the best
        recs = [self.rec(0, [10, 10, 20, 20], 0.9), self.rec(1, [50, 50, 60, 60], 0.6)]
        kept, dropped = choose_matches(recs, [], 'collect', 100, 100)
        self.assertEqual(([r['id'] for r, _ in kept], [(r['id'], why) for r, why in dropped]), ([0], [(1, 'relative')]))
        kept, _ = choose_matches(recs, [[15, 15], [55, 55]], 'collect', 100, 100)
        self.assertEqual(len(kept), 2, 'a match Muse Spark pointed at is kept however weak')

    def test_one_thing_twice_under_one_name(self):
        recs = [self.rec(0, [10, 10, 30, 30], 0.9), self.rec(1, [11, 10, 31, 30], 0.88)]
        kept, dropped = choose_matches(recs, [], 'collect', 100, 100)
        self.assertEqual(([r['id'] for r, _ in kept], [(r['id'], why) for r, why in dropped]), ([0], [(1, 'twice')]))

    def test_a_match_inside_another_names_box(self):
        # the real stray "blue notebook" match on the book stack's spine
        stack = self.rec(0, [636, 262, 812, 346], 1.0)
        stray = self.rec(1, [648, 283, 800, 312], 0.594)
        coin = self.rec(2, [650, 300, 680, 320], 0.88)
        kept, lost = settle_claims([(0, 'book stack', stack, True), (1, 'blue notebook', stray, False), (2, 'gold coin', coin, True)])
        self.assertEqual(sorted(q[1] for q in kept), ['book stack', 'gold coin'], 'a coin Muse Spark pointed at stays on the books')
        self.assertEqual([(q[1], w, why) for q, w, why in lost], [('blue notebook', 'book stack', 'inside')])
        self.assertAlmostEqual(inside([0, 0, 10, 10], [5, 0, 20, 10]), 0.5)

    def test_boxes_are_held_to_the_picture(self):
        self.assertEqual(held([1000, 10, 1030, 40], 1024, 768), [1000, 10, 1024, 40])
        self.assertEqual(held([-3.4, -1, 20.6, 800], 1024, 768), [0, 0, 21, 768])
        self.assertIsNone(held([5, 5, 6, 40], 1024, 768), 'under 2 px wide')
        self.assertIsNone(held([1030, 5, 1090, 40], 1024, 768), 'wholly outside')
        self.assertIsNone(held(['x', 0, 1, 1], 1024, 768))

    def test_what_is_the_surface(self):
        self.assertIsNone(surface_like('desk lamp', [0, 0, 10, 10], 'desk', None, 100, 100), 'the last word only')
        self.assertEqual(surface_like('wooden desk', [0, 0, 10, 10], 'desk', None, 100, 100), 'named')
        self.assertEqual(surface_like('desks', [0, 0, 10, 10], 'desk', None, 100, 100), 'named')
        self.assertEqual(surface_like('bed', [0, 30, 100, 100], 'floor', None, 100, 100), 'giant', '70% of the picture')
        self.assertEqual(surface_like('table', [0, 50, 90, 90], 'tabletop', [5, 55, 85, 85], 100, 100), 'covers')
        self.assertIsNone(surface_like('rug', [0, 50, 40, 90], 'floor', [0, 50, 100, 100], 100, 100))

    def test_settle_claims(self):
        a = self.rec(0, [0, 0, 10, 10], 0.9)
        b = self.rec(0, [1, 0, 11, 10], 0.95)
        c = self.rec(1, [40, 40, 50, 50], 0.5)
        kept, lost = settle_claims([(0, 'mug', a, True), (1, 'cup', b, False), (1, 'cup', c, False)])
        self.assertEqual(sorted(q[1] for q in kept), ['cup', 'mug'], 'a point beats a higher confidence')
        self.assertEqual([(q[1], q[2]['box'], w, why) for q, w, why in lost], [('cup', [1, 0, 11, 10], 'mug', 'same_box')])
        self.assertAlmostEqual(iou([0, 0, 10, 10], [5, 0, 15, 10]), 1 / 3)


class Names(unittest.TestCase):
    def test_the_rules(self):
        self.assertIsNone(name_problem('desk lamp'))
        self.assertIsNone(name_problem("children's book".replace("children's", 'picture')))
        for bad in ('mug and coin', 'left mug', 'person', 'a very big red mug', 'mug, coin', 'hand', '', 'mug_2', 'mug!'):
            self.assertIsNotNone(name_problem(bad), bad)

    def test_common_nouns_pass(self):
        # A6: G12's names, wrongly dropped before
        for good in ('side table', 'front door', 'top hat', 'back pack', 'corner shelf', 'arm chair', 'hand towel',
                     'baby crib', '3d printer', 'café table', 'mug2', "dog's bed", 'x-ray film', 'crème brûlée'):
            self.assertIsNone(name_problem(normalize_name(good)), good)
        self.assertIsNone(name_problem(normalize_name('CAFÉ Table')), 'accents decomposed are composed first')
        self.assertEqual(normalize_name('Dog’s  Bed'), "dog's bed")
        self.assertEqual(normalize_name('CAFÉ Table'), 'café table', 'a decomposed accent is composed first')

    def test_relations_people_and_lists_still_go(self):
        for bad, why in (('left mug', 'a spatial word'), ('mug on desk', 'a spatial word'), ('cup under lamp', 'a spatial word'),
                         ('person', 'a people or body word'), ('hand', 'a people or body word'),
                         ('chair leg', 'a people or body word'), ('mug and plate', 'a list'), ('3', 'not a plain noun phrase'),
                         ("'mug", 'not a plain noun phrase'), ('mug  -', 'not a plain noun phrase')):
            self.assertEqual(name_problem(bad), why, bad)

    def test_when_every_name_is_dropped_the_photo_is_not_blamed(self):
        fake = FakeMeta()
        try:
            read = {**READ, 'objects': [{**o, 'name': 'left ' + o['name'].split()[-1]} for o in READ['objects']]}
            fake.on('/chat/completions', spark_answer(read))
            r = Pipeline(settings_from({}, fake.base, 'desk'), Limits(), sleep=lambda s: None).run(photo())
        finally:
            fake.stop()
        self.assertEqual(r['error'], {'code': 'names_unusable', 'retry_same': True, 'message':
                                      "Muse Spark's names for the things in this photo could not be used. Please try the same photo again."})
        self.assertEqual(fake.count('/responses'), 0)
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
            self.assertEqual(reply['error']['code'], 'live_unavailable', 'a refused key turns the picker off')
            self.assertEqual(reply['error']['status'], 401, 'the page tells a refused key by its status')
            self.assertEqual(reply['error']['message'],
                             "The Model API did not accept this server's key. The owner of this server must fix this; "
                             "the sample rooms still work.")
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
