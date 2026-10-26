import http.client
import json
import threading
import unittest

from server import config
from server.config import settings_from
from server.server import CSP, FramePlayServer, Log, build_server, static_file
from server.tests import images


class Running:
    """A FRAME//PLAY server on a free loopback port, for one test class."""

    def __init__(self, settings, pipeline=None, limits=None, use_build=False):
        self.lines = []
        log = Log(stream=self.lines, holder=settings.key)
        if use_build:
            self.srv = build_server(settings, '127.0.0.1', 0, log=log)
        else:
            self.srv = FramePlayServer(('127.0.0.1', 0), settings, log=log, pipeline=pipeline, limits=limits)
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
        self.assertIn("frame-ancestors 'none'", h['Content-Security-Policy'])
        self.assertEqual(h['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(h['Referrer-Policy'], 'no-referrer')
        self.assertTrue(h['Content-Type'].startswith('text/html'))
        _, h, _ = self.run_.request('GET', '/src/level.js')
        self.assertTrue(h['Content-Type'].startswith('text/javascript'))

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
        self.assertEqual(j['ceilings']['sam_calls_per_photo'], 9)

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


class Statics(unittest.TestCase):
    def test_static_file_never_leaves_the_page(self):
        self.assertIsNotNone(static_file('/'))
        self.assertIsNone(static_file('/src/../server/server.py'))
        self.assertIsNone(static_file('/server/server.py'))


if __name__ == '__main__':
    unittest.main()
