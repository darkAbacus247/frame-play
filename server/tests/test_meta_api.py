import time
import unittest
from unittest import mock

from server import config
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
            (429, {'Retry-After': '2'}, 2, [2]),
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
            self.fake.on('/x', (status, headers, b'{"error": {"code": "drill", "message": "no"}}'), (status, headers, b'{}'))
            with self.assertRaises(CallError, msg=status) as c:
                self.post()
            self.assertEqual(len(self.fake.requests), sends, f'{status} {headers}')
            self.assertEqual(self.slept, sleeps, f'{status} {headers}')
            self.assertEqual(c.exception.status, status)

    def test_a_retry_can_succeed(self):
        self.fake.on('/x', (500, {}, b''), ok_json({'ok': 2}))
        j, attempt, _ = self.post()
        self.assertEqual((j, attempt), ({'ok': 2}, 2))

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
        self.assertLess(time.monotonic() - t0, 1.5, 'the timer covers the trickling body, not just each read')

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
