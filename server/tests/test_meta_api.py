import json
import time
import unittest
from unittest import mock

from server import config, meta_api
from server.config import KeyHolder
from server.meta_api import CallError, Transport, retry_after_seconds
from server.tests.fakemeta import FakeMeta, ok_json
from server.tests.test_config import TEST_VALUE


class Pinning(unittest.TestCase):
    def test_only_the_api_or_loopback(self):
        k = KeyHolder(TEST_VALUE)
        Transport(config.API_BASE, k)
        Transport('http://127.0.0.1:9/v1', config.REHEARSAL_CREDENTIAL)
        for base in ('https://api.meta.ai/v2', 'https://evil.example/v1', 'http://api.meta.ai/v1', 'http://10.1.1.1:9/v1'):
            with self.assertRaises(ValueError, msg=base):
                Transport(base, k)
        with self.assertRaises(ValueError):
            Transport(config.API_BASE, config.REHEARSAL_CREDENTIAL)  # the live address needs the key holder
        with self.assertRaises(ValueError):
            Transport('http://127.0.0.1:9/v1', 'some-other-string')


class AgainstAFake(unittest.TestCase):
    def setUp(self):
        self.fake = FakeMeta()
        self.t = Transport(self.fake.base, KeyHolder(TEST_VALUE))
        self.slept = []

    def tearDown(self):
        self.fake.stop()

    def post(self, route='/x'):
        return self.t.post(route, {'a': 1}, time.monotonic() + 30, sleep=self.slept.append)

    def test_the_bearer_token_goes_only_to_the_base(self):
        self.fake.on('/x', ok_json({'ok': True}))
        j, attempt, _ = self.post()
        self.assertEqual((j, attempt), ({'ok': True}, 1))
        self.assertEqual(self.fake.requests[0]['headers']['Authorization'], 'Bearer ' + TEST_VALUE)
        self.assertEqual(self.fake.requests[0]['path'], '/v1/x')

    def test_redirects_are_never_followed(self):
        self.fake.on('/x', (302, {'Location': 'http://127.0.0.1:1/steal'}, b''))
        with self.assertRaises(CallError) as c:
            self.post()
        self.assertEqual(c.exception.code, 'redirect')
        self.assertEqual(len(self.fake.requests), 1)

    def test_retry_table(self):
        cases = [
            (429, {'Retry-After': '2'}, 3, [2, 2]),
            (429, {}, 3, [1, 2]),
            (500, {}, 2, []),
            (502, {}, 2, []),
            (503, {'Retry-After': '3'}, 2, [3]),
            (503, {'Retry-After': '10'}, 1, []),
            (503, {}, 1, []),
            (400, {}, 1, []), (401, {}, 1, []), (402, {}, 1, []), (403, {}, 1, []),
            (404, {}, 1, []), (413, {}, 1, []), (504, {}, 1, []),
        ]
        for status, headers, sends, sleeps in cases:
            self.fake.requests.clear()
            self.slept.clear()
            self.fake.script.clear()
            self.fake.on('/x', (status, headers, b'{"error": {"code": "drill", "message": "no"}}'), (status, headers, b'{}'),
                         (status, headers, b'{}'))
            with self.assertRaises(CallError, msg=status) as c:
                self.post()
            self.assertEqual(len(self.fake.requests), sends, f'{status} {headers}')
            self.assertEqual(self.slept, sleeps, f'{status} {headers}')
            self.assertEqual(c.exception.status, status)
            self.assertEqual(c.exception.transient, status in (429, 500, 502, 503, 504), status)
            self.assertTrue(c.exception.message.endswith('.'), status)

    def test_a_retry_can_succeed(self):
        self.fake.on('/x', (500, {}, b''), ok_json({'ok': 2}))
        j, attempt, _ = self.post()
        self.assertEqual((j, attempt), ({'ok': 2}, 2))

    def test_a_429_may_be_retried_twice(self):
        self.fake.on('/x', (429, {}, b''), (429, {}, b''), ok_json({'ok': 3}))
        j, attempt, _ = self.post()
        self.assertEqual((j, attempt, self.slept), ({'ok': 3}, 3, [1, 2]))

    def test_a_second_429_retry_waits_only_while_time_remains(self):
        self.fake.on('/x', (429, {'Retry-After': '2'}, b''), (429, {'Retry-After': '2'}, b''), ok_json({'ok': 3}))
        clock = [0.0]

        def sleep(s):
            clock[0] += s
        with self.assertRaises(CallError) as c:
            self.t.post('/x', {}, 4.5, sleep=sleep, clock=lambda: clock[0])
        self.assertEqual((c.exception.attempt, len(self.fake.requests)), (2, 2), 'no wait past the photo deadline')

    def test_an_empty_404_body_is_handled(self):
        self.fake.on('/x', (404, {}, b''))
        with self.assertRaises(CallError) as c:
            self.post()
        self.assertEqual((c.exception.code, c.exception.status), ('http_404', 404))

    def test_malformed_answers_are_not_retried_and_keep_a_redacted_excerpt(self):
        self.fake.on('/x', (200, {}, ('not json, and here is ' + TEST_VALUE + ' ' + 'x' * 900).encode()))
        with self.assertRaises(CallError) as c:
            self.post()
        self.assertEqual(c.exception.code, 'malformed')
        self.assertFalse(c.exception.transient)
        self.assertEqual(len(self.fake.requests), 1)
        self.assertLessEqual(len(c.exception.excerpt), 300)
        self.assertNotIn(TEST_VALUE, c.exception.excerpt)

    def test_the_whole_answer_timer(self):
        def slow(req, handler):
            handler.send_response(200)
            handler.send_header('Content-Length', '1000')
            handler.end_headers()
            for _ in range(40):
                try:
                    handler.wfile.write(b' ')
                    handler.wfile.flush()
                except OSError:
                    return None
                time.sleep(0.05)
            return None
        self.fake.always('/x', slow)
        t0 = time.monotonic()
        with self.assertRaises(CallError) as c:
            self.t.post_once('/x', {}, 0.4)
        self.assertEqual(c.exception.code, 'timeout')
        self.assertTrue(c.exception.transient)
        self.assertEqual(c.exception.message, 'The Model API did not answer in time. Please try the same photo again.')
        self.assertLess(time.monotonic() - t0, 1.5, 'the timer covers the trickling body, not just each read')

    def test_a_room_read_that_timed_out_is_sent_once(self):
        def stall(req, handler):
            time.sleep(0.6)
            return None  # never answers within the timer
        self.fake.always('/chat/completions', stall)
        self.fake.always('/responses', stall)
        with mock.patch.object(config, 'SPARK_TIMEOUT_S', 0.2), mock.patch.object(config, 'CALL_TIMEOUT_S', 0.2):
            for route, sends in (('/chat/completions', 1), ('/responses', 2)):
                with self.assertRaises(CallError, msg=route) as c:
                    self.post(route)
                self.assertEqual(c.exception.code, 'timeout')
                self.assertTrue(c.exception.transient)
                self.assertEqual(self.fake.count(route), sends, route)
            with self.assertRaises(CallError):
                self.t.post('/chat/completions', {}, time.monotonic() + 30, sleep=self.slept.append, retry_timeout=True)
            self.assertEqual(self.fake.count('/chat/completions'), 3, 'the caller may ask for the retry')

    def test_the_room_read_has_its_own_timer(self):
        used = []
        real = self.t.post_once

        def spy(route, body, timeout):
            used.append((route, timeout))
            return real(route, body, timeout)
        self.t.post_once = spy
        self.fake.always('/chat/completions', ok_json({}))
        self.fake.always('/responses', ok_json({}))
        for route in ('/chat/completions', '/responses'):
            self.t.post(route, {}, time.monotonic() + 100)
        self.assertEqual(used,[('/chat/completions', config.SPARK_TIMEOUT_S), ('/responses', config.CALL_TIMEOUT_S)])
        self.assertEqual((config.SPARK_TIMEOUT_S, config.CALL_TIMEOUT_S), (30.0, 20.0))

    def test_answer_caps(self):
        self.fake.always('/x', ok_json({'pad': 'x' * 5000}))
        with mock.patch.object(config, 'MAX_ANSWER_BYTES', 1000):
            with self.assertRaises(CallError) as c:
                self.t.post_once('/x', {}, 5)
        self.assertEqual(c.exception.code, 'too_large')
        self.fake.always('/x', (500, {}, b'e' * 5000))
        with mock.patch.object(config, 'MAX_ERROR_BYTES', 100):
            with self.assertRaises(CallError) as c:
                self.t.post_once('/x', {}, 5)
        self.assertEqual(c.exception.code, 'too_large')

    def test_a_short_answer_is_a_network_error(self):
        def short(req, handler):
            handler.send_response(200)
            handler.send_header('Content-Length', '500')
            handler.end_headers()
            handler.wfile.write(b'{"partial":')
            handler.close_connection = True
            return None
        self.fake.always('/x', short)
        with self.assertRaises(CallError) as c:
            self.t.post_once('/x', {}, 5)
        self.assertIn(c.exception.code, ('network', 'malformed'))
        self.assertTrue(c.exception.retryable or c.exception.code == 'malformed')


class Words(unittest.TestCase):
    def test_every_failure_is_whole_sentences(self):
        texts = list(meta_api.WORDS.values()) + [
            meta_api.TIMEOUT_WORDS, meta_api.NETWORK_WORDS, meta_api.OUT_OF_TIME_WORDS, meta_api.REDIRECT_WORDS,
            meta_api.TOO_LARGE_WORDS, meta_api.MALFORMED_WORDS, meta_api.QUOTA_WORDS, meta_api.LIVE_UNAVAILABLE,
            meta_api.CONTRIBUTOR_WORDS, meta_api.other_status_words(418), meta_api.other_status_words(599)]
        for text in texts:
            self.assertTrue(text.endswith('.'), text)
            self.assertRegex(text, r'^[A-Z]', text)
            self.assertNotRegex(text, r'[a-z] [A-Z][a-z]+ [a-z]', 'no sentence runs into the next: ' + text)

    def test_the_advice_fits_the_fault(self):
        for status in (429, 500, 502, 503, 504):
            self.assertIn('same photo again', meta_api.WORDS[status], status)
        for status in (401, 402, 403, 404):
            self.assertIn('owner', meta_api.WORDS[status], status)
            self.assertIn('sample rooms still work', meta_api.WORDS[status], status)
        self.assertIn('owner', meta_api.QUOTA_WORDS)
        self.assertIn('same photo again', meta_api.TIMEOUT_WORDS)

    def test_transient_means_a_passing_fault(self):
        for status, quota, want in ((429, False, True), (429, True, False), (500, False, True), (503, False, True),
                                    (504, False, True), (400, False, False), (401, False, False), (402, False, False),
                                    (404, False, False), (413, False, False)):
            self.assertEqual(meta_api.is_transient(status, quota), want, (status, quota))
        self.assertFalse(CallError('x', 'y.').transient, 'absent means not transient')


class Latch(unittest.TestCase):
    """Account or model problems mark the transport broken."""

    def setUp(self):
        self.fake = FakeMeta()
        self.t = Transport(self.fake.base, KeyHolder(TEST_VALUE))
        self.clock = [1000.0]
        self.t.now = lambda: self.clock[0]

    def tearDown(self):
        self.fake.stop()

    def post(self, route='/responses'):
        return self.t.post(route, {'a': 1}, time.monotonic() + 30, sleep=lambda s: None)

    def fail(self, route, status, code=None):
        self.fake.script.clear()
        body = json.dumps({'error': {'code': code, 'message': 'no'}}).encode() if code else b''
        self.fake.on(route, *[(status, {}, body)] * 3)  # the same again for each retry
        with self.assertRaises(CallError) as c:
            self.post(route)
        return c.exception

    def test_account_and_model_problems_trip_it(self):
        for status, route, code in ((401, '/x', None), (402, '/responses', 'payment_required'), (403, '/x', None),
                                    (404, '/chat/completions', None), (404, '/x', 'model_not_found'),
                                    (429, '/responses', 'insufficient_quota')):
            self.t.broken = None
            e = self.fail(route, status, code)
            self.assertTrue(e.latched, (status, route, code))
            self.assertIsNotNone(self.t.broken, (status, route, code))
            self.assertEqual(self.t.live_state()[0], 'unavailable')
            self.assertNotIn(TEST_VALUE, json.dumps(self.t.broken))

    def test_passing_faults_do_not(self):
        for status, route, code in ((404, '/x', None), (429, '/responses', 'rate_limited'), (500, '/responses', None),
                                    (400, '/responses', None), (503, '/responses', None)):
            e = self.fail(route, status, code)
            self.assertFalse(e.latched, (status, route, code))
            self.assertIsNone(self.t.broken, (status, route, code))
            self.assertEqual(self.t.live_state(), ('ok', None, 0))

    def test_a_quota_429_is_not_retried(self):
        self.fake.on('/responses', ok_json({'error': {'code': 'insufficient_quota'}}, 429), ok_json({'ok': 1}))
        with self.assertRaises(CallError) as c:
            self.post()
        self.assertEqual(self.fake.count('/responses'), 1)
        self.assertFalse(c.exception.retryable)
        self.assertIn('quota', c.exception.message)

    def test_the_hold_then_one_photo_checks_again(self):
        self.assertEqual(self.t.claim(), 'open')
        self.fail('/responses', 401)
        self.assertIsNone(self.t.claim(), 'held: nothing may be sent')
        state, words, wait = self.t.live_state()
        self.assertEqual((state, wait), ('unavailable', 600))
        self.assertTrue(words)
        self.clock[0] += config.LIVE_HOLD_S
        self.assertEqual(self.t.live_state()[0], 'ok', 'after the hold the picker may come back')
        self.assertEqual(self.t.claim(), 'probe')
        self.assertIsNone(self.t.claim(), 'one photo checks at a time')
        self.assertEqual(self.t.live_state()[0], 'unavailable')
        self.fake.script.clear()
        self.fake.on('/responses', ok_json({'ok': True}))
        self.post()
        self.t.release()
        self.assertIsNone(self.t.broken, 'an answer that is not an error clears it')
        self.assertEqual(self.t.claim(), 'open')

    def test_a_failed_check_holds_again(self):
        self.fail('/responses', 403)
        self.clock[0] += config.LIVE_HOLD_S + 1
        self.assertEqual(self.t.claim(), 'probe')
        self.fail('/responses', 403)
        self.t.release()
        self.assertIsNone(self.t.claim())
        self.assertEqual(self.t.live_state()[2], 600)

    def test_a_billing_or_credit_refusal_stops_live_for_the_utc_day(self):
        day = 1_800_000_000 - 1_800_000_000 % 86400
        wall = [day + 3600.0]  # 01:00 UTC
        self.t.wall = lambda: wall[0]
        for status, code in ((402, 'payment_required'), (429, 'insufficient_quota'), (403, 'insufficient_credits'),
                             (401, 'billing_not_active')):
            self.t.broken = None
            e = self.fail('/responses', status, code)
            self.assertTrue(e.latched, (status, code))
            state, words, wait = self.t.live_state()
            self.assertEqual((state, words, wait), ('unavailable', meta_api.DAY_STOP_WORDS, 23 * 3600), (status, code))
            self.assertEqual(self.t.refusal_words(), meta_api.DAY_STOP_WORDS)
        self.clock[0] += config.LIVE_HOLD_S + 1  # the ten minutes pass: still stopped for the day
        self.assertIsNone(self.t.claim())
        self.assertEqual(self.t.live_state()[0], 'unavailable')
        wall[0] = day + 86400  # midnight UTC: one photo may check again
        self.assertEqual(self.t.live_state()[0], 'ok')
        self.assertEqual(self.t.claim(), 'probe')
        self.t.release()
        # a refused key or a lost model is not a billing stop: the ten-minute hold
        self.t.broken = None
        self.fail('/responses', 401, 'invalid_api_key')
        self.assertEqual(self.t.live_state()[2], 600)
        self.assertEqual(self.t.refusal_words(), meta_api.LIVE_UNAVAILABLE)
        self.assertIn('sample rooms still work', meta_api.DAY_STOP_WORDS)

    def test_rehearsal_drills_do_not_latch(self):
        t = Transport(self.fake.base, config.REHEARSAL_CREDENTIAL)
        self.assertFalse(t.latching)
        self.fake.on('/responses', (401, {}, b''))
        with self.assertRaises(CallError) as c:
            t.post('/responses', {}, time.monotonic() + 30, sleep=lambda s: None)
        self.assertFalse(c.exception.latched)
        self.assertEqual(t.claim(), 'open')


class StandardModelsOnly(unittest.TestCase):
    """Meta's API Terms: a request may be routed to a Contributor Model, and
    the operator must make sure it uses the kind it means to. This app uses
    Standard models only (server/config.py refuses to start with another id),
    so an answer naming a Contributor Model is refused whole."""

    def setUp(self):
        self.fake = FakeMeta()
        self.t = Transport(self.fake.base, KeyHolder(TEST_VALUE))
        self.word = '-contri' + 'butor'  # split so that no file names a Contributor model

    def tearDown(self):
        self.fake.stop()

    def post(self, route):
        return self.t.post(route, {'model': 'muse-spark-1.3', 'a': 1}, time.monotonic() + 30, sleep=lambda s: None)

    def test_an_answer_naming_a_contributor_model_is_refused_and_none_of_it_is_used(self):
        answer = {'id': 'chatcmpl-x', 'model': 'muse-spark-1.3' + self.word, 'choices': [{'message': {'content': 'secret'}}]}
        for route in ('/chat/completions', '/responses', '/images/edits'):
            self.fake.on(route, ok_json(answer), ok_json(answer))
            with self.assertRaises(CallError, msg=route) as c:
                self.post(route)
            e = c.exception
            self.assertEqual((e.code, e.message), ('live_unavailable', meta_api.CONTRIBUTOR_WORDS), route)
            self.assertEqual(e.message, 'Meta answered with a Contributor Model, which this app does not use.')
            self.assertFalse(e.retryable or e.transient, route)
            self.assertIsNone(e.excerpt, 'nothing of the answer is kept')
            self.assertNotIn('secret', str(vars(e)))
            self.assertEqual(self.fake.count(route), 1, 'not sent again')
        self.assertIsNone(self.t.broken, 'a routing answer is not an account problem')

    def test_an_answer_naming_the_requested_model_passes(self):
        answer = {'id': 'chatcmpl-x', 'model': 'muse-spark-1.3', 'choices': []}
        self.fake.on('/chat/completions', ok_json(answer))
        j, attempt, _ = self.post('/chat/completions')
        self.assertEqual((j, attempt), (answer, 1))
        # the other shapes an answer takes: no model field, the stand-in's label, not an object
        for a in ({'ok': 1}, {'model': 'REHEARSAL stand-in for sam-3.1'}, {'model': None}, [1, 2], 'x'):
            meta_api.check_answer_model(a)
        with self.assertRaises(CallError):
            meta_api.check_answer_model({'model': 'SAM-3.1' + self.word.upper()})


class RetryAfter(unittest.TestCase):
    def test_seconds_and_dates(self):
        self.assertEqual(retry_after_seconds('3'), 3)
        now = 1_800_000_000
        date = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(now + 7))
        self.assertEqual(retry_after_seconds(date, now=now), 7)
        past = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime(now - 50))
        self.assertEqual(retry_after_seconds(past, now=now), 0, 'a wait below zero is no wait')
        self.assertIsNone(retry_after_seconds('soon'))
        self.assertIsNone(retry_after_seconds(None))


if __name__ == '__main__':
    unittest.main()
