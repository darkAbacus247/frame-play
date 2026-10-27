"""FRAME//PLAY's server: Python standard library only.

Routes: GET / and an allowlist of the page's own files (the rooms included),
GET /api/health, POST /api/room. Everything else is 404. After an account or
model problem, POST /api/room answers 503 live_unavailable, sending nothing,
and health says live_state: unavailable.

  python server/server.py                       # this machine only, port 8191
  python server/server.py --public              # every interface, at $PORT
  python server/server.py --rehearse http://127.0.0.1:8192/v1 --rehearsal-room desk

Live mode needs MODEL_API_KEY and FRAMEPLAY_LIVE=yes in the operator's own
environment; without both the server runs in mock mode and calls no model.
"""
import argparse
import ipaddress
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import config  # noqa: E402
from server.imageinfo import ImageError, check_photo  # noqa: E402
from server.meta_api import LIVE_UNAVAILABLE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

CSP = ("default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
}

FIXED_FILES = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
               '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg'}
PATTERNS = (re.compile(r'/src/[a-z_]+\.js'), re.compile(r'/rooms/[a-z0-9_-]+\.json'))


def static_file(path):
    """The file a page path maps to, or None. Only the page's own files."""
    if path in FIXED_FILES:
        rel = FIXED_FILES[path]
    elif any(p.fullmatch(path) for p in PATTERNS):
        rel = path.lstrip('/')
    else:
        return None
    f = (ROOT / rel).resolve()
    try:
        f.relative_to(ROOT)
    except ValueError:
        return None
    return f if f.is_file() else None


class Log:
    """JSON lines on standard error: never an address, a photo, a prompt, a
    model's answer, a header or the key. Every line passes the redactor."""

    def __init__(self, stream=None, holder=None):
        self.stream = stream if stream is not None else sys.stderr
        self.holder = holder
        self.lock = threading.Lock()
        self.lines = []  # kept for tests when the stream is a list

    def write(self, **fields):
        fields = {'t': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **fields}
        line = config.redact(json.dumps(fields, ensure_ascii=False, sort_keys=False), self.holder)
        with self.lock:
            if isinstance(self.stream, list):
                self.stream.append(line)
            else:
                try:
                    self.stream.write(line + '\n')
                    self.stream.flush()
                except (OSError, ValueError):
                    pass


def sentence(text):
    """Words end with a full stop, so the page can add its advice after them."""
    text = str(text).strip()
    return text if text[-1:] in '.!?' else text + '.'


def error_body(code, message):
    return {'status': 'error', 'error': {'code': code, 'message': sentence(message)}}


class Handler(BaseHTTPRequestHandler):
    server_version = 'FRAMEPLAY'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    # BaseHTTPRequestHandler logs the client's address; this server never does
    def log_message(self, fmt, *args):
        pass

    def log_request(self, code='-', size='-'):
        self.server.log.write(method=self.command, path=self.route, status=int(code) if str(code).isdigit() else code)

    @property
    def route(self):
        return self.path.split('?', 1)[0].split('#', 1)[0]

    def common_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')

    def send_bytes(self, status, body, ctype, extra=None, head=False):
        self.send_response(status)
        self.common_headers()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store' if self.route.startswith('/api/') else 'no-cache')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def send_json(self, status, obj, extra=None, head=False):
        text = config.redact(json.dumps(obj, ensure_ascii=False), self.server.settings.key)
        self.send_bytes(status, text.encode('utf-8'), 'application/json; charset=utf-8', extra, head)

    # ---- routes ----
    def do_GET(self, head=False):
        route = self.route
        if route == '/api/health':
            return self.send_json(200, self.server.health(), head=head)
        if route == '/api/room':
            return self.send_json(405, error_body('method', 'Use POST for /api/room.'), {'Allow': 'POST'}, head)
        f = static_file(route)
        if f is None:
            return self.send_json(404, error_body('not_found', 'There is nothing here.'), head=head)
        return self.send_bytes(200, f.read_bytes(), TYPES.get(f.suffix, 'application/octet-stream'), head=head)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_POST(self):
        route = self.route
        if route != '/api/room':
            self.close_connection = True  # its body is never read
            if route == '/api/health' or static_file(route) is not None:
                return self.send_json(405, error_body('method', 'This address only answers GET.'), {'Allow': 'GET'})
            return self.send_json(404, error_body('not_found', 'There is nothing here.'))
        self.post_room()

    def other_method(self):
        route = self.route
        self.close_connection = True
        if route == '/api/room':
            return self.send_json(405, error_body('method', 'Use POST for /api/room.'), {'Allow': 'POST'})
        if route == '/api/health' or static_file(route) is not None:
            return self.send_json(405, error_body('method', 'This address only answers GET.'), {'Allow': 'GET'})
        return self.send_json(404, error_body('not_found', 'There is nothing here.'))

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = other_method

    def post_room(self):
        s = self.server.settings
        if self.headers.get('X-FramePlay-Request') != '1':
            self.close_connection = True
            return self.send_json(403, error_body('forbidden', 'This address only answers the FRAME//PLAY page. Please open the page itself.'))
        if (self.headers.get('Sec-Fetch-Site') or '').lower() == 'cross-site':
            self.close_connection = True
            return self.send_json(403, error_body('forbidden', 'A request from another site is refused. Please open the FRAME//PLAY page itself.'))
        if s.mode == 'mock':
            self.close_connection = True
            return self.send_json(409, error_body('live_off', 'This server is in MOCK mode, so it sends no photo anywhere. Play the sample rooms.'))
        transport = getattr(self.server.pipeline, 'transport', None)
        claim = getattr(transport, 'claim', None)
        held = claim() if claim is not None else 'open'
        if held is None:
            # an account or model problem: nothing is sent to the Model API
            self.close_connection = True
            _, _, wait = transport.live_state()
            return self.send_json(503, error_body('live_unavailable', LIVE_UNAVAILABLE), {'Retry-After': str(max(1, wait))})
        try:
            self.read_and_run()
        finally:
            if held == 'probe':
                transport.release()

    def read_and_run(self):
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            self.close_connection = True
            return self.send_json(411, error_body('length', 'The photo must come with its length. Please try again from the page.'))
        if length < 0:
            self.close_connection = True
            return self.send_json(400, error_body('length', 'The length of the photo cannot be read. Please try again from the page.'))
        if length > config.MAX_BODY:
            self.close_connection = True
            return self.send_json(413, error_body('too_large', 'The photo is larger than 4 MiB. The page shrinks it first; please try again from the page.'))
        data = self.rfile.read(length)
        if len(data) != length:
            self.close_connection = True
            return self.send_json(400, error_body('short', 'The photo arrived incomplete. Please try the same photo again.'))
        try:
            photo = check_photo(data, config.MAX_SIDE)
        except ImageError as e:
            return self.send_json(415, error_body('bad_image', str(e)))
        pipeline = self.server.pipeline
        if pipeline is None:
            return self.send_json(503, error_body('not_ready', 'The live path is not available on this server. The sample rooms still work.'))
        stream = 'application/x-ndjson' in (self.headers.get('Accept') or '')
        pipeline.handle(self, photo, stream)


class FramePlayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, addr, settings, log=None, pipeline=None, limits=None):
        super().__init__(addr, Handler)
        self.settings = settings
        self.log = log or Log(holder=settings.key)
        self.pipeline = pipeline
        self.limits = limits

    def handle_error(self, request, client_address):
        # one line in words, never the address or a traceback with request data
        exc = sys.exc_info()[1]
        self.log.write(event='connection_error', error=type(exc).__name__ if exc else 'unknown')

    def health(self):
        s = self.settings
        h = {
            'service': 'FRAME//PLAY',
            'mode': s.mode,
            'reason': s.reason,
            'label': s.label,
            'key': 'present (never shown)' if s.key_present or s.mode == 'live' else 'absent',
            'models': {'read': config.SPARK_MODEL, 'find': config.SAM_MODEL},
            'models_called': list(config.MODELS) if s.mode == 'live' else [],
            'outline_source': config.OUTLINE_SOURCE,
            'ceilings': {
                'body_bytes': config.MAX_BODY,
                'longest_side_px': config.MAX_SIDE,
                'spark_calls_per_photo': config.SPARK_CALLS_PER_PHOTO,
                'sam_calls_per_photo': config.SAM_CALLS_PER_PHOTO,
                'photos_in_flight': config.IN_FLIGHT,
                'photos_per_hour': config.PER_HOUR,
                'photos_per_day': s.day_cap,
                'usd_stop_per_day': s.usd_stop,
                'seconds_per_call': config.CALL_TIMEOUT_S,
                'seconds_per_read': config.SPARK_TIMEOUT_S,
                'seconds_per_photo': config.PHOTO_TIMEOUT_S,
            },
        }
        h.update(self.live_state())
        if self.limits is not None:
            h['counters'] = self.limits.counters()
        if s.mode == 'rehearsal':
            h['rehearsal'] = {'stand_in_base': s.base, 'room': s.rehearsal_room}
        return h

    def live_state(self):
        """'off' in MOCK; otherwise 'ok', or 'unavailable' after an account or
        model problem, with the reason in words (never the key)."""
        if self.settings.mode == 'mock':
            return {'live_state': 'off', 'live_reason': None}
        transport = getattr(self.pipeline, 'transport', None)
        if not hasattr(transport, 'live_state'):
            return {'live_state': 'ok', 'live_reason': None}
        state, words, wait = transport.live_state()
        if state == 'ok':
            return {'live_state': 'ok', 'live_reason': None}
        reason = words if words.endswith('.') else words + '.'
        return {'live_state': 'unavailable', 'live_reason': reason, 'live_check_again_s': wait}


def build_server(settings, host='127.0.0.1', port=8191, log=None):
    """The server with the pipeline and ceilings for its mode."""
    limits = pipeline = None
    try:
        from server.limits import Limits
        limits = Limits(day_cap=settings.day_cap, usd_stop=settings.usd_stop)
    except ImportError:
        limits = None
    if settings.mode != 'mock':
        try:
            from server.pipeline import Pipeline
            pipeline = Pipeline(settings, limits, log=None)
        except ImportError:
            pipeline = None
    srv = FramePlayServer((host, port), settings, log=log, pipeline=pipeline, limits=limits)
    if pipeline is not None:
        pipeline.log = srv.log
    return srv


def is_loopback(host):
    """True only for a loopback address (127.0.0.0/8, ::1) or localhost."""
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description='FRAME//PLAY server (standard library only)')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8191)
    ap.add_argument('--public', action='store_true', help='listen on every interface at $PORT (default 8080)')
    ap.add_argument('--rehearse', metavar='URL', help='a loopback stand-in, such as http://127.0.0.1:8192/v1')
    ap.add_argument('--rehearsal-room', default='desk', help='the sample room the stand-in answers for')
    args = ap.parse_args(argv)
    try:
        if args.public and args.rehearse:
            raise config.ConfigError('Rehearsal is for this machine only; it cannot run with --public')
        if args.rehearse and not is_loopback(args.host):
            raise config.ConfigError('Rehearsal is for this machine only; it listens on a loopback address such as 127.0.0.1')
        settings = config.settings_from(os.environ, args.rehearse, args.rehearsal_room)
    except config.ConfigError as e:
        print(f'FRAME//PLAY: {e}', file=sys.stderr)
        return 2
    host, port = args.host, args.port
    if args.public:
        host, port = '0.0.0.0', int(os.environ.get('PORT') or 8080)
    srv = build_server(settings, host, port)
    srv.log.write(event='start', mode=settings.mode, reason=settings.reason, host=host, port=port)
    print(f'FRAME//PLAY on http://{host}:{port}/ in {settings.mode.upper()} mode. {settings.reason}', file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
