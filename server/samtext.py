"""The sam-3.1 answer text: a frame marker, then records of an id, a box and
a mask, with the image size and an optional confidence.

The grammar below is this project's reading of Meta's published SAM 3 text
format as summarised in our specification. It is written for this project,
from that summary only; the first live answers confirm it (step S15), and
the parser reports every surprise as a diagnostic instead of guessing:

    <0f>                              the frame marker; text before it is ignored
    <w>1024<h>768                     the image size (the frame's, or a record's)
    <id>1<box>x1 y1 x2 y2<c>0.93<mask>ENVELOPE   one record per match

- Tags are <name>; a tag's value runs to the next tag, except a mask, whose
  envelope says its own length (its alphabet includes < and >).
- Box corners are source pixels with x2 and y2 inclusive; they are made
  half-open here: [x1, y1, x2 + 1, y2 + 1].
- w and h must equal the size of the copy that was sent.
- A mask envelope is the encoding marker "1" (one_bit), a five-character
  length prefix in the base85 alphabet (a 32-bit count of payload
  characters), and the payload in that alphabet. The payload is an
  arithmetic-coded raster that only Meta's own parser decodes: here it is
  checked and its size noted, and it is not kept.

Diagnostics: malformed_record (an error; the record is dropped), and
ignored_field, ignored_token and ignored_confidence (warnings, once per
answer each).
"""
import re

FRAME = '<0f>'
B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~'
_B85_SET = frozenset(B85)
MASK_ONE_BIT = '1'
_TAG = re.compile(r'<([a-z0-9]{1,8})>')
KNOWN = {'id', 'box', 'c', 'w', 'h', 'mask'}


def b85_count(n):
    """The five-character length prefix for n (for the stand-in and tests)."""
    if not 0 <= n < 85 ** 5:
        raise ValueError('length out of range')
    out = []
    for _ in range(5):
        out.append(B85[n % 85])
        n //= 85
    return ''.join(reversed(out))


def _b85_value(s):
    v = 0
    for ch in s:
        v = v * 85 + B85.index(ch)
    return v


def envelope(payload):
    """A well-formed one_bit envelope around an opaque payload."""
    if any(ch not in _B85_SET for ch in payload):
        raise ValueError('payload outside the alphabet')
    return MASK_ONE_BIT + b85_count(len(payload)) + payload


class Parsed:
    def __init__(self):
        self.width = None
        self.height = None
        self.records = []      # dicts: id, box (half-open), confidence, mask
        self.errors = []       # malformed_record, size_mismatch, no_frame
        self.warnings = []     # ignored_field, ignored_token, ignored_confidence

    def warn_once(self, code):
        if code not in self.warnings:
            self.warnings.append(code)

    def as_dict(self):
        return {'width': self.width, 'height': self.height, 'records': self.records,
                'errors': self.errors, 'warnings': self.warnings}


def _ints(text, n):
    parts = text.split()
    if len(parts) != n or not all(re.fullmatch(r'-?\d{1,6}', p) for p in parts):
        return None
    return [int(p) for p in parts]


def _finish(rec, out, width, height):
    """Check one record; append it or note malformed_record."""
    if rec is None:
        return
    w = rec.get('w', width)
    h = rec.get('h', height)
    box = rec.get('box')
    ok = isinstance(rec.get('id'), int) and box is not None and rec.get('mask_ok') is not False
    if ok:
        x1, y1, x2, y2 = box
        ok = 0 <= x1 <= x2 and 0 <= y1 <= y2 and (w is None or x2 < w) and (h is None or y2 < h)
    if not ok:
        out.errors.append('malformed_record')
        return
    out.records.append({
        'id': rec['id'],
        'box': [box[0], box[1], box[2] + 1, box[3] + 1],
        'confidence': rec.get('c'),
        'mask': rec.get('mask'),
        'w': w,
        'h': h,
    })


def parse(text, expect_w=None, expect_h=None):
    """Parse one answer. Returns a Parsed; never raises on bad input."""
    out = Parsed()
    if not isinstance(text, str):
        out.errors.append('no_frame')
        return out
    start = text.find(FRAME)
    if start < 0:
        out.errors.append('no_frame')
        return out
    if text[:start].strip():
        out.warn_once('ignored_token')
    i = start + len(FRAME)
    n = len(text)
    rec = None
    while i < n:
        m = _TAG.search(text, i)
        gap = text[i:m.start()] if m else text[i:]
        if gap.strip():
            out.warn_once('ignored_token')
        if not m:
            break
        tag = m.group(1)
        i = m.end()
        if tag == 'mask':
            env = _read_mask(text, i)
            if rec is None:
                out.errors.append('malformed_record')
            else:
                rec['mask'] = env['mask']
                rec['mask_ok'] = env['ok']
            i = env['end']
            continue
        nxt = _TAG.search(text, i)
        value = (text[i:nxt.start()] if nxt else text[i:]).strip()
        i = nxt.start() if nxt else n
        if tag == '0f':
            _finish(rec, out, out.width, out.height)
            rec = None
            continue
        if tag not in KNOWN:
            out.warn_once('ignored_field')
            continue
        if tag == 'id':
            _finish(rec, out, out.width, out.height)
            rec = {'id': int(value) if re.fullmatch(r'\d{1,6}', value) else None}
        elif tag in ('w', 'h'):
            v = int(value) if re.fullmatch(r'\d{1,5}', value) else None
            if v is None:
                if rec is not None:
                    rec['mask_ok'] = False
                else:
                    out.errors.append('malformed_record')
                continue
            if rec is None:
                if tag == 'w':
                    out.width = v
                else:
                    out.height = v
            else:
                rec[tag] = v
        elif tag == 'box':
            if rec is None:
                out.errors.append('malformed_record')
                continue
            rec['box'] = _ints(value, 4)
        elif tag == 'c':
            if rec is None:
                out.warn_once('ignored_confidence')
                continue
            try:
                c = float(value)
            except ValueError:
                c = None
            if c is None or not 0.0 <= c <= 1.0 or 'c' in rec:
                out.warn_once('ignored_confidence')
                continue
            rec['c'] = c
    _finish(rec, out, out.width, out.height)
    if expect_w is not None and expect_h is not None:
        sizes = {(r['w'], r['h']) for r in out.records}
        if out.width is not None or out.height is not None:
            sizes.add((out.width, out.height))
        if any(s != (expect_w, expect_h) for s in sizes):
            out.errors.append('size_mismatch')
    for r in out.records:
        r.pop('w', None)
        r.pop('h', None)
    return out


def _read_mask(text, i):
    """Check a mask envelope at text[i:]. Returns where it ends, whether it
    is well formed, and what is noted about it (never the payload)."""
    if text[i:i + 1] != MASK_ONE_BIT:
        nxt = _TAG.search(text, i)
        return {'end': nxt.start() if nxt else len(text), 'ok': False, 'mask': None}
    prefix = text[i + 1:i + 6]
    if len(prefix) != 5 or any(ch not in _B85_SET for ch in prefix):
        nxt = _TAG.search(text, i)
        return {'end': nxt.start() if nxt else len(text), 'ok': False, 'mask': None}
    count = _b85_value(prefix)
    body_start = i + 6
    body = text[body_start:body_start + count]
    if len(body) != count or any(ch not in _B85_SET for ch in body):
        nxt = _TAG.search(text, body_start)
        return {'end': nxt.start() if nxt else len(text), 'ok': False, 'mask': None}
    return {'end': body_start + count, 'ok': True, 'mask': {'encoding': 'one_bit', 'payload_chars': count}}
