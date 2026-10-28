"""FRAME//PLAY's server: Python standard library only.

Routes: GET / and an allowlist of the page's own files (the rooms and the
sample kitchen photo included), GET /api/health, POST /api/room and, in every
mode, POST /api/replay/kitchen (the sample kitchen photo's recorded answers
replayed through the same pipeline; nothing is sent: server/replay.py).
Everything else is 404. After an account or model problem, POST /api/room
answers 503 live_unavailable, sending nothing, and health says live_state:
unavailable. After FRAMEPLAY_LIVE_UNTIL, LIVE turns itself off: health says
MOCK, with why, and POST /api/room answers 503 live_unavailable, sending
nothing.

  python server/server.py                       # this machine only, port 8191
  python server/server.py --public              # every interface, at $PORT
  python server/server.py --rehearse http://127.0.0.1:8192/v1 --rehearsal-room desk

Live mode needs MODEL_API_KEY and FRAMEPLAY_LIVE=yes in the operator's own
environment; without both the server runs in mock mode and calls no model.
"""
import argparse
import hashlib
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
from server.limits import Refusal  # noqa: E402
from server.meta_api import LIVE_UNAVAILABLE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# Framing: only a Hugging Face Space page may show the game in its frame (the
# Space page on huggingface.co frames the app's own *.hf.space address); every
# other site is refused. X-Frame-Options cannot name sites, so it is not sent.
FRAME_ANCESTORS = 'https://huggingface.co https://*.hf.space'
CSP = ("default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; "
       f"frame-ancestors {FRAME_ANCESTORS}")

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
}

FIXED_FILES = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
               '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg',
               # the installable app: its manifest, icons and service worker
               '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js',
               '/icons/icon-192.png': 'icons/icon-192.png', '/icons/icon-512.png': 'icons/icon-512.png'}
PATTERNS = (re.compile(r'/src/[a-z_]+\.js'), re.compile(r'/rooms/[a-z0-9_-]+\.json'), re.compile(r'/rooms/kitchen\.jpg'))
REPLAY_ROUTE = '/api/replay/kitchen'
# a replay carries no photo: its body, if any, is at most this long
REPLAY_MAX_BODY = 64


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
    # the socket's own timeout: a request that stalls is dropped, never held
    timeout = config.SOCKET_TIMEOUT_S

    # BaseHTTPRequestHandler logs the client's address; this server never does
    def log_message(self, fmt, *args):
        pass

    def log_request(self, code='-', size='-'):
        self.server.log.write(method=self.command, path=self.route, status=int(code) if str(code).isdigit() else code)

    @property
    def route(self):
        return self.path.split('?', 1)[0].split('#', 1)[0]

    @property
    def client(self):
        """Who sent this request, for the per-client ceilings: the socket's
        address, or under --public the first X-Forwarded-For hop (the
        visitor's address as the Space's proxy gives it; trusted only
        there). Only a digest salted for this run is kept, never the
        address, and it is never logged."""
        addr = str(self.client_address[0]) if self.client_address else ''
        if self.server.public:
            hop = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
            addr = hop or addr
        return hashlib.sha256(self.server.salt + addr.encode('utf-8', 'replace')).hexdigest()[:32]

    def common_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
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
        if route == REPLAY_ROUTE:
            return self.send_json(405, error_body('method', f'Use POST for {REPLAY_ROUTE}.'), {'Allow': 'POST'}, head)
        f = static_file(route)
        if f is None:
            return self.send_json(404, error_body('not_found', 'There is nothing here.'), head=head)
        return self.send_bytes(200, f.read_bytes(), TYPES.get(f.suffix, 'application/octet-stream'), head=head)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_POST(self):
        route = self.route
        if route == REPLAY_ROUTE:
            return self.post_replay()
        if route != '/api/room':
            self.close_connection = True  # its body is never used
            self.drain()
            if route == '/api/health' or static_file(route) is not None:
                return self.send_json(405, error_body('method', 'This address only answers GET.'), {'Allow': 'GET'})
            return self.send_json(404, error_body('not_found', 'There is nothing here.'))
        self.post_room()

    def other_method(self):
        route = self.route
        self.close_connection = True
        self.drain()
        if route in ('/api/room', REPLAY_ROUTE):
            return self.send_json(405, error_body('method', f'Use POST for {route}.'), {'Allow': 'POST'})
        if route == '/api/health' or static_file(route) is not None:
            return self.send_json(405, error_body('method', 'This address only answers GET.'), {'Allow': 'GET'})
        return self.send_json(404, error_body('not_found', 'There is nothing here.'))

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = other_method

    def drain(self, cap=65536):
        """Before a refusal that closes the connection: a small body is read
        and dropped (briefly, never waiting long), so the refusal reaches the
        page rather than being cut off by a reset. A large one is not read."""
        try:
            length = int(self.headers.get('Content-Length') or '0')
        except ValueError:
            return
        if not 0 < length <= cap:
            return
        try:
            self.connection.settimeout(2)
            self.rfile.read(length)
        except OSError:
            pass

    def read_body(self, length, keep=True):
        """The body, read in pieces as it comes: each wait at most the
        socket's timeout, the whole at most config.BODY_TIMEOUT_S, and never
        more held than has arrived. keep=False drops each piece (a refusal
        sent before the photo was read reaches the page, not a reset).
        None when it did not arrive whole in time."""
        parts, got = [], 0
        end = time.monotonic() + config.BODY_TIMEOUT_S
        try:
            while got < length:
                if time.monotonic() > end:
                    return None
                piece = self.rfile.read1(min(65536, length - got))
                if not piece:
                    return None
                got += len(piece)
                if keep:
                    parts.append(piece)
        except OSError:
            return None
        return b''.join(parts)

    def page_only(self):
        """The page's own requests only: True, or the refusal is sent."""
        if self.headers.get('X-FramePlay-Request') != '1':
            self.close_connection = True
            self.drain()
            self.send_json(403, error_body('forbidden', 'This address only answers the FRAME//PLAY page. Please open the page itself.'))
            return False
        if (self.headers.get('Sec-Fetch-Site') or '').lower() == 'cross-site':
            self.close_connection = True
            self.drain()
            self.send_json(403, error_body('forbidden', 'A request from another site is refused. Please open the FRAME//PLAY page itself.'))
            return False
        return True

    def post_replay(self):
        """The sample kitchen photo's recorded answers, replayed through the
        pipeline in any mode. No photo comes in and nothing goes out."""
        if not self.page_only():
            return
        try:
            length = int(self.headers.get('Content-Length') or '0')
        except ValueError:
            length = -1
        if length < 0 or length > REPLAY_MAX_BODY:
            self.close_connection = True
            self.drain()
            return self.send_json(413, error_body('too_large', 'A replay carries no photo. Please try again from the page.'))
        if length:
            self.rfile.read(length)
        replay = self.server.replay_pipeline()
        if replay is None:
            return self.send_json(503, error_body('replay_unavailable', 'The recorded answers are not on this server.'))
        stream = 'application/x-ndjson' in (self.headers.get('Accept') or '')
        replay.handle_kitchen(self, stream)

    def post_room(self):
        s = self.server.settings
        if not self.page_only():
            return
        if s.mode == 'mock':
            self.close_connection = True
            self.drain()
            return self.send_json(409, error_body('live_off', 'This server is in MOCK mode, so it sends no photo anywhere. Play the sample rooms.'))
        if self.server.live_ended():
            # a page opened while LIVE was on: refused as the live AI
            # unavailable, so our kitchen falls back to its replay
            self.close_connection = True
            self.drain()
            return self.send_json(503, error_body('live_unavailable', config.ended_refusal(s.live_until)))
        transport = getattr(self.server.pipeline, 'transport', None)
        claim = getattr(transport, 'claim', None)
        held = claim() if claim is not None else 'open'
        if held is None:
            # an account or model problem: nothing is sent to the Model API
            # (a billing or credit refusal: not until midnight UTC)
            self.close_connection = True
            _, _, wait = transport.live_state()
            words = transport.refusal_words() if hasattr(transport, 'refusal_words') else LIVE_UNAVAILABLE
            return self.send_json(503, error_body('live_unavailable', words), {'Retry-After': str(max(1, wait))})
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
        # the photo's place is taken before its body is read, so no more
        # photos than the readers in flight are ever held in memory
        pipeline = self.server.pipeline
        adm = None
        if pipeline is not None:
            try:
                adm = pipeline.limits.admit(self.client)
            except Refusal as e:
                self.close_connection = True
                self.read_body(length, keep=False)
                return pipeline.refuse(self, e)
        handed = False
        try:
            data = self.read_body(length)
            if data is None:
                self.close_connection = True
                return self.send_json(400, error_body('short', 'The photo arrived incomplete. Please try the same photo again.'))
            try:
                photo = check_photo(data, config.MAX_SIDE)
            except ImageError as e:
                return self.send_json(415, error_body('bad_image', str(e)))
            if pipeline is None:
                return self.send_json(503, error_body('not_ready', 'The live path is not available on this server. The sample rooms still work.'))
            stream = 'application/x-ndjson' in (self.headers.get('Accept') or '')
            handed = True
            pipeline.handle(self, photo, stream, adm)
        finally:
            if adm is not None and not handed:
                pipeline.limits.cancel(adm)


class FramePlayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, addr, settings, log=None, pipeline=None, limits=None, public=False):
        super().__init__(addr, Handler)
        self.settings = settings
        self.public = public  # behind the Space's proxy: its X-Forwarded-For names the client
        self.salt = os.urandom(16)
        self.log = log or Log(holder=settings.key)
        self.pipeline = pipeline
        self.limits = limits
        self._replay = None
        self._replay_lock = threading.Lock()
        self.clock = time.time  # tests may swap it: FRAMEPLAY_LIVE_UNTIL is wall-clock time

    def live_ended(self):
        """True once FRAMEPLAY_LIVE_UNTIL has passed on a LIVE server."""
        s = self.settings
        return s.mode == 'live' and s.live_until is not None and self.clock() >= s.live_until

    def replay_pipeline(self):
        """The replay of the sample kitchen photo, made on first use, or None
        when its recorded answers are not here."""
        with self._replay_lock:
            if self._replay is None:
                try:
                    from server.replay import ReplayPipeline
                    self._replay = ReplayPipeline(log=self.log)
                except (ImportError, OSError, ValueError, KeyError):
                    return None
            return self._replay

    def handle_error(self, request, client_address):
        # one line in words, never the address or a traceback with request data
        exc = sys.exc_info()[1]
        self.log.write(event='connection_error', error=type(exc).__name__ if exc else 'unknown')

    def health(self):
        s = self.settings
        # after FRAMEPLAY_LIVE_UNTIL, LIVE has turned itself off: MOCK, and why
        mode = 'mock' if self.live_ended() else s.mode
        h = {
            'service': 'FRAME//PLAY',
            'mode': mode,
            'reason': config.ended_words(s.live_until) if mode != s.mode else s.reason,
            'label': config.LABELS[mode],
            'key': 'present (never shown)' if s.key_present or s.mode == 'live' else 'absent',
            'models': {'read': config.SPARK_MODEL, 'find': config.SAM_MODEL},
            'models_called': list(config.MODELS) if mode == 'live' else [],
            'outline_source': config.OUTLINE_SOURCE,
            'ceilings': {
                'body_bytes': config.MAX_BODY,
                'longest_side_px': config.MAX_SIDE,
                'spark_calls_per_photo': config.SPARK_CALLS_PER_PHOTO,
                'sam_calls_per_photo': config.SAM_CALLS_PER_PHOTO,
                'photos_in_flight': config.IN_FLIGHT,
                'photos_per_hour': config.PER_HOUR,
                'photos_per_day': s.day_cap,
                'photos_per_client_per_hour': config.CLIENT_PER_HOUR,
                'photos_per_client_per_day': config.CLIENT_PER_DAY,
                'usd_stop_per_day': s.usd_stop,
                # FRAMEPLAY_LIVE_UNTIL: when LIVE turns itself off (None: no end)
                'live_until': config.utc_words(s.live_until) if s.live_until is not None else None,
                'seconds_per_call': config.CALL_TIMEOUT_S,
                'seconds_per_read': config.SPARK_TIMEOUT_S,
                'seconds_per_photo': config.PHOTO_TIMEOUT_S,
                'seconds_per_socket_wait': config.SOCKET_TIMEOUT_S,
                'seconds_per_upload': config.BODY_TIMEOUT_S,
                # Ask the room: one more Muse Spark call a photo, after its reply
                'riddle_spark_calls_per_photo': config.RIDDLE_SPARK_CALLS if s.riddles else 0,
                'seconds_for_riddles': config.RIDDLE_TIMEOUT_S,
                # after an account or model problem, LIVE is held this long;
                # after a billing or credit refusal, until midnight UTC
                'live_hold_seconds': config.LIVE_HOLD_S,
                'billing_stop_until': 'midnight UTC',
                # our kitchen's replay: its own places, and per client a minute
                'replays_in_flight': config.REPLAY_IN_FLIGHT,
                'replays_per_client_per_minute': config.REPLAY_PER_MINUTE,
            },
            'riddles': 'on' if s.riddles else 'off',
            'riddles_reason': ('After each photo, one more Muse Spark call writes up to 3 riddles about it.'
                               if s.riddles else 'FRAMEPLAY_RIDDLES is no: no riddles are written.'),
        }
        h.update(self.live_state())
        if self.limits is not None:
            h['counters'] = self.limits.counters()
            # where the day's spend is kept: a file survives a restart of
            # this server, never a fresh container
            h['spend_kept'] = 'file' if getattr(self.limits, 'store', None) else 'memory'
        if s.mode == 'rehearsal':
            h['rehearsal'] = {'stand_in_base': s.base, 'room': s.rehearsal_room}
        # the sample kitchen photo's recorded answers, replayed in any mode
        h['replay'] = {'kitchen': {'route': 'api/replay/kitchen', 'photo': 'rooms/kitchen.jpg', 'recorded': '2026-10-27'}}
        return h

    def live_state(self):
        """'off' in MOCK; otherwise 'ok', or 'unavailable' after an account or
        model problem, with the reason in words (never the key)."""
        if self.settings.mode == 'mock' or self.live_ended():
            return {'live_state': 'off', 'live_reason': None}
        transport = getattr(self.pipeline, 'transport', None)
        if not hasattr(transport, 'live_state'):
            return {'live_state': 'ok', 'live_reason': None}
        state, words, wait = transport.live_state()
        if state == 'ok':
            return {'live_state': 'ok', 'live_reason': None}
        reason = words if words.endswith('.') else words + '.'
        return {'live_state': 'unavailable', 'live_reason': reason, 'live_check_again_s': wait}


def build_server(settings, host='127.0.0.1', port=8191, log=None, public=False):
    """The server with the pipeline and ceilings for its mode. In LIVE each
    client is held to its own ceilings too."""
    limits = pipeline = None
    try:
        from server.limits import Limits
        store = os.path.join(settings.data_dir, 'spend.json') if settings.data_dir else None
        limits = Limits(day_cap=settings.day_cap, usd_stop=settings.usd_stop, clients=settings.mode == 'live', store=store)
    except ImportError:
        limits = None
    if settings.mode != 'mock':
        try:
            from server.pipeline import Pipeline
            pipeline = Pipeline(settings, limits, log=None)
        except ImportError:
            pipeline = None
    srv = FramePlayServer((host, port), settings, log=log, pipeline=pipeline, limits=limits, public=public)
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
    srv = build_server(settings, host, port, public=args.public)
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
