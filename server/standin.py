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
  cols and a real one_bit payload (sam_mask.encode_one_bit, the reference's
  canonical encoder) of the painter's exact silhouette of the thing as the
  picture shows it (server/standin_masks/<room>.json, made by
  tests/standin_silhouettes.js), so the server decodes it as it decodes
  SAM 3.1's own; and a closing newline. No match is the frame marker alone.
  The floor is one match a room when the room file draws it as several
  rings, each doorway in the mask of the first room it opens from.

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

from server import config, sam_mask, samtext  # noqa: E402
from server.imageinfo import ImageError, size, sniff  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DRILLS = ('401', '404', '429', '503', 'content_filter', 'zero_matches', 'malformed_record', 'people', 'sam_busy',
          # Ask the room: the riddles call answered wrong in one way each
          'riddle_bad_id', 'riddle_point_outside', 'riddle_leak', 'riddle_malformed', 'riddle_none', 'riddle_filter',
          # A room postcard: the picture refused, and the picture's server busy
          'postcard_refused', 'postcard_busy')
LISTED = re.compile(r'^(o\d+) \| (.+?) \| x (\d+)-(\d+), y (\d+)-(\d+)$')

# A room postcard: a small fixed payload the stand-in answers for
# /v1/images/edits. It is the same bytes a 1x1 JPEG would hold, but its
# base64 carries no run of 32 or more letters or digits, so the server's
# redactor never mistakes it for a key.
POSTCARD_JPEG = (b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'
                 b'\xff\xdb\x00\x43\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\x09\x09\x08\x0a\x0c\x14\x0d\x0c\x0b\x0b'
                 b'\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.4.\'",#"\x1c\x1c(7),01444\x1f\'9=82<.342'
                 b'\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00'
                 b'\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03'
                 b'\x04\x05\x06\x07\x08\x09\x0a\x0b'
                 b'\xff\xc4\x00\xb5\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01\x7d\x01\x02\x03\x00'
                 b'\x04\x11\x05\x12!\x311\x06\x13Qa\x07"q\x142\x81\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\x09'
                 b'\x0e\x17\x18\x19\x1a&\'()*456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz\x83\x84\x85\x86\x87\x88\x89\x8a'
                 b'\x92\x93\x94\x95\x96\x97\x98\x99\x9a\xa2\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8'
                 b'\xb9\xba\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xe1\xe2\xe3\xe4\xe5'
                 b'\xe6\xe7\xe8\xe9\xea\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa+/+'
                 b'\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xfb\xd2\x8a\x28\x03\xff\xd9')
POSTCARD_JPEG_B64 = base64.b64encode(POSTCARD_JPEG).decode('ascii')


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


def load_silhouettes(room_id):
    """The painter's silhouettes of a sample room, by object id and surface
    shape: (x0, y0, w, h, bytes of 0 and 1), or None for a thing not seen."""
    data = json.loads((ROOT / 'server' / 'standin_masks' / f'{room_id}.json').read_text(encoding='utf-8'))
    if data.get('room') != room_id:
        raise ValueError('the silhouettes are for another room')

    def unrun(c):
        if c is None:
            return None
        flat = bytearray()
        value = 0
        for run in c['runs']:
            flat += bytes([value]) * run
            value ^= 1
        return c['x0'], c['y0'], c['w'], c['h'], bytes(flat)
    return {**{k: unrun(v) for k, v in data['objects'].items()},
            **{k: unrun(v) for k, v in data['surface'].items()}}


def mask_raster(crops, box, sx=1.0, sy=1.0):
    """The silhouettes inside an inclusive box of the picture as sent (a
    copy sx, sy times the room's size), row major: pixel (c, r) is the
    room's pixel under the centre of the copy's pixel (x1 + c, y1 + r)."""
    x1, y1, x2, y2 = box
    w, h = x2 - x1 + 1, y2 - y1 + 1
    out = bytearray(w * h)
    for crop in crops:
        if crop is None:
            continue
        cx, cy, cw, ch, flat = crop
        if (sx, sy) == (1, 1):
            for y in range(max(y1, cy), min(y2 + 1, cy + ch)):
                a, b = max(x1, cx), min(x2 + 1, cx + cw)
                if a >= b:
                    continue
                src = flat[(y - cy) * cw + a - cx:(y - cy) * cw + b - cx]
                at = (y - y1) * w + a - x1
                out[at:at + b - a] = bytes(p | q for p, q in zip(out[at:at + b - a], src))
            continue
        for r in range(h):
            ry = math.floor((y1 + r + 0.5) / sy) - cy
            if not 0 <= ry < ch:
                continue
            for c in range(w):
                rx = math.floor((x1 + c + 0.5) / sx) - cx
                if 0 <= rx < cw and flat[ry * cw + rx]:
                    out[r * w + c] = 1
    return bytes(out)


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
        self.silhouettes = load_silhouettes(room_id)
        self.payloads = {}

    def payload(self, keys, box, sx, sy):
        """The one_bit payload of the silhouettes named by keys in a box,
        coded once for each box."""
        k = (tuple(keys), tuple(box), sx, sy)
        if k not in self.payloads:
            raster = mask_raster([self.silhouettes.get(key) for key in keys], box, sx, sy)
            self.payloads[k] = sam_mask.encode_one_bit(raster, box[2] - box[0] + 1, box[3] - box[1] + 1)
        return self.payloads[k]

    # ---- answers ----
    def floor_matches(self):
        """The floor as SAM finds it: one match a room. A surface drawn as
        several rings (a floor plan's rooms and the doorways between them)
        is one match for each ring of 2% of the picture or more, and each
        smaller ring (a doorway) belongs to the first room it touches, so
        its mask runs on through the doorway; any other surface is one
        match. Returns (id, the shapes, their silhouettes' keys)."""
        shape = self.room['surface']['shape']
        rings = shape.get('rings')
        if not rings:
            return [('surface', [shape], ['surface'])]
        W, H = self.room['width'], self.room['height']
        boxes = [pixel_box(ring, W, H) for ring in rings]
        rooms = [k for k, b in enumerate(boxes) if (b[2] - b[0] + 1) * (b[3] - b[1] + 1) >= 0.02 * W * H]
        parts = {k: [k] for k in rooms}
        for d, b in enumerate(boxes):
            if d in parts:
                continue
            k = next((k for k in rooms if boxes[k][0] <= b[2] + 1 and b[0] <= boxes[k][2] + 1
                      and boxes[k][1] <= b[3] + 1 and b[1] <= boxes[k][3] + 1), None)
            if k is not None:
                parts[k].append(d)
        return [(f'surface{k}', [rings[j] for j in parts[k]], [f'surface{j}' for j in parts[k]]) for k in rooms]

    def read(self):
        W, H = self.room['width'], self.room['height']
        objs = []
        by_name = {}
        for o in self.room['objects']:
            box = pixel_box(o['shape'], W, H)
            seed = {'x': round(((box[0] + box[2] + 1) / 2) * 1000 / W), 'y': round(((box[1] + box[3] + 1) / 2) * 1000 / H)}
            if o['name'] in by_name:
                # one entry a kind, counted, with a point on each one
                by_name[o['name']]['count'] += 1
                if len(by_name[o['name']]['seeds']) < 6:
                    by_name[o['name']]['seeds'].append(seed)
                continue
            entry = {'name': o['name'], 'count': 1, 'role': o['role'], 'reason': o['reason'],
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
            'objects': objs[:11],
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
            matches = [(o['id'], [o['shape']], [o['id']]) for o in self.room['objects'] if o['name'] == noun]
        found = []
        for oid, shapes, keys in matches:
            boxes = [pixel_box(shape, RW, RH) for shape in shapes]
            b = [min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes)]
            if (sx, sy) != (1, 1):
                b = [math.floor(b[0] * sx), math.floor(b[1] * sy), min(W - 1, math.ceil((b[2] + 1) * sx) - 1), min(H - 1, math.ceil((b[3] + 1) * sy) - 1)]
            found.append({'box': b, 'confidence': confidence(self.room_id, oid), 'payload': self.payload(keys, b, sx, sy)})
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
        if path == '/v1/images/edits':
            return self.edits(body, drill)
        return 404, {}, {'error': {'code': 'not_found', 'message': 'No such route'}}

    def riddles(self, body, drill):
        """Ask the room: the room file's own riddles, in Muse Spark's shape,
        under the request's ids. Each answer's name is matched to every
        listed id with that name, and given one point at the centre of that
        id's box on the grid."""
        text = next((c.get('text', '') for c in body['messages'][0]['content'] if c.get('type') == 'text'), '')
        listed = []
        for ln in text.splitlines():
            m = LISTED.match(ln.strip())
            if m:
                listed.append((m.group(1), m.group(2), [int(v) for v in m.groups()[2:]]))
        name_of = {o['id']: o['name'] for o in self.room['objects']}
        out = []
        for r in self.room.get('riddles') or []:
            names = {name_of.get(a) for a in r['answers']}
            ids = [i for i, name, _ in listed if name in names]
            pts = [{'id': i, 'x': (b[0] + b[1]) // 2, 'y': (b[2] + b[3]) // 2} for i, name, b in listed if i in ids]
            out.append({'text': r['text'], 'rule': r['rule'], 'answer_ids': ids, 'points': pts, 'why': r.get('why', '')})
        if out and drill == 'riddle_bad_id':
            out[0]['answer_ids'] = out[0]['answer_ids'] + ['o99']
        if out and drill == 'riddle_point_outside' and out[0]['points']:
            # 40 px to the right of its box
            p = out[0]['points'][0]
            box = next(b for i, _, b in listed if i == p['id'])
            p['x'] = min(1000, box[1] + round(40 * 1000 / self.room['width']))
        if out and drill == 'riddle_leak':
            first = next((name for i, name, _ in listed if i in out[0]['answer_ids']), 'thing')
            out[0]['text'] = f'Touch the {first} in this room.'
        if drill == 'riddle_none':
            out = []
        finish = 'content_filter' if drill == 'riddle_filter' else 'stop'
        content = '' if finish == 'content_filter' else ('not json {' if drill == 'riddle_malformed' else json.dumps({'riddles': out}))
        return 200, {}, {
            'id': 'chatcmpl-standin-riddles',
            'object': 'chat.completion',
            'model': config.SPARK_MODEL,
            'choices': [{'index': 0, 'finish_reason': finish, 'message': {'role': 'assistant', 'content': content}}],
            'usage': {'prompt_tokens': 1450, 'completion_tokens': 900, 'total_tokens': 2350,
                      'completion_tokens_details': {'reasoning_tokens': 500}},
        }

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
        if (rf.get('json_schema') or {}).get('name') == 'room_riddles':
            return self.riddles(body, drill)
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

    def edits(self, body, drill):
        """A room postcard: the small fixed JPEG in the images shape. The
        request follows the contract or it is refused; postcard_refused says
        what a content refusal says, and postcard_busy is busy once."""
        if drill == 'postcard_refused':
            return 400, {}, {'error': {'code': 'content_policy_violation', 'type': 'invalid_request_error',
                                       'message': 'The picture was refused'}}
        if drill == 'postcard_busy':
            with self.lock:
                if not self.drill_used:
                    self.drill_used = True
                    return 503, {}, {'error': {'code': 'unavailable', 'type': 'server_error', 'message': 'Unavailable'}}
        tools = body.get('tool_enablement') or {}
        try:
            image = body['images'][0]['image_url']
        except (KeyError, IndexError, TypeError):
            image = ''
        if body.get('model') != 'muse-image-1.0' or body.get('prompt') in (None, '') \
                or body.get('n') != 1 or body.get('size') != '1536x1024' \
                or body.get('response_format') != 'b64_json' or body.get('output_format') != 'jpeg' \
                or body.get('reasoning_strength') != 'low' \
                or tools.get('enable_image_search') is not False or tools.get('enable_web_search') is not False \
                or tools.get('enable_shell') is not False or not body.get('user') \
                or not str(image).startswith('data:image/'):
            return 400, {}, {'error': {'code': 'invalid_request', 'message': 'The request does not follow the contract'}}
        return 200, {}, {
            'created': 1,
            'data': [{'b64_json': POSTCARD_JPEG_B64}],
            'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0},
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
