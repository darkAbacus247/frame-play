import contextlib
import http.client
import io
import json
import select
import socket
import threading
import time
import unittest
from unittest import mock

from server import config
from server.config import KeyHolder, Settings, settings_from
from server.limits import Limits
from server.meta_api import Transport
from server.pipeline import Pipeline
from server.server import CSP, FramePlayServer, Handler, Log, build_server, error_body, is_loopback, main, sentence, static_file
from server.tests import images
from server.tests.fakemeta import FakeMeta, ok_json
from server.tests.test_config import TEST_VALUE


class Running:
    """A FRAME//PLAY server on a free loopback port, for one test class."""

    def __init__(self, settings, pipeline=None, limits=None, use_build=False, public=False):
        self.lines = []
        log = Log(stream=self.lines, holder=settings.key)
        if use_build:
            self.srv = build_server(settings, '127.0.0.1', 0, log=log, public=public)
        else:
            self.srv = FramePlayServer(('127.0.0.1', 0), settings, log=log, pipeline=pipeline, limits=limits, public=public)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            data = r.read()
            return r.status, dict(r.getheaders()), data
        finally:
            c.close()

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


class MockRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.run_ = Running(settings_from({}), use_build=True)

    @classmethod
    def tearDownClass(cls):
        cls.run_.stop()

    def test_the_page_and_its_files_only(self):
        for path in ('/', '/index.html', '/app.js', '/styles.css', '/favicon.svg', '/src/level.js', '/rooms/desk.json'):
            status, headers, body = self.run_.request('GET', path)
            self.assertEqual(status, 200, path)
            self.assertGreater(len(body), 10)
        for path in ('/server/server.py', '/tests/level.test.js', '/README.md', '/.git/config', '/src/../server/config.py',
                     '/src/level.mjs', '/rooms/../package.json', '/%2e%2e/LICENSE', '/package.json', '/src/Level.js'):
            status, _, _ = self.run_.request('GET', path)
            self.assertEqual(status, 404, path)

    def test_headers(self):
        status, h, _ = self.run_.request('GET', '/')
        self.assertEqual(h['Content-Security-Policy'], CSP)
        self.assertEqual(h['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(h['Referrer-Policy'], 'no-referrer')
        self.assertTrue(h['Content-Type'].startswith('text/html'))
        _, h, _ = self.run_.request('GET', '/src/level.js')
        self.assertTrue(h['Content-Type'].startswith('text/javascript'))

    def test_only_a_hugging_face_space_page_may_frame_the_game(self):
        # the Space page on huggingface.co shows the app's *.hf.space address in a frame
        for method, path in (('GET', '/'), ('GET', '/app.js'), ('GET', '/rooms/kitchen.jpg'),
                             ('GET', '/api/health'), ('GET', '/nothing'), ('HEAD', '/')):
            _, h, _ = self.run_.request(method, path)
            directives = [d.strip() for d in h['Content-Security-Policy'].split(';')]
            framing = [d for d in directives if d.startswith('frame-ancestors')]
            self.assertEqual(framing, ['frame-ancestors https://huggingface.co https://*.hf.space'], path)
            # X-Frame-Options cannot name a site: sent at all, it would refuse the Space page
            self.assertNotIn('X-Frame-Options', h, path)

    def test_health_in_mock_mode(self):
        status, h, body = self.run_.request('GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(h['Cache-Control'], 'no-store')
        j = json.loads(body)
        self.assertEqual(j['mode'], 'mock')
        self.assertEqual(j['key'], 'absent')
        self.assertEqual(j['models'], {'read': 'muse-spark-1.3', 'find': 'sam-3.1'})
        self.assertEqual(j['models_called'], [])
        self.assertEqual(j['outline_source'], 'traced_in_box')
        self.assertEqual(j['ceilings']['usd_stop_per_day'], 5.0)
        self.assertEqual(j['ceilings']['sam_calls_per_photo'], 12)
        self.assertEqual((j['ceilings']['photos_in_flight'], j['ceilings']['photos_per_hour']), (4, 120))
        self.assertEqual((j['ceilings']['seconds_per_socket_wait'], j['ceilings']['seconds_per_upload']), (15.0, 40.0))
        self.assertEqual(j['live_state'], 'off')

    def test_room_in_mock_mode_is_409_in_words(self):
        status, _, body = self.run_.request('POST', '/api/room', images.jpeg(), {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg'})
        self.assertEqual(status, 409)
        j = json.loads(body)
        self.assertEqual(j['error']['code'], 'live_off')
        self.assertIn('MOCK', j['error']['message'])

    def test_the_request_header_and_cross_site(self):
        status, _, _ = self.run_.request('POST', '/api/room', images.jpeg(), {'Content-Type': 'image/jpeg'})
        self.assertEqual(status, 403)
        status, _, _ = self.run_.request('POST', '/api/room', images.jpeg(), {'X-FramePlay-Request': '1', 'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(status, 403)

    def test_methods(self):
        self.assertEqual(self.run_.request('GET', '/api/room')[0], 405)
        self.assertEqual(self.run_.request('POST', '/api/health')[0], 405)
        self.assertEqual(self.run_.request('DELETE', '/')[0], 405)
        self.assertEqual(self.run_.request('PUT', '/nothing')[0], 404)
        self.assertEqual(self.run_.request('POST', '/api/other', b'x', {'X-FramePlay-Request': '1'})[0], 404)

    def test_every_refusal_is_whole_sentences(self):
        answers = [self.run_.request('GET', '/nothing'), self.run_.request('GET', '/api/room'),
                   self.run_.request('POST', '/api/health'),
                   self.run_.request('POST', '/api/room', images.jpeg(), {'Content-Type': 'image/jpeg'}),
                   self.run_.request('POST', '/api/room', images.jpeg(), {'X-FramePlay-Request': '1'})]
        for status, _, body in answers:
            msg = json.loads(body)['error']['message']
            self.assertTrue(msg.endswith('.'), (status, msg))
        self.assertEqual(sentence('The photo is odd'), 'The photo is odd.')
        self.assertEqual(sentence('Already whole. '), 'Already whole.')
        self.assertEqual(error_body('x', 'No period')['error']['message'], 'No period.')

    def test_logs_never_hold_the_address_or_headers(self):
        self.run_.request('GET', '/api/health', headers={'User-Agent': 'secret-agent', 'Cookie': 'c=1'})
        line = json.loads(self.run_.lines[-1])
        self.assertEqual(set(line), {'t', 'method', 'path', 'status'})
        self.assertEqual((line['method'], line['path'], line['status']), ('GET', '/api/health', 200))
        text = '\n'.join(self.run_.lines)
        self.assertNotIn('127.0.0.1', text)
        self.assertNotIn('secret-agent', text)


class PhotoChecks(unittest.TestCase):
    """Rehearsal mode, with no pipeline attached: the checks before any call."""

    @classmethod
    def setUpClass(cls):
        cls.run_ = Running(settings_from({}, 'http://127.0.0.1:9/v1'))

    @classmethod
    def tearDownClass(cls):
        cls.run_.stop()

    def post(self, body, **headers):
        h = {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg', **headers}
        return self.run_.request('POST', '/api/room', body, h)

    def test_types_and_sizes(self):
        self.assertEqual(self.post(b'GIF89a' + b'\x00' * 40)[0], 415)
        self.assertEqual(self.post(images.png(5000, 4))[0], 415)
        status, _, body = self.post(images.jpeg())
        self.assertEqual(status, 503, 'passes every check; no pipeline in this test')

    def test_over_the_cap_is_413_without_reading(self):
        c = http.client.HTTPConnection('127.0.0.1', self.run_.port, timeout=10)
        c.putrequest('POST', '/api/room')
        c.putheader('X-FramePlay-Request', '1')
        c.putheader('Content-Length', str(config.MAX_BODY + 1))
        c.endheaders()
        r = c.getresponse()
        self.assertEqual(r.status, 413)
        c.close()

    def test_health_says_rehearsal(self):
        j = json.loads(self.run_.request('GET', '/api/health')[2])
        self.assertEqual(j['mode'], 'rehearsal')
        self.assertEqual(j['label'], 'REHEARSAL · local stand-in, not Meta')
        self.assertEqual(j['rehearsal']['stand_in_base'], 'http://127.0.0.1:9/v1')
        self.assertEqual(j['key'], 'absent')


class LiveUnavailable(unittest.TestCase):
    """After an account or model problem, no photo is sent until a check succeeds."""

    def setUp(self):
        self.fake = FakeMeta()
        s = settings_from({}, self.fake.base, 'desk')
        self.transport = Transport(self.fake.base, config.REHEARSAL_CREDENTIAL)
        self.clock = [5000.0]
        self.transport.now = lambda: self.clock[0]
        self.transport.latching = True  # as with the owner's key
        # as build_server makes them in rehearsal: no client is held to its own ceilings
        self.pipe = Pipeline(s, Limits(clients=False), log=Log(stream=[]), transport=self.transport, sleep=lambda x: None)
        self.run_ = Running(s, pipeline=self.pipe, limits=self.pipe.limits)
        self.pipe.log = self.run_.srv.log

    def tearDown(self):
        self.run_.stop()
        self.fake.stop()

    def post(self):
        status, h, body = self.run_.request('POST', '/api/room', images.jpeg(), {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg'})
        return status, h, json.loads(body)

    def health(self):
        return json.loads(self.run_.request('GET', '/api/health')[2])

    def test_one_refusal_stops_every_further_call(self):
        self.assertEqual((self.health()['live_state'], self.health()['live_reason']), ('ok', None))
        self.fake.always('/chat/completions', ok_json({'error': {'code': 'invalid_api_key'}}, 401))
        status, _, first = self.post()
        self.assertEqual((status, first['status']), (200, 'error'))
        self.assertEqual(self.fake.count('/chat/completions'), 1)
        for _ in range(3):
            status, h, j = self.post()
            self.assertEqual(status, 503)
            self.assertEqual(j['error']['code'], 'live_unavailable')
            self.assertIn('sample rooms still work', j['error']['message'])
            self.assertEqual(h['Retry-After'], '600')
        self.assertEqual(len(self.fake.requests), 1, 'nothing more was sent to the Model API')
        hl = self.health()
        self.assertEqual(hl['mode'], 'rehearsal')
        self.assertEqual(hl['live_state'], 'unavailable')
        self.assertTrue(hl['live_reason'].endswith('.'))
        self.assertEqual(hl['live_check_again_s'], 600)
        self.assertEqual(self.pipe.limits.counters()['photos_this_hour'], 1, 'a held photo is not counted')

    def test_after_the_hold_one_photo_checks_again_and_a_good_answer_clears_it(self):
        self.fake.always('/chat/completions', ok_json({'error': {'code': 'payment_required'}}, 402))
        self.post()
        self.clock[0] += config.LIVE_HOLD_S
        self.assertEqual(self.health()['live_state'], 'ok')
        self.post()  # the check fails: held again
        self.assertEqual(self.fake.count('/chat/completions'), 2)
        self.assertEqual(self.post()[0], 503)
        self.assertEqual(self.fake.count('/chat/completions'), 2)
        self.clock[0] += config.LIVE_HOLD_S
        self.fake.always('/chat/completions', ok_json({'choices': []}))  # an answer, if not a read
        status, _, j = self.post()
        self.assertEqual((status, j['status']), (200, 'error'))
        self.assertEqual(self.health()['live_state'], 'ok')
        self.assertIsNone(self.transport.broken)
        self.assertFalse(self.transport.probing, 'the check is released after its photo')
        self.post()
        self.assertEqual(self.fake.count('/chat/completions'), 4, 'photos flow again')

    def test_mock_says_off_and_a_server_without_a_pipeline_says_ok(self):
        srv = FramePlayServer(('127.0.0.1', 0), settings_from({}), log=Log(stream=[]))
        try:
            self.assertEqual(srv.health()['live_state'], 'off')
        finally:
            srv.server_close()
        srv = FramePlayServer(('127.0.0.1', 0), settings_from({}, 'http://127.0.0.1:9/v1'), log=Log(stream=[]))
        try:
            self.assertEqual(srv.health()['live_state'], 'ok')
        finally:
            srv.server_close()


class PerClient(unittest.TestCase):
    """Each client is held to its own photos an hour, on top of the server's."""

    def serve(self, public):
        s = settings_from({}, 'http://127.0.0.1:9/v1', 'desk')
        pipe = Pipeline(s, Limits(), log=Log(stream=[]), sleep=lambda x: None)
        # a read stood in for: this test is about who is let in
        pipe.run = lambda photo, progress=None: {'status': 'ok', 'provenance': {'calls': []}}
        run_ = Running(s, pipeline=pipe, limits=pipe.limits, public=public)
        self.addCleanup(run_.stop)
        return run_

    def post(self, run_, hop=None):
        h = {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg'}
        if hop:
            h['X-Forwarded-For'] = hop
        status, _, body = run_.request('POST', '/api/room', images.jpeg(), h)
        return status, json.loads(body)

    def test_behind_the_proxy_the_first_forwarded_hop_is_the_client(self):
        run_ = self.serve(public=True)
        for _ in range(config.CLIENT_PER_HOUR):
            self.assertEqual(self.post(run_, '203.0.113.7, 10.0.0.1')[0], 200)
        status, j = self.post(run_, '203.0.113.7, 10.0.0.2')
        self.assertEqual((status, j['error']['code']), (429, 'client_hour_cap'))
        self.assertTrue(j['error']['message'].endswith('.'))
        self.assertEqual(self.post(run_, '198.51.100.4, 10.0.0.1')[0], 200, 'another visitor is still read')
        self.assertNotIn('203.0.113.7', '\n'.join(run_.lines), 'the address is never logged')

    def test_without_public_the_header_is_not_trusted(self):
        run_ = self.serve(public=False)
        for n in range(config.CLIENT_PER_HOUR):
            self.assertEqual(self.post(run_, f'203.0.113.{n}')[0], 200)
        status, j = self.post(run_, '198.51.100.4')
        self.assertEqual((status, j['error']['code']), (429, 'client_hour_cap'), 'the socket address is the client')

    def test_only_live_counts_clients(self):
        holder = KeyHolder(TEST_VALUE)
        live = Settings('live', 'test', holder, config.API_BASE, 200, 5.0, '', True)
        for s, counted in ((live, True), (settings_from({}, 'http://127.0.0.1:9/v1'), False), (settings_from({}), False)):
            srv = build_server(s, '127.0.0.1', 0, log=Log(stream=[]))
            try:
                self.assertEqual(srv.limits.clients is not None, counted, s.mode)
                self.assertEqual(srv.health()['spend_kept'], 'memory', 'no data folder given')
                ceilings = srv.health()['ceilings']
                self.assertEqual((ceilings['photos_per_client_per_hour'], ceilings['photos_per_client_per_day']), (3, 10))
            finally:
                srv.server_close()


class Uploads(unittest.TestCase):
    """A stalled request is dropped, and a photo's place is taken before its
    body is read: no more photos than the readers in flight are held."""

    def setUp(self):
        patches = (mock.patch.object(Handler, 'timeout', 0.5), mock.patch.object(config, 'BODY_TIMEOUT_S', 1.5))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        s = settings_from({}, 'http://127.0.0.1:9/v1', 'desk')
        self.limits = Limits(clients=False, in_flight=1)
        self.pipe = Pipeline(s, self.limits, log=Log(stream=[]), sleep=lambda x: None)
        self.pipe.run = lambda photo, progress=None: {'status': 'ok', 'provenance': {'calls': []}}
        self.run_ = Running(s, pipeline=self.pipe, limits=self.limits)
        self.addCleanup(self.run_.stop)

    def connect(self):
        c = socket.create_connection(('127.0.0.1', self.run_.port), timeout=10)
        self.addCleanup(c.close)
        return c

    def until(self, test, what):
        for _ in range(200):
            if test():
                return
            time.sleep(0.02)
        self.fail(what)

    def read_all(self, c):
        raw = b''
        while True:
            part = c.recv(65536)
            if not part:
                return raw
            raw += part

    def head(self, length):
        return (b'POST /api/room HTTP/1.1\r\nHost: 127.0.0.1\r\nX-FramePlay-Request: 1\r\n'
                b'Content-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n' % length)

    def test_a_stalled_request_line_is_dropped(self):
        c = self.connect()
        c.sendall(b'GET /api/hea')
        t0 = time.monotonic()
        self.assertEqual(self.read_all(c), b'', 'closed without an answer')
        self.assertLess(time.monotonic() - t0, 5)

    def test_the_place_is_taken_before_the_body_and_a_stalled_body_gives_it_back(self):
        photo = images.jpeg()
        slow = self.connect()
        slow.sendall(self.head(len(photo)) + photo[:100])
        self.until(lambda: self.limits.counters()['photos_in_flight'] == 1, 'the place is taken before the body arrives')
        # the one reader's place is held: another upload is refused, in words, without being kept
        status, h, body = self.run_.request('POST', '/api/room', photo, {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg'})
        self.assertEqual((status, json.loads(body)['error']['code']), (429, 'busy'))
        self.assertIn('Retry-After', h)
        # the stalled body is given up within its time, and its place is free again
        self.assertIn(b' 400 ', self.read_all(slow).split(b'\r\n', 1)[0])
        c = self.limits.counters()
        self.assertEqual((c['photos_in_flight'], c['photos_this_hour'], c['photos_today']), (0, 0, 0))
        status, _, _ = self.run_.request('POST', '/api/room', photo, {'X-FramePlay-Request': '1', 'Content-Type': 'image/jpeg'})
        self.assertEqual(status, 200)
        self.assertEqual(self.limits.counters()['photos_today'], 1)

    def test_a_trickled_body_is_given_up_at_its_deadline(self):
        photo = images.jpeg()
        c = self.connect()
        c.sendall(self.head(len(photo)))
        t0 = time.monotonic()
        sent = 0
        gave_up = None
        try:
            while time.monotonic() - t0 < 6 and sent < len(photo) - 1:
                c.sendall(photo[sent:sent + 1])  # each piece in under the socket's timeout
                sent += 1
                if select.select([c], [], [], 0.2)[0]:  # an answer, or the connection closed
                    gave_up = time.monotonic() - t0
                    break
        except OSError:
            gave_up = time.monotonic() - t0  # closed while bytes were still on their way
        self.assertIsNotNone(gave_up, 'the server gave up on the upload')
        self.assertLess(gave_up, 4, 'at its deadline, though each piece came in time')
        self.until(lambda: self.limits.counters()['photos_in_flight'] == 0, 'its place is free again')
        self.assertEqual(self.limits.counters()['photos_this_hour'], 0)


class RehearsalStaysHome(unittest.TestCase):
    def test_rehearsal_refuses_any_host_but_loopback(self):
        for host in ('0.0.0.0', '::', '192.168.1.20', 'example'):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = main(['--rehearse', 'http://127.0.0.1:8192/v1', '--host', host])
            self.assertEqual(code, 2, host)
            self.assertIn('this machine only', err.getvalue())
        for host in ('127.0.0.1', '127.0.0.2', '::1', 'localhost'):
            self.assertTrue(is_loopback(host), host)


class SocketTimeout(unittest.TestCase):
    def test_every_request_has_a_socket_timeout(self):
        self.assertEqual(Handler.timeout, config.SOCKET_TIMEOUT_S)
        self.assertEqual(config.SOCKET_TIMEOUT_S, 15.0)


class Statics(unittest.TestCase):
    def test_static_file_never_leaves_the_page(self):
        self.assertIsNotNone(static_file('/'))
        self.assertIsNone(static_file('/src/../server/server.py'))
        self.assertIsNone(static_file('/server/server.py'))

    def test_the_installable_app_files_are_served(self):
        for path in ('/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png'):
            self.assertIsNotNone(static_file(path), path)
        self.assertIsNone(static_file('/icons/../server/server.py'))
        self.assertIsNone(static_file('/tools/make_icons.py'))


if __name__ == '__main__':
    unittest.main()
