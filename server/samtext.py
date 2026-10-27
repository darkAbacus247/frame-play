"""The sam-3.1 answer text: a frame marker, then one record per match.

The grammar below is read from sam-3.1's own answers, recorded on the first
live calls (10-27; the desk sample picture, nine calls). Each record is an
id, a box token and a mask token; later records follow a comma; a newline
may end the text:

    <0f>0<|box;x1=560;y1=383;x2=669;y2=481;w=1024;h=768;c=0.9493|><|mask;x=0;y=0;c=0.9493;data=99,110,PAYLOAD|>,1<|box;...|><|mask;...|>

- A token is <|name;key=value;...|>. Its values never hold ';', '|' or '>'
  (the payload's alphabet leaves them out), so a token ends at its first
  '|>' and its fields split on ';'.
- box: x1 y1 x2 y2 in source pixels with x2 and y2 inclusive (made
  half-open here: [x1, y1, x2 + 1, y2 + 1]); w and h, the picture's size,
  which must equal the copy that was sent; c, the confidence.
- mask: x and y (offsets), c, and data = rows,cols,PAYLOAD, where rows and
  cols are the box's own height and width. The payload's first character
  is its encoding: '!' one_bit (what this app asks for), '~' lossless (the
  API's default); the rest is in an 85-character alphabet. It is checked
  (alphabet, shape) here and kept on the record; mask_shape() decodes it
  with server/sam_mask.py, once, when the pipeline needs it: the mask's
  pixel (c, r) is the picture's pixel (x1 + x + c, y1 + y + r).
- No match at all is the frame marker alone ('<0f>', perhaps with a
  newline).

Diagnostics. Errors: no_frame (not text, or no marker), malformed_record
(the record is dropped), size_mismatch. Warnings, once per answer each:
empty_answer (no text at all, read as no match), ignored_token (text the
grammar does not have), ignored_field (an unknown key or token),
ignored_confidence (out of range, or the mask's differs from the box's),
no_mask (a record without its mask token; kept), mask_shape (the mask's
rows and cols are not the box's; the record is kept). Decoding adds one
more, mask_undecodable: the payload did not decode (the record is kept,
and its outline is traced inside its box instead).
The parser and mask_shape() never raise on bad input.
"""
import re

from server import sam_mask

FRAME = '<0f>'
# the payload alphabet, as the recorded answers use it: the printable ASCII
# characters from '!' to '~' without " , ; < > \ | } ~ (85 of them)
ALPHABET = ''.join(ch for ch in map(chr, range(33, 127)) if ch not in '",;<>\\|}~')
_ALPHABET_SET = frozenset(ALPHABET)
BOX_KEYS = ('x1', 'y1', 'x2', 'y2', 'w', 'h', 'c')
MASK_KEYS = ('x', 'y', 'c', 'data')
# the payload's first character says how it is encoded
MARKERS = {'!': 'one_bit', '~': 'lossless'}

_SEP = re.compile(r'[\s,]*')
_RECORD = re.compile(r'(\d{1,6})?<\|box;([^|<>]*)\|>(?:<\|mask;([^|<>]*)\|>)?')
_TOKEN = re.compile(r'<\|([a-z0-9_]{1,16})(?:;[^|<>]*)?\|>')
_RESYNC = re.compile(r'\d*<\|')
_INT = re.compile(r'\d{1,6}')


class Parsed:
    def __init__(self):
        self.width = None
        self.height = None
        self.records = []      # dicts: id, box (half-open), confidence, mask
        self.errors = []       # malformed_record, size_mismatch, no_frame
        self.warnings = []     # see the module's words

    def warn_once(self, code):
        if code not in self.warnings:
            self.warnings.append(code)

    def as_dict(self):
        return {'width': self.width, 'height': self.height, 'records': self.records,
                'errors': self.errors, 'warnings': self.warnings}


def _fields(body, known, out):
    """key=value fields of a token body, or None when one is not key=value
    or a key repeats. Unknown keys are noted and left out."""
    fields = {}
    for part in body.split(';') if body else []:
        key, eq, value = part.partition('=')
        if not eq or not key or key in fields:
            return None
        if key not in known:
            out.warn_once('ignored_field')
            continue
        fields[key] = value
    return fields


def _confidence(value):
    try:
        c = float(value)
    except (TypeError, ValueError):
        return None
    return c if 0.0 <= c <= 1.0 else None


def _record(rid, box_body, mask_body, out):
    """Check one record; returns it, or None after noting malformed_record."""
    box = _fields(box_body, BOX_KEYS, out)
    if rid is None or box is None or not all(k in box and _INT.fullmatch(box[k]) for k in BOX_KEYS[:6]):
        out.errors.append('malformed_record')
        return None
    x1, y1, x2, y2, w, h = (int(box[k]) for k in BOX_KEYS[:6])
    if not (0 <= x1 <= x2 < w and 0 <= y1 <= y2 < h):
        out.errors.append('malformed_record')
        return None
    c = None
    if 'c' in box:
        c = _confidence(box['c'])
        if c is None:
            out.warn_once('ignored_confidence')
    mask = None
    if mask_body is None:
        out.warn_once('no_mask')
    else:
        m = _fields(mask_body, MASK_KEYS, out)
        data = (m or {}).get('data', '').split(',', 2)
        payload = data[2] if len(data) == 3 else ''
        if m is None or len(data) != 3 or not all(_INT.fullmatch(v) for v in data[:2]) \
                or not all(_INT.fullmatch(m.get(k, '')) for k in ('x', 'y')) \
                or not payload or any(ch not in _ALPHABET_SET for ch in payload[payload[0] == '~':]):
            out.errors.append('malformed_record')
            return None
        rows, cols = int(data[0]), int(data[1])
        if (rows, cols) != (y2 - y1 + 1, x2 - x1 + 1):
            out.warn_once('mask_shape')
        if 'c' in m and _confidence(m['c']) != c:
            out.warn_once('ignored_confidence')
        mask = {'encoding': MARKERS.get(payload[0], 'unknown'), 'rows': rows, 'cols': cols,
                'x': int(m['x']), 'y': int(m['y']), 'payload_chars': len(payload),
                'left': x1, 'top': y1, 'payload': payload}
    return {'id': int(rid), 'box': [x1, y1, x2 + 1, y2 + 1], 'confidence': c, 'mask': mask, 'w': w, 'h': h}


def parse(text, expect_w=None, expect_h=None):
    """Parse one answer. Returns a Parsed; never raises on bad input."""
    out = Parsed()
    if not isinstance(text, str):
        out.errors.append('no_frame')
        return out
    if not text.strip():
        out.warn_once('empty_answer')
        return out
    start = text.find(FRAME)
    if start < 0:
        out.errors.append('no_frame')
        return out
    if text[:start].strip():
        out.warn_once('ignored_token')
    i = start + len(FRAME)
    n = len(text)
    while True:
        i = _SEP.match(text, i).end()
        if i >= n:
            break
        m = _RECORD.match(text, i)
        if m and m.group(3) is None and text.startswith('<|mask', m.end()):
            # a mask token cut short: the whole record is broken
            out.errors.append('malformed_record')
            nxt = _RESYNC.search(text, m.end() + 1)
            i = nxt.start() if nxt else n
            continue
        if m:
            rec = _record(m.group(1), m.group(2), m.group(3), out)
            if rec is not None:
                out.records.append(rec)
            i = m.end()
            continue
        m = _TOKEN.match(text, i)
        if m:
            # a mask with no box before it is a broken record; any other
            # token is one this grammar does not have
            if m.group(1) in ('box', 'mask'):
                out.errors.append('malformed_record')
            else:
                out.warn_once('ignored_field')
            i = m.end()
            continue
        nxt = _RESYNC.search(text, i + 1)
        stray = text[i:nxt.start() if nxt else n]
        # an unclosed or broken token is a broken record; other text is noise
        if '<|box' in stray or '<|mask' in stray:
            out.errors.append('malformed_record')
        else:
            out.warn_once('ignored_token')
        i = nxt.start() if nxt else n
    if out.records:
        out.width, out.height = out.records[0]['w'], out.records[0]['h']
    if expect_w is not None and expect_h is not None:
        if any((r['w'], r['h']) != (expect_w, expect_h) for r in out.records):
            out.errors.append('size_mismatch')
    for r in out.records:
        r.pop('w', None)
        r.pop('h', None)
    return out


def mask_shape(record, picture=None):
    """The game's view of a record's mask (sam_mask.mask_shape: rings with
    holes, area, bounds and occupancy grid, in picture pixels), decoded once
    and kept on the record's mask; None when there is no mask, or it does not
    decode (then mask['error'] holds the decoder's words and the caller
    notes mask_undecodable). picture, (W, H), clips the mask to it."""
    mask = record.get('mask') if isinstance(record, dict) else None
    if not mask or 'payload' not in mask:
        return None
    if 'shape' in mask:
        return mask['shape']
    shape = None
    try:
        raster = sam_mask.decode_mask(mask['encoding'], mask['payload'], mask['cols'], mask['rows'])
        width, height = mask['cols'], mask['rows']
        left, top = mask['left'] + mask['x'], mask['top'] + mask['y']
        if picture:
            raster, width, height, left, top = _clipped(raster, width, height, left, top, *picture)
        if raster is not None and any(raster):
            shape = sam_mask.mask_shape(raster, width, height, left, top)
            shape['raster'] = {'left': left, 'top': top, 'width': width, 'height': height, 'data': raster}
        else:
            mask['error'] = 'The mask holds no pixel of the picture.'
    except sam_mask.InvalidMaskError as e:
        mask['error'] = str(e)
    except (MemoryError, ValueError, TypeError, KeyError) as e:   # never raise on bad input
        mask['error'] = f'The mask could not be read ({type(e).__name__}).'
    mask['shape'] = shape
    return shape


def _clipped(raster, width, height, left, top, W, H):
    """The part of a mask that lies on the picture."""
    x0, y0 = max(0, -left), max(0, -top)
    x1, y1 = min(width, W - left), min(height, H - top)
    if x1 <= x0 or y1 <= y0:
        return None, 0, 0, left, top
    if (x0, y0, x1, y1) == (0, 0, width, height):
        return raster, width, height, left, top
    w = x1 - x0
    out = b''.join(raster[r * width + x0:r * width + x1] for r in range(y0, y1))
    return out, w, y1 - y0, left + x0, top + y0


def compose(matches, W, H, newline=True):
    """An answer text in this grammar, for the stand-in and tests. matches:
    dicts with box (inclusive [x1, y1, x2, y2]), confidence and payload (a
    real one_bit or lossless payload, marker first, or any text in the
    alphabet when the test does not decode it)."""
    parts = []
    for i, m in enumerate(matches):
        x1, y1, x2, y2 = m['box']
        c = m['confidence']
        payload = m['payload']
        if not payload or any(ch not in _ALPHABET_SET for ch in payload[payload[0] == '~':]):
            raise ValueError('payload outside the alphabet')
        parts.append(f'{i}<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={W};h={H};c={c}|>'
                     f'<|mask;x=0;y=0;c={c};data={y2 - y1 + 1},{x2 - x1 + 1},{payload}|>')
    return FRAME + ','.join(parts) + ('\n' if newline else '')
