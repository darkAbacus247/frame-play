"""A local stand-in for the Meta Model API, for rehearsal and tests. It is
not Meta and never pretends to be: everything it makes is labeled
REHEARSAL by the server that calls it.

It answers for one sample room, chosen when it starts, in the documented
shapes:
- POST /v1/chat/completions: choices[0].message.content holds the strict
  JSON read of the room (from the room file's own objects, roles and
  reasons, its view and its points on the open floor), and usage includes
  reasoning tokens;
- POST /v1/responses: the answer in the shape sam-3.1 gave on the first
  live calls (10-27): output[0].content[0].text (and no output_text field)
  in sam-3.1's own text grammar (samtext.py): ids from 0, exact inclusive
  boxes computed from the room's own shapes with the picture's size and a
  full-precision confidence, a mask token whose data is the box's rows and
  cols and a payload in the real alphabet (made up: it means nothing), and
  a closing newline. No match is the frame marker alone. The floor is one
  match a room when the room file draws it as several rings.

Drills on demand (--drill, or POST /drill {"name": ...} from this machine):
401, 404 (model_not_found), 429 (once, with Retry-After), 503,
content_filter, zero_matches, malformed_record, people, and sam_busy (the
room read is answered; every SAM call is answered 429, Retry-After 0, as
long as the drill holds).

  python server/standin.py --room desk --port 8192
"""
import argparse
import base64
import hashlib
import json
import math
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import config, samtext  # noqa: E402
from server.imageinfo import ImageError, size, sniff  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DRILLS = ('401', '404', '429', '503', 'content_filter', 'zero_matches', 'malformed_record', 'people', 'sam_busy')


# ---- the room's shapes, read the same way the page reads them ----
def _arc_points(cx, cy, rx, ry, a0, a1):
    pts = []
    n = max(8, int(abs(a1 - a0) / 2))
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    # the exact extremes inside the span
    lo, hi = min(a0, a1), max(a0, a1)
    k = math.ceil(lo / 90)
    while k * 90 <= hi:
        a = math.radians(k * 90)
        pts.append((cx + rx * round(math.cos(a)), cy + ry * round(math.sin(a))))
        k += 1
    return pts


def shape_points(shape):
    if 'rings' in shape:
        return [p for s in shape['rings'] for p in shape_points(s)]
    if 'poly' in shape:
        return [tuple(p) for p in shape['poly']]
    if 'rect' in shape:
        x, y, w, h = shape['rect']
        return [(x, y), (x + w, y + h)]
    if 'ellipse' in shape:
        cx, cy, rx, ry = shape['ellipse']
        return [(cx - rx, cy - ry), (cx + rx, cy + ry)]
    if 'path' in shape:
        pts = []
        for c in shape['path']:
            if c[0] in ('M', 'L'):
                pts.append((c[1], c[2]))
            elif c[0] == 'A':
                pts.extend(_arc_points(*c[1:7]))
        return pts
    raise ValueError('unknown shape')


def pixel_box(shape, W, H):
    """The inclusive pixel box of the pixels whose centres the shape covers,
    as SAM reports a box: [x1, y1, x2, y2]."""
    pts = shape_points(shape)
    x0 = min(p[0] for p in pts)
    x1 = max(p[0] for p in pts)
    y0 = min(p[1] for p in pts)
    y1 = max(p[1] for p in pts)
    bx0 = max(0, math.ceil(x0 - 0.5))
    by0 = max(0, math.ceil(y0 - 0.5))
    bx1 = min(W - 1, math.ceil(x1 - 0.5) - 1)
    by1 = min(H - 1, math.ceil(y1 - 0.5) - 1)
    return [bx0, by0, bx1, by1]


def load_room(room_id):
    if not re.fullmatch(r'[a-z0-9_-]{1,32}', room_id):
        raise ValueError('not a sample room id')
    data = json.loads((ROOT / 'rooms' / f'{room_id}.json').read_text(encoding='utf-8'))
    if data.get('schema') != 'frameplay.room/1':
        raise ValueError('not a sample room file')
    return data


def _digest(*parts):
    return hashlib.sha256('|'.join(map(str, parts)).encode('utf-8')).digest()


def confidence(room_id, obj_id):
    """A steady confidence from 0.86 to 0.98, written to full precision as
    sam-3.1 writes its own."""
    d = _digest(room_id, obj_id)
    return 0.86 + (int.from_bytes(d[:4], 'big') / 2 ** 32) * 0.12


def payload(room_id, obj_id, area):
    n = max(16, min(4000, int(area // 60)))
    out = []
    seed = _digest(room_id, obj_id, 'mask')
    while len(out) < n:
        seed = hashlib.sha256(seed).digest()
        out.extend(samtext.ALPHABET[b % 85] for b in seed)
    return ''.join(out[:n])


class StandIn:
    def __init__(self, room_id='desk', drill=None):
        if drill is not None and drill not in DRILLS:
            raise ValueError(f'unknown drill {drill}')
        self.room_id = room_id
        self.room = load_room(room_id)
        self.drill = drill
        self.drill_used = False
        self.lock = threading.Lock()
        self.requests = []

    # ---- answers ----
    def floor_matches(self):
        """The floor as SAM finds it: one match a room. A surface drawn as
        several rings (a floor plan's rooms and the doorways between them)
        is one match for each ring of 2% of the picture or more; any other
        surface is one match."""
        shape = self.room['surface']['shape']
        rings = shape.get('rings')
        if not rings:
            return [('surface', shape)]
        W, H = self.room['width'], self.room['height']
        out = []
        for k, ring in enumerate(rings):
            b = pixel_box(ring, W, H)
            if (b[2] - b[0] + 1) * (b[3] - b[1] + 1) >= 0.02 * W * H:
                out.append((f'surface{k}', ring))
        return out

    def read(self):
        W, H = self.room['width'], self.room['height']
        objs = []
        by_name = {}
        for o in self.room['objects']:
            box = pixel_box(o['shape'], W, H)
            seed = {'x': round(((box[0] + box[2] + 1) / 2) * 1000 / W), 'y': round(((box[1] + box[3] + 1) / 2) * 1000 / H)}
            if o['name'] in by_name:
                if len(by_name[o['name']]['seeds']) < 3:
                    by_name[o['name']]['seeds'].append(seed)
                continue
            entry = {'name': o['name'], 'role': o['role'], 'reason': o['reason'],
                     'on_surface': o.get('on_surface') is not False, 'seeds': [seed]}
            by_name[o['name']] = entry
            objs.append(entry)
        surface = self.room.get('surface') or {}
        grid = lambda p: {'x': round(p[0] * 1000 / W), 'y': round(p[1] * 1000 / H)}  # noqa: E731
        return {
            'people_present': self.drill == 'people',
            'surface': {'name': surface.get('name', 'floor')},
            'view': self.room.get('view', 'eye_level'),
            # the room file's own points on open floor, one or more a room
            'floor_seeds': [grid(p) for p in surface.get('seeds', [])],
            'objects': objs[:8],
            'title': self.room['title'][:60],
            'theme_line': self.room['theme_line'][:120],
        }

    def find(self, noun, W, H):
        RW, RH = self.room['width'], self.room['height']
        sx, sy = W / RW, H / RH
        if self.drill == 'zero_matches':
            return samtext.compose([], W, H)
        if self.room.get('surface') and noun == self.room['surface']['name']:
            matches = self.floor_matches()
        else:
            matches = [(o['id'], o['shape']) for o in self.room['objects'] if o['name'] == noun]
        found = []
        for oid, shape in matches:
            b = pixel_box(shape, RW, RH)
            if (sx, sy) != (1, 1):
                b = [math.floor(b[0] * sx), math.floor(b[1] * sy), min(W - 1, math.ceil((b[2] + 1) * sx) - 1), min(H - 1, math.ceil((b[3] + 1) * sy) - 1)]
            area = (b[2] - b[0] + 1) * (b[3] - b[1] + 1)
            found.append({'box': b, 'confidence': confidence(self.room_id, oid), 'payload': payload(self.room_id, oid, area)})
        text = samtext.compose(found, W, H, newline=False)
        if self.drill == 'malformed_record':
            text += f'{"," if found else ""}{len(found)}<|box;x1=5;y1=5;x2=1;w={W};h={H};c=0.9|><|mask;x=0;y=0;c=0.9;data=1,1,!|>'
        return text + '\n'

    def answer(self, path, headers, body):
        """(status, headers, JSON) for one request."""
        with self.lock:
            self.requests.append({'path': path, 'model': (body or {}).get('model') if isinstance(body, dict) else None})
            drill = self.drill
            first = not self.drill_used
            if drill == '429':
                self.drill_used = True
        if headers.get('Authorization') != 'Bearer ' + config.REHEARSAL_CREDENTIAL or drill == '401':
            return 401, {}, {'error': {'code': 'invalid_api_key', 'type': 'authentication_error', 'message': 'Invalid credential'}}
        if drill == '429' and first:
            return 429, {'Retry-After': '1'}, {'error': {'code': 'rate_limited', 'type': 'rate_limit_error', 'message': 'Slow down'}}
        if drill == 'sam_busy' and path == '/v1/responses':
            return 429, {'Retry-After': '0'}, {'error': {'code': 'rate_limited', 'type': 'rate_limit_error', 'message': 'Slow down'}}
        if drill == '503':
            return 503, {}, {'error': {'code': 'unavailable', 'type': 'server_error', 'message': 'Unavailable'}}
        if not isinstance(body, dict):
            return 400, {}, {'error': {'code': 'invalid_request', 'message': 'The body is not JSON'}}
        if path == '/v1/chat/completions':
            return self.chat(body, drill)
        if path == '/v1/responses':
            return self.responses(body, drill)
        return 404, {}, {'error': {'code': 'not_found', 'message': 'No such route'}}

    def chat(self, body, drill):
        if body.get('model') != config.SPARK_MODEL or drill == '404':
            return 404, {}, {'error': {'code': 'model_not_found', 'type': 'invalid_request_error', 'message': 'The model does not exist'}}
        rf = body.get('response_format') or {}
        ok = (rf.get('type') == 'json_schema' and (rf.get('json_schema') or {}).get('strict') is True
              and body.get('reasoning_effort') == 'low' and isinstance(body.get('max_completion_tokens'), int)
              and 'temperature' not in body)
        try:
            content = body['messages'][0]['content']
            image = next(c for c in content if c.get('type') == 'image_url')['image_url']['url']
        except (KeyError, IndexError, TypeError, StopIteration):
            ok = False
            image = ''
        if not ok or not str(image).startswith('data:image/'):
            return 400, {}, {'error': {'code': 'invalid_request', 'message': 'The request does not follow the contract'}}
        finish = 'content_filter' if drill == 'content_filter' else 'stop'
        content = '' if finish == 'content_filter' else json.dumps(self.read())
        return 200, {}, {
            'id': 'chatcmpl-standin',
            'object': 'chat.completion',
            'model': config.SPARK_MODEL,
            'choices': [{'index': 0, 'finish_reason': finish, 'message': {'role': 'assistant', 'content': content}}],
            'usage': {'prompt_tokens': 2100, 'completion_tokens': 1400, 'total_tokens': 3500,
                      'completion_tokens_details': {'reasoning_tokens': 800}},
        }

    def responses(self, body, drill):
        if body.get('model') != config.SAM_MODEL or drill == '404':
            return 404, {}, {'error': {'code': 'model_not_found', 'type': 'invalid_request_error', 'message': 'The model does not exist'}}
        meta = body.get('metadata') or {}
        try:
            content = body['input'][0]['content']
            noun = next(c for c in content if c.get('type') == 'input_text')['text']
            url = next(c for c in content if c.get('type') == 'input_image')['image_url']
        except (KeyError, IndexError, TypeError, StopIteration):
            return 400, {}, {'error': {'code': 'invalid_request', 'message': 'The request does not follow the contract'}}
        if body.get('stream') is not False or body.get('store') is not False or meta.get('mask_encoding') != 'one_bit' \
                or meta.get('include_confidence') != 'true':
            return 400, {}, {'error': {'code': 'invalid_request', 'message': 'stream, store and metadata must follow the contract'}}
        try:
            head, b64 = url.split(',', 1)
            data = base64.b64decode(b64[:200_000], validate=False)
            kind = sniff(data)
            W, H = size(data, kind) if kind else (None, None)
        except (ValueError, ImageError):
            W = H = None
        if not W:
            return 400, {}, {'error': {'code': 'invalid_image', 'message': 'The image cannot be read'}}
        text = self.find(str(noun).strip().lower(), W, H)
        return 200, {}, {
            'metadata': dict(meta), 'model': config.SAM_MODEL, 'background': False, 'tools': [],
            'id': 'resp_standin', 'object': 'response', 'status': 'completed', 'error': None, 'incomplete_details': None,
            'output': [{'type': 'message', 'id': 'msg_standin', 'role': 'assistant', 'status': 'completed',
                        'content': [{'type': 'output_text', 'text': text, 'annotations': [], 'logprobs': []}]}],
            'instructions': None,
            'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0, 'images_processed': 1},
            'store': False,
        }


def make_server(standin, host='127.0.0.1', port=8192):
    class H(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'standin'
        sys_version = ''

        def log_message(self, *a):
            pass

        def send(self, status, headers, obj):
            data = json.dumps(obj).encode('utf-8')
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                n = 0
            if n > config.MAX_BODY * 2:
                self.close_connection = True
                return self.send(413, {}, {'error': {'code': 'too_large', 'message': 'Too large'}})
            raw = self.rfile.read(n)
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            if self.path == '/drill':
                name = (body or {}).get('name') if isinstance(body, dict) else None
                if name is not None and name not in DRILLS:
                    return self.send(400, {}, {'error': {'code': 'unknown_drill', 'message': f'Drills: {", ".join(DRILLS)}'}})
                with standin.lock:
                    standin.drill = name
                    standin.drill_used = False
                return self.send(200, {}, {'drill': name})
            status, headers, obj = standin.answer(self.path, dict(self.headers), body)
            self.send(status, headers, obj)

    srv = ThreadingHTTPServer((host, port), H)
    srv.daemon_threads = True
    srv.handle_error = lambda request, address: None
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description='A local stand-in for the Meta Model API (rehearsal only; not Meta)')
    ap.add_argument('--room', default='desk')
    ap.add_argument('--port', type=int, default=8192)
    ap.add_argument('--drill', choices=DRILLS)
    args = ap.parse_args(argv)
    srv = make_server(StandIn(args.room, args.drill), '127.0.0.1', args.port)
    print(f'Stand-in (not Meta) for the {args.room} room on http://127.0.0.1:{args.port}/v1', file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
