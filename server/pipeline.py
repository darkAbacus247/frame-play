"""The live path: one muse-spark-1.3 call reads the room, then one sam-3.1
call per on-surface noun (and one for the surface), in parallel, finds every
match with an exact box, a confidence and a mask. Each kept match's mask is
decoded here (server/sam_mask.py) into its exact outline: rings with holes,
its area and bounds. The reply (schema frameplay.room.reply/2) goes back to
the page, which uses those outlines as they are (tracing inside a box only
where a mask did not decode) and builds the level. The server keeps nothing.

Rehearsal runs the same code against a loopback stand-in; it claims no
model: its calls read "REHEARSAL stand-in for ..." and its models list is
empty.
"""
import base64
import hashlib
import json
import math
import re
import threading
import time
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor

from server import config, sam_mask, samtext
from server.limits import SAM_COST, SPARK_WORST, Refusal, spark_cost
from server.meta_api import CallError, Transport, excerpt

AGAIN = 'Please try the same photo again.'

REPLY_SCHEMA = 'frameplay.room.reply/2'
ROLES = ('collect', 'avoid', 'exit', 'solid', 'flat')
PER_NOUN = {'collect': 3, 'solid': 2, 'avoid': 1, 'exit': 1, 'flat': 1}
# Muse Spark's count for a name ("chair x2") raises its role's count up to
# this, never past it: every chair is found, still one exit.
MAX_PER_NOUN = {'collect': 3, 'solid': 4, 'avoid': 2, 'exit': 1, 'flat': 2}
MAX_COUNT = 6
MAX_NAMES = 11
MAX_OBJECTS = 16
MIN_CONFIDENCE = 0.35
# Choosing among several matches for one name (choose_matches): a Muse Spark
# point counts for a match up to 3% of the picture outside it (on the desk's
# recorded answers its coin points fell 12 to 13 px beside the coins); with
# no point in any match, matches under FLOOR are dropped; and two names may
# not keep the same box (SAME_BOX: IoU of at least 0.5).
SEED_REACH = 0.03
FLOOR = 0.5
SAME_BOX = 0.5
# Spurious extra matches: with no point to go by, an extra match is kept
# only at RELATIVE of the name's best or more (the desk's real coins were
# 0.879 to 0.887; the notebook's stray match on the book stack 0.594); a
# match with no point that lies INSIDE (85%) another name's kept box is
# not a second thing. A box under MIN_SIDE px once held to the picture is
# no box.
RELATIVE = 0.75
INSIDE = 0.85
MIN_SIDE = 2
# Boxes that are the surface rather than a thing on it: named like it (the
# same last word), filling GIANT of the picture, or covering COVERS of the
# surface's box (the level side uses the same rules).
GIANT = 0.45
COVERS = 0.8
# When SAM finds nothing usable for a thing (point_regions): a region around
# Muse Spark's points, grown by 5% of the long side; points to collect less
# than 10% apart are one thing.
POINT_MARGIN = 0.05
POINT_GROUP = 0.10
# SAM calls at once for one photo, the exit and the things to collect first
SAM_WORKERS = 4
# How the camera sees the room (Muse Spark's read); how many of its points on
# the open floor are kept; how many of SAM's floor matches (one a room, in a
# floor plan) go to the page, which grows the floor inside them.
VIEWS = ('eye_level', 'top_down', 'angled')
MAX_FLOOR_SEEDS = 12
MAX_FLOOR_BOXES = 8
JOB_ORDER = {'exit': 0, 'collect': 1, 'surface': 2, 'avoid': 3, 'solid': 4, 'flat': 5}

PROMPT = """You are reading one photo of a room or a desk top for a small game.
An explorer will walk on ONE play surface (such as floor, desk, table, bed or counter).
Things standing on that surface become walls the explorer walks around; one of them is
the exit, one to three are things to collect, and zero to two are things to avoid.

Return JSON only, in the given schema:
- people_present: true if any person or part of a person is visible. If true, the
  other fields may be empty.
- surface.name: one noun phrase for the play surface that an image segmenter can find.
  In a top-down picture of rooms (a floor plan, a photo from above) it is "floor".
- view: how the camera sees it: eye_level (taken standing or sitting), top_down (straight
  down, such as a floor plan) or angled (from high up, at a slant).
- floor_seeds: points on bare, open play surface, on the 0 to 1000 grid: at least one in
  every room or floor area you can see (more where furniture or walls split it), never on
  a thing standing on it, a rug or a wall.
- objects: 1 to 11 kinds of things you can see, one entry for each kind. For each:
  - name: 1 to 3 words, one singular generic noun phrase an image segmenter finds every
    one of (such as "chair", "coffee table", "mug", "desk lamp"): the plain word for the
    kind, no brand, style, colour or material unless two kinds need telling apart. Give
    two chairs one entry "chair", never "wooden chair" and "armchair" for the same kind.
    No lists, no spatial words (left, top, behind ...), no people or body words.
  - count: how many of this kind you can see (1 or more); put a seed on each one.
  - role: exactly one of collect, avoid, exit, solid, flat. Propose exactly one exit,
    1 to 3 collect and 0 to 2 avoid; the rest are solid (an obstacle) or flat (part of
    the surface, such as a rug or paper).
  - reason: why, in 80 characters or fewer, playful and plain.
  - on_surface: true if it stands or lies on the play surface; false for scenery such
    as a picture on the wall or a ceiling lamp.
  - seeds: up to 6 points, one on each of the kind's things (a few on a single big one), on a
    0 to 1000 grid over the photo (x right, y down).
- title: a game title for this room, 60 characters or fewer.
- theme_line: one line of story, 120 characters or fewer."""

SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['people_present', 'surface', 'view', 'floor_seeds', 'objects', 'title', 'theme_line'],
    'properties': {
        'people_present': {'type': 'boolean'},
        'surface': {
            'type': 'object', 'additionalProperties': False, 'required': ['name'],
            'properties': {'name': {'type': 'string'}},
        },
        'view': {'type': 'string', 'enum': list(VIEWS)},
        'floor_seeds': {
            'type': 'array',
            'items': {
                'type': 'object', 'additionalProperties': False, 'required': ['x', 'y'],
                'properties': {'x': {'type': 'integer'}, 'y': {'type': 'integer'}},
            },
        },
        'objects': {
            'type': 'array',
            'items': {
                'type': 'object', 'additionalProperties': False,
                'required': ['name', 'count', 'role', 'reason', 'on_surface', 'seeds'],
                'properties': {
                    'name': {'type': 'string'},
                    'count': {'type': 'integer'},
                    'role': {'type': 'string', 'enum': list(ROLES)},
                    'reason': {'type': 'string'},
                    'on_surface': {'type': 'boolean'},
                    'seeds': {
                        'type': 'array',
                        'items': {
                            'type': 'object', 'additionalProperties': False, 'required': ['x', 'y'],
                            'properties': {'x': {'type': 'integer'}, 'y': {'type': 'integer'}},
                        },
                    },
                },
            },
        },
        'title': {'type': 'string'},
        'theme_line': {'type': 'string'},
    },
}

PROGRESS = (('read', 'Reading your room'), ('find', 'Finding every object'))
PEOPLE_WORDS = ('This photo seems to show a person (people in posters, screens, framed photos and mirrors count too). '
                'Please use one with no people.')
# Errors after which the same photo, sent again, may well be read: passing
# faults on the way, and answers that came out wrong this time. The reply
# says so in error.retry_same.
RETRY_SAME = {'busy', 'sam_busy', 'sam_unavailable', 'cut_off', 'malformed', 'server_error', 'names_unusable'}


def sentence(words):
    """Words that end as a sentence ends, so the page's own words read on."""
    words = str(words).strip()
    return words if not words or words[-1] in '.!?' else words + '.'


def reply_error(error):
    """An error for a reply: whole sentences, and whether the same photo,
    sent again, could be read (by its code, unless the error says)."""
    retry = error.get('retry_same')
    return {**error, 'message': sentence(error.get('message', '')),
            'retry_same': bool(error.get('code') in RETRY_SAME if retry is None else retry)}
NAMES_WORDS = f"Muse Spark's names for the things in this photo could not be used. {AGAIN}"
CUT_OFF_WORDS = ('The room read was cut off before it finished. Please try the same photo again; '
                 'a photo with fewer things in it reads faster.')

# Words of relation only: "side table", "front door", "top hat" and
# "corner shelf" are things.
SPATIAL = {'left', 'right', 'behind', 'under', 'above', 'below', 'beside', 'near', 'next', 'on', 'in', 'at',
           'between', 'inside', 'underneath', 'beneath', 'atop', 'against'}
# A people or body word is the thing only when it is the whole name or its
# last word: "hand" and "chair leg" go, "hand towel", "arm chair" and
# "baby crib" stay.
PEOPLE = {'person', 'people', 'man', 'men', 'woman', 'women', 'child', 'children', 'kid', 'kids', 'boy', 'girl', 'baby',
          'human', 'face', 'head', 'hand', 'hands', 'arm', 'arms', 'leg', 'legs', 'foot', 'feet', 'finger', 'fingers',
          'body', 'hair', 'eye', 'eyes', 'mouth', 'selfie', 'someone', 'me', 'you', 'him', 'her', 'them'}
LIST_WORDS = {'and', 'or', 'with', 'plus'}
# Words of letters (accents too) and digits, joined inside by ' or -.
WORD = r"[^\W_]+(?:['-][^\W_]+)*"


def name_problem(name):
    """Why a noun cannot go to SAM, or None when it can."""
    words = name.split()
    if not 1 <= len(words) <= 3:
        return 'not 1 to 3 words'
    if any(w in LIST_WORDS for w in words) or ',' in name or '/' in name or '&' in name:
        return 'a list'
    if not re.fullmatch(f'{WORD}(?: {WORD})*', name) or not any(ch.isalpha() for ch in name):
        return 'not a plain noun phrase'
    if any(w in SPATIAL for w in words):
        return 'a spatial word'
    if words[-1] in PEOPLE:
        return 'a people or body word'
    return None


def normalize_name(raw):
    text = unicodedata.normalize('NFC', str(raw)).replace('’', "'")
    return re.sub(r'\s+', ' ', text.strip().lower())


def clip(text, n):
    text = re.sub(r'\s+', ' ', str(text)).strip()
    return text if len(text) <= n else text[:n - 1].rstrip() + '…'


def spark_body(data_url):
    return {
        'model': config.SPARK_MODEL,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': PROMPT},
                {'type': 'image_url', 'image_url': {'url': data_url}},
            ],
        }],
        'response_format': {'type': 'json_schema', 'json_schema': {'name': 'room_read', 'strict': True, 'schema': SCHEMA}},
        'reasoning_effort': 'low',
        'max_completion_tokens': config.SPARK_MAX_COMPLETION_TOKENS,
    }


def sam_body(noun, data_url):
    return {
        'model': config.SAM_MODEL,
        'input': [{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': noun},
                {'type': 'input_image', 'image_url': data_url},
            ],
        }],
        'stream': False,
        'store': False,
        'metadata': {'mask_encoding': 'one_bit', 'include_confidence': 'true'},
    }


def read_spark(j, holder=None):
    """The read of the room from a chat completion. Raises CallError."""
    try:
        choice = j['choices'][0]
        finish = choice.get('finish_reason')
        message = choice['message']
        content = message.get('content')
    except (KeyError, IndexError, TypeError, AttributeError):
        raise CallError('malformed', f'The room read came back in an unexpected shape. {AGAIN}', excerpt=excerpt(json.dumps(j)[:600], holder)) from None
    refusal = message.get('refusal')
    if finish == 'content_filter' or (isinstance(refusal, str) and refusal.strip()):
        raise CallError('content_filter', 'Muse Spark declined to read this photo.', billed=True,
                        **({'excerpt': excerpt(refusal, holder)} if isinstance(refusal, str) and refusal.strip() else {}))
    if finish == 'length':
        # cut off at the output cap: half a JSON object, said as what it is
        raise CallError('cut_off', CUT_OFF_WORDS, billed=True, transient=True,
                        excerpt=excerpt(content, holder) if isinstance(content, str) else None)
    if isinstance(content, list):
        content = ''.join(p.get('text', '') for p in content if isinstance(p, dict))
    if content is None or (isinstance(content, str) and not content.strip()):
        raise CallError('malformed', f'The room read came back empty. {AGAIN}')
    try:
        read = json.loads(content)
    except (TypeError, ValueError):
        raise CallError('malformed', f'The room read was not valid JSON. {AGAIN}', excerpt=excerpt(content, holder)) from None
    if not isinstance(read, dict) or not isinstance(read.get('people_present'), bool):
        raise CallError('malformed', f'The room read is missing its fields. {AGAIN}', excerpt=excerpt(content, holder))
    usage = j.get('usage') or {}
    tin = int(usage.get('prompt_tokens') or 0)
    tout = int(usage.get('completion_tokens') or 0)
    details = usage.get('completion_tokens_details') or {}
    reasoning = int(details.get('reasoning_tokens') or 0) if isinstance(details, dict) else 0
    return read, tin, tout, reasoning


def grid_points(raw, W, H, n):
    """Points on Muse Spark's 0 to 1000 grid, in pixels; at most n."""
    out = []
    for s in (raw if isinstance(raw, list) else [])[:n]:
        if isinstance(s, dict) and isinstance(s.get('x'), int) and isinstance(s.get('y'), int) \
                and 0 <= s['x'] <= 1000 and 0 <= s['y'] <= 1000:
            out.append([round(s['x'] * W / 1000, 1), round(s['y'] * H / 1000, 1)])
    return out


def clean_read(read, W, H, warnings):
    """Keep what the server accepts from the read: names SAM can find, roles,
    reasons of 80 characters, seeds in pixels, how many of each (None when
    the read does not say). Merges repeated names, adding their counts."""
    objs = []
    by_name = {}
    unusable = 0  # things on the surface whose names were dropped
    raw = read.get('objects') if isinstance(read.get('objects'), list) else []
    for o in raw[:MAX_NAMES]:
        if not isinstance(o, dict):
            continue
        name = normalize_name(o.get('name', ''))
        why = name_problem(name)
        if why:
            warnings.append(f'dropped the name "{clip(name, 40)}": {why}')
            unusable += o.get('on_surface') is not False
            continue
        role = o.get('role') if o.get('role') in ROLES else 'solid'
        seeds = grid_points(o.get('seeds'), W, H, MAX_COUNT)
        c = o.get('count')
        count = min(MAX_COUNT, c) if isinstance(c, int) and not isinstance(c, bool) and c >= 1 else None
        if name in by_name:
            e = by_name[name]
            e['seeds'] = (e['seeds'] + seeds)[:MAX_COUNT]
            if count is not None:
                e['count'] = min(MAX_COUNT, (e['count'] or 0) + count)
            continue
        entry = {'name': name, 'role': role, 'reason': clip(o.get('reason', ''), 80),
                 'on_surface': o.get('on_surface') is not False, 'seeds': seeds, 'count': count}
        by_name[name] = entry
        objs.append(entry)
    surface = normalize_name((read.get('surface') or {}).get('name', '')) if isinstance(read.get('surface'), dict) else ''
    if surface and name_problem(surface):
        warnings.append(f'dropped the surface name "{clip(surface, 40)}"')
        surface = ''
    return {
        'title': clip(read.get('title', ''), 60),
        'theme_line': clip(read.get('theme_line', ''), 120),
        'surface': surface,
        # an earlier read (or a word not in the list) says nothing of the view
        'view': read.get('view') if read.get('view') in VIEWS else None,
        'floor_seeds': grid_points(read.get('floor_seeds'), W, H, MAX_FLOOR_SEEDS),
        'objects': objs,
        'unusable': unusable,
    }


def sam_text(j):
    """The answer text of a Responses call."""
    if isinstance(j, dict):
        if isinstance(j.get('output_text'), str):
            return j['output_text']
        for item in j.get('output') or []:
            for part in (item.get('content') or []) if isinstance(item, dict) else []:
                if isinstance(part, dict) and part.get('type') in ('output_text', 'text') and isinstance(part.get('text'), str):
                    return part['text']
    return None


def _conf(r):
    return r['confidence'] if r['confidence'] is not None else 0.0


def _rank(r):
    return (-_conf(r), -((r['box'][2] - r['box'][0]) * (r['box'][3] - r['box'][1])), r['id'])


def choose(records, role):
    """Matches at or above 0.35, ranked by confidence then area, up to the
    role's count."""
    keep = sorted((r for r in records if _conf(r) >= MIN_CONFIDENCE), key=_rank)
    return keep[:PER_NOUN.get(role, 1)]


def surface_from(records):
    """The play surface: one box around all of its matches at or above 0.35
    (a floor split by a rug or a shadow is still one floor; a floor plan's
    floor is one match a room), with the best confidence, and the matches'
    own boxes, most confident first (at most MAX_FLOOR_BOXES); or None."""
    keep = sorted((r for r in records if _conf(r) >= MIN_CONFIDENCE), key=_rank)
    if not keep:
        return None
    boxes = [r['box'] for r in keep]
    return {'box': [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)],
            'confidence': max(_conf(r) for r in keep), 'matches': len(keep), 'boxes': boxes[:MAX_FLOOR_BOXES],
            'records': keep[:MAX_FLOOR_BOXES]}


def floor_mask(shapes, W, H):
    """SAM's floor: the decoded masks of its floor matches laid on the
    picture together (a pixel is floor when any match holds it), as the
    game's shapes: rings (the floor's outline and its holes, which are the
    footprints of the things standing on it), area and bounds; None for no
    floor pixel."""
    full = bytearray(W * H)
    for shape in shapes:
        r = shape['raster']
        w, data = r['width'], r['data']
        for row in range(r['height']):
            line = data[row * w:(row + 1) * w]
            if 1 not in line:
                continue
            at = (r['top'] + row) * W + r['left']
            full[at:at + w] = bytes(a | b for a, b in zip(full[at:at + w], line))
    if 1 not in full:
        return None
    shape = sam_mask.mask_shape(bytes(full), W, H)
    return {'rings': shape['rings'], 'area': shape['area'], 'bounds': shape['bounds'], 'matches': len(shapes)}


def _reach(p, box, W, H):
    """How far a point lies outside a half-open box, as a share of the
    picture's width or height (the larger); 0 inside."""
    x0, y0, x1, y1 = box
    dx = max(x0 - p[0], p[0] - x1, 0.0)
    dy = max(y0 - p[1], p[1] - y1, 0.0)
    return max(dx / W, dy / H)


def role_cap(role, count=None):
    """How many matches one name keeps: its role's count, raised by Muse
    Spark's own count for it up to MAX_PER_NOUN (one exit, ever)."""
    cap = PER_NOUN.get(role, 1)
    return min(MAX_PER_NOUN.get(role, 1), max(cap, count)) if count else cap


def on_mask(shape, p):
    """Whether point p (picture pixels) falls on one of a decoded mask's pixels."""
    raster = shape and shape.get('raster')
    if not raster:
        return False
    c, r = math.floor(p[0]) - raster['left'], math.floor(p[1]) - raster['top']
    return 0 <= c < raster['width'] and 0 <= r < raster['height'] and raster['data'][r * raster['width'] + c] == 1


def choose_matches(records, seeds, role, W, H, count=None, holds=None):
    """Which of SAM's matches for one name are this object. A match that
    holds one of Muse Spark's points for it is kept (each point picks the
    match whose mask it falls on, else the match whose box it falls in, or
    the nearest within SEED_REACH of the picture, since the points are
    rough; holds(record, point) says whether the point is on the record's
    mask pixels, and is asked only of matches in reach); when Muse Spark counted more of them than its
    points found ("chair x2" with a point on one chair), the most confident
    other matches at or above FLOOR (and RELATIVE of the best) make up the
    count; with no point in any match, the most confident matches at or
    above FLOOR. Never more than role_cap keeps.
    Returns (kept, dropped): kept as (record, seeded), dropped as (record, why)."""
    cap = role_cap(role, count)
    usable = sorted((r for r in records if _conf(r) >= MIN_CONFIDENCE), key=_rank)
    dropped = [(r, 'low') for r in records if _conf(r) < MIN_CONFIDENCE]
    picked = []
    for p in seeds:
        near = [(_reach(p, r['box'], W, H), k) for k, r in enumerate(usable)]
        near = [x for x in near if x[0] <= SEED_REACH]
        if near and holds is not None and len(near) > 1:
            on = [x for x in near if holds(usable[x[1]], p)]
            near = on or near
        if near:
            k = min(near)[1]
            if k not in picked:
                picked.append(k)
    if picked:
        kept = [(usable[k], True) for k in sorted(picked)]
        best = _conf(usable[0])
        more = [k for k, r in enumerate(usable) if k not in picked]
        if count and len(picked) < min(count, cap):
            # the rest of the count: matches no point fell in, most
            # confident first, each a thing of its own (not the same box)
            for k in more:
                r = usable[k]
                if len(kept) >= min(count, cap):
                    break
                if _conf(r) < FLOOR or _conf(r) < RELATIVE * best:
                    continue
                if any(iou(r['box'], s['box']) >= SAME_BOX for s, _ in kept):
                    continue
                kept.append((r, False))
        taken = {id(r) for r, _ in kept}
        dropped += [(r, 'no_point') for k, r in enumerate(usable) if k not in picked and id(r) not in taken]
    else:
        best = _conf(usable[0]) if usable else 0.0
        kept = [(r, False) for r in usable if _conf(r) >= FLOOR and _conf(r) >= RELATIVE * best]
        dropped += [(r, 'below_floor') for r in usable if _conf(r) < FLOOR]
        dropped += [(r, 'relative') for r in usable if _conf(r) >= FLOOR and _conf(r) < RELATIVE * best]
    # two matches of one name on the same thing are one thing
    single = []
    for r, seeded in kept:
        if any(iou(r['box'], s['box']) >= SAME_BOX for s, _ in single):
            dropped.append((r, 'twice'))
        else:
            single.append((r, seeded))
    dropped += [(r, 'over_count') for r, _ in single[cap:]]
    return single[:cap], dropped


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def inside(a, b):
    """The share of box a that lies in box b."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = (a[2] - a[0]) * (a[3] - a[1])
    return ix * iy / area if area else 0.0


def settle_claims(picks):
    """One box is never two objects: of matches of different names that
    cover the same thing (IoU at least SAME_BOX), the one holding a Muse
    Spark point wins, then the more confident, then the earlier name. A
    match holding no point that lies INSIDE a box kept for another name is
    a part of that thing, not a second one (a coin Muse Spark pointed at
    may still lie on a notebook).
    picks: [(order, name, record, seeded)]. Returns (kept, lost) where lost
    holds (pick, the name that kept the box, 'same_box' or 'inside')."""
    ranked = sorted(picks, key=lambda q: (not q[3], -_conf(q[2]), q[0], q[2]['id']))
    kept, lost = [], []
    for q in ranked:
        rival = next((k for k in kept if k[1] != q[1] and iou(k[2]['box'], q[2]['box']) >= SAME_BOX), None)
        if rival:
            lost.append((q, rival[1], 'same_box'))
            continue
        rival = None if q[3] else next((k for k in kept if k[1] != q[1] and inside(q[2]['box'], k[2]['box']) >= INSIDE), None)
        if rival:
            lost.append((q, rival[1], 'inside'))
        else:
            kept.append(q)
    return kept, lost


def held(box, W, H):
    """A box held to the picture on every side, in whole pixels, or None
    when less than MIN_SIDE px of it is left."""
    try:
        x0, y0, x1, y1 = (int(round(float(v))) for v in box)
    except (TypeError, ValueError):
        return None
    x0, x1 = max(0, min(W, x0)), max(0, min(W, x1))
    y0, y1 = max(0, min(H, y0)), max(0, min(H, y1))
    if x1 - x0 < MIN_SIDE or y1 - y0 < MIN_SIDE:
        return None
    return [x0, y0, x1, y1]


def held_records(records, W, H):
    """SAM's records with their boxes held to the picture; (kept, emptied)."""
    kept, emptied = [], []
    for r in records:
        box = held(r['box'], W, H)
        (kept if box else emptied).append({**r, 'box': box or r['box']})
    return kept, emptied


def head(name):
    """A name's last word, without a plural s: 'desk lamp' is a lamp."""
    words = str(name).strip().lower().split()
    return words[-1].removesuffix('s') if words else ''


def surface_like(name, box, surface_name, surface_box, W, H):
    """Why a thing's box is really the play surface, or None: named like the
    surface (by its last word only), filling most of the picture, or
    covering most of the surface's box."""
    if surface_name and head(name) == head(surface_name):
        return 'named'
    area = (box[2] - box[0]) * (box[3] - box[1])
    if area >= GIANT * W * H:
        return 'giant'
    if surface_box:
        s_area = (surface_box[2] - surface_box[0]) * (surface_box[3] - surface_box[1])
        if s_area and inside(surface_box, box) >= COVERS:
            return 'covers'
    return None


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def point_regions(seeds, role, W, H, count=None):
    """Where to trace a thing SAM did not find: around Muse Spark's own
    points for it, as half-open boxes with the points they hold. (A point
    may lie inside a box SAM found for another name: a coin on a notebook.)
    Things to collect may be several (Muse Spark gives a point on each
    coin), and so may anything Muse Spark counted more than one of ("chair
    x2"), so their points form one region per group of points closer than
    POINT_GROUP of the picture's long side; any other one is one region.
    Each region is the points' bounds grown by POINT_MARGIN of the long side:
    smaller than the thing may be, and said to be what it is."""
    pts = list(seeds)
    if not pts:
        return []
    side = max(W, H)
    several = role == 'collect' or (count or 1) > 1
    groups = []
    for p in pts:
        g = next((g for g in groups if several and any(math.dist(p, q) <= POINT_GROUP * side for q in g)), None)
        if g is None and groups and not several:
            g = groups[0]
        if g is None:
            groups.append([p])
        else:
            g.append(p)
    m = max(16, round(POINT_MARGIN * side))
    out = []
    for g in groups[:role_cap(role, count)]:
        xs, ys = [p[0] for p in g], [p[1] for p in g]
        box = [max(0, math.floor(min(xs)) - m), max(0, math.floor(min(ys)) - m),
               min(W, math.floor(max(xs)) + 1 + m), min(H, math.floor(max(ys)) + 1 + m)]
        out.append((box, g))
    return out


DROP_WORDS = {
    'low': 'its confidence was under 0.35',
    'no_point': 'none of Muse Spark’s points for it fell in it',
    'below_floor': 'its confidence was under 0.5',
    'over_count': 'more matches than its role keeps',
    'relative': 'its confidence was far under its best match’s',
    'twice': 'it is the same thing as a better match',
    'empty_box': 'its box held to the picture is empty',
}
SURFACE_WORDS = {
    'named': 'it is the play surface',
    'giant': 'it fills most of the picture, so it is part of the play surface',
    'covers': 'it covers most of the play surface, so it is part of it',
}

SAM_BUSY_WORDS = 'SAM 3.1 is busy right now. Please try the same photo again in a minute.'
SAM_UNAVAILABLE_WORDS = 'SAM 3.1 could not be reached just now. Please try the same photo again in a minute.'
SAM_UNREADABLE_WORDS = "SAM 3.1 answered in a form this app could not read. This is the app's fault, not your photo's."
NOTHING_FOUND_WORDS = ('SAM 3.1 found none of the things Muse Spark named, and Muse Spark gave no points to trace '
                       'around instead. Try another photo with clearer edges.')


def first_sentence(words):
    """An error's words without its advice, for a warning's brackets."""
    return re.split(r'(?<=[.!?])\s', str(words).strip(), maxsplit=1)[0].rstrip('.')


def unreadable(parsed):
    """An answer that came back but could not be read at all: no frame, only
    broken records, or a picture of another size."""
    return parsed is not None and ('size_mismatch' in parsed.errors or (
        not parsed.records and ('no_frame' in parsed.errors or 'malformed_record' in parsed.errors)))


def sam_failure(errs):
    """The error for SAM calls that failed (never the photo's fault), or None
    when one of them failed for good (not a passing fault)."""
    if not errs or not all(getattr(e, 'transient', False) for e in errs):
        return None
    if all(getattr(e, 'status', None) == 429 for e in errs):
        return {'code': 'sam_busy', 'message': SAM_BUSY_WORDS}
    return {'code': 'sam_unavailable', 'message': SAM_UNAVAILABLE_WORDS}


class Pipeline:
    def __init__(self, settings, limits, log=None, transport=None, clock=time.monotonic, sleep=time.sleep):
        self.settings = settings
        self.limits = limits
        self.log = log
        self.transport = transport or Transport(settings.base, settings.credential())
        self.clock = clock
        self.sleep = sleep

    # ---- the HTTP side ----
    def handle(self, handler, photo, stream):
        try:
            self.limits.admit()
        except Refusal as e:
            extra = {'Retry-After': str(e.retry_after)} if e.retry_after else {}
            return handler.send_json(429, {'schema': REPLY_SCHEMA, 'status': 'refused',
                                           'error': reply_error({'code': e.code, 'message': e.message})}, extra)
        done = []

        def finish():
            # the photo's place is free before its reply is sent, so a page
            # that sends the next photo at once is not told to wait
            if not done:
                done.append(1)
                self.limits.finish()
        try:
            if not stream:
                reply = self.run(photo)
                finish()
                return handler.send_json(200, reply)
            handler.send_response(200)
            handler.common_headers()
            handler.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
            handler.send_header('Cache-Control', 'no-store')
            # chunked, ended by its terminating chunk: the browser knows the
            # reply is whole, rather than meeting a closed connection
            handler.send_header('Transfer-Encoding', 'chunked')
            handler.send_header('Connection', 'close')
            handler.end_headers()
            handler.close_connection = True

            def chunk(data):
                try:
                    handler.wfile.write(b'%x\r\n' % len(data) + data + b'\r\n')
                    handler.wfile.flush()
                except OSError:
                    pass

            def line(obj):
                text = config.redact(json.dumps(obj, ensure_ascii=False), self.settings.key)
                chunk(text.encode('utf-8') + b'\n')

            try:
                reply = self.run(photo, progress=lambda stage, words: line({'type': 'progress', 'stage': stage, 'words': words, 'mode': self.settings.mode}))
            except Exception as e:  # noqa: BLE001 - after the headers, the stream itself must say so
                if self.log is not None:
                    self.log.write(event='photo_failed', error=type(e).__name__)
                reply = self.failed_reply()
            finish()
            line({'type': 'reply', 'reply': reply})
            # Ask the room: the reply is on the page and the round can start;
            # the riddles are written after it, with the photo still here
            if self.settings.riddles and self.settings.mode in ('live', 'rehearsal'):
                line({'type': 'riddles', 'riddles': self.riddles(photo, reply)})
            chunk(b'')  # the terminating chunk: 0, then an empty line
        finally:
            finish()

    def riddles(self, photo, reply):
        """The riddles line for a reply already sent (server/riddles.py)."""
        from server import riddles  # riddles.py reads this module's own words
        try:
            return riddles.run_riddles(self, photo, reply)
        except Exception as e:  # noqa: BLE001 - the room is already on the page
            if self.log is not None:
                self.log.write(event='riddles_failed', error=type(e).__name__)
            return riddles.riddles_error_line(self, reply)

    def failed_reply(self):
        """A read that broke after the stream began: an error reply in this
        server's mode, in words, with nothing in it to build from."""
        s = self.settings
        prov = {'mode': s.mode, 'label': s.label, 'models': [], 'calls': [], 'image_retained': False}
        if s.mode == 'rehearsal':
            prov['rehearsal'] = {'stand_in_base': s.base, 'room': s.rehearsal_room}
        return {'schema': REPLY_SCHEMA, 'request_id': uuid.uuid4().hex, 'status': 'error', 'provenance': prov,
                'objects': [], 'warnings': [],
                'error': reply_error({'code': 'server_error', 'message': 'The server could not finish reading this photo. Please try again.'})}

    # ---- the pipeline ----
    def model_words(self, model):
        return f'REHEARSAL stand-in for {model}' if self.settings.mode == 'rehearsal' else model

    def run(self, photo, progress=None):
        s = self.settings
        started = time.time()
        deadline = self.clock() + config.PHOTO_TIMEOUT_S
        rid = uuid.uuid4().hex
        data = photo['bytes']
        W, H = photo['width'], photo['height']
        sha = hashlib.sha256(data).hexdigest()
        data_url = f'data:{photo["type"]};base64,' + base64.b64encode(data).decode('ascii')
        calls = []
        warnings = []
        usage = {'calls': 0, 'spark_calls': 0, 'sam_calls': 0, 'tokens_in': 0, 'tokens_out': 0, 'reasoning_tokens': 0, 'estimated_usd': 0.0}
        lock = threading.Lock()
        stages = {}
        found = {}
        # each mask is decoded once, and only while the photo has time left;
        # one that does not decode (or has no time) is noted on its call and
        # the page traces inside the box instead
        mask_notes = {}

        def shape_of(record, noun):
            # noun: the call to note a failure on (None: the call is noted elsewhere)
            if record.get('mask') is None:
                return None
            if 'shape' not in record['mask'] and self.clock() >= deadline:
                if noun:
                    mask_notes.setdefault(noun, set()).add('mask_time')
                return None
            shape = samtext.mask_shape(record, (W, H))
            if shape is None and noun:
                mask_notes.setdefault(noun, set()).add('mask_undecodable')
            return shape

        def reply(status, error=None, scene=None, surface=None, objects=None, floor=None):
            r = {
                'schema': REPLY_SCHEMA,
                'request_id': rid,
                'status': status,
                'provenance': {
                    'mode': s.mode,
                    'label': s.label,
                    'models': list(config.MODELS) if s.mode == 'live' else [],
                    'stand_in_for': list(config.MODELS) if s.mode == 'rehearsal' else [],
                    'calls': calls,
                    'image_sha256': sha,
                    'image_retained': False,
                    'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(started)),
                    'total_ms': int((time.time() - started) * 1000),
                },
                'received': {'bytes': len(data), 'type': photo['type'], 'width': W, 'height': H,
                             'metadata_bytes_removed': photo.get('metadata_bytes_removed', 0), 'retained': False},
                'scene': scene,
                'surface': surface,
                'floor': floor,
                'objects': objects or [],
                'usage': {**usage, 'estimated_usd': round(usage['estimated_usd'], 5)},
                'warnings': warnings,
                'error': reply_error(error) if error is not None else None,
            }
            if s.mode == 'rehearsal':
                r['provenance']['rehearsal'] = {'stand_in_base': s.base, 'room': s.rehearsal_room}
            if found:
                who = 'The stand-in for SAM 3.1' if s.mode == 'rehearsal' else 'SAM 3.1'
                masks = ''
                if found['sam']:
                    traced = found['sam'] - found['masks']
                    masks = (f'; its masks give {found["masks"]} exact outline{"" if found["masks"] == 1 else "s"}'
                             + (f', and code traces {traced} inside {"its box" if traced == 1 else "their boxes"}' if traced else ''))
                more = f'; for {found["points"]} more, code traces around Muse Spark’s points' if found['points'] else ''
                r['provenance']['found'] = {**found, 'words': f'{who} found {found["sam"]}{masks}{more}.'}
            self._log_photo(r, stages)
            return r

        def note(stage, model, status, ms, attempt, **extra):
            with lock:
                calls.append({'stage': stage, 'model': self.model_words(model), 'status': status, 'ms': ms, 'attempt': attempt, **extra})

        # stage 2: read the room
        if progress:
            progress(*PROGRESS[0])
        try:
            res = self.limits.reserve(SPARK_WORST)
        except Refusal as e:
            stages['read'] = 'spend_stop'
            return reply('refused', {'code': e.code, 'message': e.message})
        t0 = self.clock()
        try:
            j, attempt, ms = self.transport.post('/chat/completions', spark_body(data_url), deadline, self.sleep, self.clock)
            read, tin, tout, reasoning = read_spark(j, s.key)
        except CallError as e:
            if e.billed:
                self.limits.settle(res, None)
                usage['estimated_usd'] += res.usd
            else:
                self.limits.release(res)
            usage['calls'] += 1
            usage['spark_calls'] += 1
            extra = {'error': e.code}
            if e.excerpt:
                extra['excerpt'] = e.excerpt
            note('read', config.SPARK_MODEL, e.status or e.code, int((self.clock() - t0) * 1000), getattr(e, 'attempt', 1), **extra)
            stages['read'] = e.code
            if e.code == 'content_filter':
                return reply('refused', {'code': 'content_filter', 'message': 'Muse Spark declined to read this photo. Please try another one.'})
            # the answer's HTTP status, so the page can tell a refused key
            # (401) from other errors; an account or model problem turns the
            # picker off
            # the same photo again may well be read after a passing fault or
            # an answer that came out wrong this time
            latched = getattr(e, 'latched', False)
            code = 'live_unavailable' if latched else e.code
            retry = not latched and (getattr(e, 'transient', False) or e.code in RETRY_SAME)
            return reply('error', {'code': code, 'message': e.message, 'retry_same': retry,
                                   **({'status': e.status} if isinstance(e.status, int) else {})})
        cost = spark_cost(tin, tout)
        self.limits.settle(res, cost)
        usage.update(calls=usage['calls'] + 1, spark_calls=1, tokens_in=tin, tokens_out=tout, reasoning_tokens=reasoning)
        usage['estimated_usd'] += cost
        note('read', config.SPARK_MODEL, 200, ms, attempt, tokens_in=tin, tokens_out=tout, usd=round(cost, 5))
        stages['read'] = 'ok'

        if read['people_present']:
            stages['people'] = 'refused'
            return reply('refused', {'code': 'people_present', 'message': PEOPLE_WORDS},
                         scene={'title': '', 'theme_line': '', 'people_present': True})
        room = clean_read(read, W, H, warnings)
        scene = {'title': room['title'], 'theme_line': room['theme_line'], 'people_present': False, 'view': room['view'],
                 'scenery': [{'name': o['name'], 'reason': o['reason']} for o in room['objects'] if not o['on_surface']]}
        on = [o for o in room['objects'] if o['on_surface']]
        if not on and room['unusable']:
            # Muse Spark saw things, but named none of them in a way SAM can
            # look for: not the photo's fault
            stages['read'] = 'names'
            return reply('error', {'code': 'names_unusable', 'message': NAMES_WORDS}, scene=scene)
        if not on:
            stages['read'] = 'nothing'
            return reply('error', {'code': 'nothing_found', 'message': 'Muse Spark found nothing standing on a surface in this photo. Try another photo.'}, scene=scene)

        # stage 3: find every object
        if progress:
            progress(*PROGRESS[1])
        # over the call ceiling, the exit and the things to collect go first
        ranked = sorted(on, key=lambda o: JOB_ORDER.get(o['role'], 9))
        nouns = [o['name'] for o in ranked][:config.SAM_CALLS_PER_PHOTO - (1 if room['surface'] else 0)]
        role_of = {o['name']: o['role'] for o in on}
        jobs = ([('surface', room['surface'])] if room['surface'] else []) + [('object', n) for n in nouns]
        jobs.sort(key=lambda job: JOB_ORDER['surface'] if job[0] == 'surface' else JOB_ORDER.get(role_of[job[1]], 9))
        answers = {}

        def find(job):
            kind, noun = job
            try:
                r = self.limits.reserve(SAM_COST)
            except Refusal as e:
                return job, None, e
            t = self.clock()
            try:
                j, attempt, ms = self.transport.post('/responses', sam_body(noun, data_url), deadline, self.sleep, self.clock)
            except CallError as e:
                if e.billed:
                    self.limits.settle(r, None)
                else:
                    self.limits.release(r)
                note('find', config.SAM_MODEL, e.status or e.code, int((self.clock() - t) * 1000), getattr(e, 'attempt', 1),
                     noun=noun, error=e.code, **({'excerpt': e.excerpt} if e.excerpt else {}),
                     **({'surface': True} if kind == 'surface' else {}))
                return job, None, e
            self.limits.settle(r, SAM_COST)
            text = sam_text(j)
            parsed = samtext.parse(text, W, H)
            extra = {'noun': noun, 'matches': len(parsed.records), 'usd': SAM_COST}
            if kind == 'surface':
                extra['surface'] = True
            if parsed.errors:
                extra['diagnostics'] = parsed.errors + parsed.warnings
                if 'no_frame' in parsed.errors or 'size_mismatch' in parsed.errors:
                    extra['excerpt'] = excerpt(text if text is not None else json.dumps(j)[:600], s.key)
            elif parsed.warnings:
                extra['diagnostics'] = parsed.warnings
            note('find', config.SAM_MODEL, 200, ms, attempt, **extra)
            with lock:
                usage['estimated_usd'] += SAM_COST
            return job, parsed, None

        with ThreadPoolExecutor(max_workers=max(1, min(SAM_WORKERS, len(jobs)))) as pool:
            results = list(pool.map(find, jobs))
        usage['sam_calls'] = sum(1 for c in calls if c['stage'] == 'find')
        usage['calls'] += usage['sam_calls']
        spend_stopped = False
        for job, parsed, err in results:
            if err is not None and isinstance(err, Refusal):
                spend_stopped = True
            answers[job] = (parsed, err)
        stages['find'] = 'ok'

        surface = None
        surface_matches = 0
        surface_err = None
        floor_boxes = []
        floor_records = []
        if room['surface']:
            parsed, surface_err = answers[('surface', room['surface'])]
            if parsed is not None and not ('size_mismatch' in parsed.errors) and parsed.records:
                whole = surface_from(held_records(parsed.records, W, H)[0])
                if whole:
                    surface = {'name': room['surface'], 'box': whole['box'], 'confidence': whole['confidence']}
                    surface_matches = whole['matches']
                    floor_boxes = whole['boxes']
                    floor_records = whole['records']
        # which matches are which object: each name's own choice (boxes held
        # to the picture), then no box kept by two names
        picks = []
        dropped = {}
        for k, o in enumerate(on):
            if o['name'] not in nouns:
                continue
            parsed, err = answers[('object', o['name'])]
            if err is not None or 'size_mismatch' in parsed.errors:
                continue
            records, emptied = held_records(parsed.records, W, H)
            kept, lost = choose_matches(records, o['seeds'], o['role'], W, H, o.get('count'),
                                        holds=lambda r, pt, name=o['name']: on_mask(shape_of(r, name), pt))
            picks += [(k, o['name'], r, seeded) for r, seeded in kept]
            dropped[o['name']] = [(r, DROP_WORDS[why], why) for r, why in lost + [(r, 'empty_box') for r in emptied]]
        picks, lost = settle_claims(picks)
        for (k, name, r, seeded), winner, why in lost:
            words = f'the same box was kept for the {winner}' if why == 'same_box' else f'it lies inside the {winner}'
            dropped[name].append((r, words, why))
        # boxes that are the surface, not a thing on it, join the surface (or
        # become it, when SAM found none); the name is not traced by points
        absorbed = []
        for q in picks:
            why = surface_like(q[1], q[2]['box'], room['surface'], surface and surface['box'], W, H)
            if why:
                absorbed.append((q, why))
        if absorbed:
            picks = [q for q in picks if not any(q is a for a, _ in absorbed)]
            boxes = [q[2]['box'] for q, _ in absorbed]
            floor_boxes = (floor_boxes + boxes)[:MAX_FLOOR_BOXES]
            floor_records = (floor_records + [q[2] for q, _ in absorbed])[:MAX_FLOOR_BOXES]
            if surface is None:
                named = any(why == 'named' for _, why in absorbed)
                biggest = max(absorbed, key=lambda a: (a[0][2]['box'][2] - a[0][2]['box'][0]) * (a[0][2]['box'][3] - a[0][2]['box'][1]))
                surface = {'name': room['surface'] if named else biggest[0][1], 'box': union(boxes),
                           'confidence': max(_conf(q[2]) for q, _ in absorbed)}
                surface_matches = 0
            else:
                surface['box'] = union([surface['box']] + boxes)
            for q, why in absorbed:
                words = SURFACE_WORDS[why]
                if surface['name'] == q[1] and why != 'named':
                    words = words.replace('is part of the play surface', 'is the play surface')
                dropped[q[1]].append((q[2], words, 'surface'))
        absorbed_names = {q[1] for q, _ in absorbed} - {q[1] for q in picks}
        if room['surface'] and surface is None and surface_err is not None:
            warnings.append(f'not looked for: {room["surface"]} (the play surface; {first_sentence(surface_err.message)}); '
                            'the full width below the horizon is used')
        elif room['surface'] and surface is None:
            warnings.append(f'not found: {room["surface"]} (the play surface); the full width below the horizon is used')
        for c in calls:
            if c['stage'] == 'find' and c.get('surface'):
                c['kept'] = surface_matches
            elif c['stage'] == 'find' and c.get('noun') in dropped:
                c['kept'] = sum(1 for q in picks if q[1] == c['noun'])
                if dropped[c['noun']]:
                    c['dropped'] = sorted(why for _, _, why in dropped[c['noun']])
        objects = []
        counts = {}
        for k, o in enumerate(on):
            if o['name'] not in nouns:
                warnings.append(f'not sent: {o["name"]} (over the call ceiling)')
                continue
            parsed, err = answers[('object', o['name'])]
            picked = []
            # a call that failed never looked: the photo is not to blame
            looked = err is None
            if err is not None:
                why = first_sentence(err.message) if isinstance(err, (CallError, Refusal)) else 'an error'
            elif 'size_mismatch' in parsed.errors:
                why = 'the answer was for a different picture size'
            else:
                for r, words, _ in sorted(dropped[o['name']], key=lambda d: d[0]['id']):
                    if r['confidence'] is not None and r['confidence'] >= MIN_CONFIDENCE:
                        warnings.append(f'not used: a match for {o["name"]} at {round(r["confidence"] * 100)}% ({words})')
                picked = sorted((q[2] for q in picks if q[0] == k), key=_rank)
                why = None
            if not picked and o['name'] in absorbed_names:
                continue  # it is the surface, said above
            if not picked and room['surface'] and head(o['name']) == head(room['surface']):
                warnings.append(f'not used: {o["name"]} ({SURFACE_WORDS["named"]})')
                continue
            if not picked:
                # SAM found nothing usable: Muse Spark's own points, when it
                # gave any, still say where the thing is
                regions = point_regions(o['seeds'], o['role'], W, H, o.get('count'))
                said = (f'not found: {o["name"]}' if looked else f'not looked for: {o["name"]}') + (f' ({why})' if why else '')
                if not regions:
                    warnings.append(said)
                    continue
                if looked:
                    said = f'not found by SAM 3.1: {o["name"]}' + (f' ({why})' if why else '')
                warnings.append(said + '; code traces around Muse Spark’s points for it instead')
                for box, pts in regions:
                    if len(objects) >= MAX_OBJECTS:
                        break
                    counts[o['name']] = counts.get(o['name'], 0) + 1
                    objects.append({
                        'id': f'o{len(objects) + 1}', 'name': o['name'], 'instance': counts[o['name']],
                        'role': o['role'], 'reason': o['reason'], 'on_surface': True,
                        'found_by': 'points', 'box': box, 'confidence': None, 'seeds': pts, 'mask': None,
                        'outline_source': 'traced_at_points',
                    })
                continue
            for m in picked:
                if len(objects) >= MAX_OBJECTS:
                    break
                counts[o['name']] = counts.get(o['name'], 0) + 1
                x0, y0, x1, y1 = m['box']
                seeds = [p for p in o['seeds'] if x0 <= p[0] < x1 and y0 <= p[1] < y1]
                shape = shape_of(m, o['name'])
                mask = m['mask'] or {}
                # the mask's exact outline (holes kept), its area and bounds;
                # without one the page traces inside the box
                exact = {'rings': shape['rings'], 'area': shape['area'], 'bounds': shape['bounds']} if shape else {}
                objects.append({
                    'id': f'o{len(objects) + 1}',
                    'name': o['name'],
                    'instance': counts[o['name']],
                    'role': o['role'],
                    'reason': o['reason'],
                    'on_surface': True,
                    'found_by': 'sam',
                    'box': m['box'],
                    'confidence': m['confidence'],
                    'seeds': seeds,
                    'mask': {'height': mask.get('rows', y1 - y0), 'width': mask.get('cols', x1 - x0),
                             'encoding': mask.get('encoding'), 'decoded': shape is not None,
                             'payload_chars': mask.get('payload_chars'), **exact},
                    'outline_source': 'sam_mask' if shape else 'traced_in_box',
                })
        # the floor SAM found, from its masks: the play area, when any decodes
        floor_shapes = []
        for k, rec in enumerate(floor_records):
            # the surface call's own matches come first; absorbed things after
            shape = shape_of(rec, 'surface:' + room['surface'] if k < surface_matches else None)
            if shape:
                floor_shapes.append(shape)
        exact_floor = floor_mask(floor_shapes, W, H) if floor_shapes else None
        for c in calls:
            key = 'surface:' + c.get('noun', '') if c.get('surface') else c.get('noun')
            if c['stage'] == 'find' and key in mask_notes:
                c['diagnostics'] = c.get('diagnostics', []) + sorted(mask_notes[key])
        by_sam = sum(1 for o in objects if o['found_by'] == 'sam')
        sent = [answers[('object', n)] for n in nouns]
        errs = [e for _, e in sent if e is not None]
        latched = next((e for _, e in answers.values() if getattr(e, 'latched', False)), None)
        if latched is not None and not by_sam:
            # an account or model problem: the page turns the picker off
            stages['find'] = 'live_unavailable'
            return reply('error', {'code': 'live_unavailable', 'message': latched.message,
                                   **({'status': latched.status} if isinstance(latched.status, int) else {})}, scene=scene)
        if spend_stopped and not by_sam:
            return reply('refused', {'code': 'spend_stop', 'message': 'This server reached its spending stop while reading this photo.'}, scene=scene)
        # every call failed for a passing reason: no room from Muse Spark's
        # points alone (it would be kept on the device); the same photo again
        # will be looked at
        failure = sam_failure(errs)
        if failure and (len(errs) == len(sent) or not objects):
            stages['find'] = failure['code']
            return reply('error', failure, scene=scene)
        if not objects:
            if any(unreadable(p) for p, _ in sent):
                stages['find'] = 'unreadable'
                return reply('error', {'code': 'sam_unreadable', 'message': SAM_UNREADABLE_WORDS}, scene=scene)
            if errs:
                stages['find'] = 'sam_error'
                return reply('error', {'code': 'sam_error', 'message': errs[0].message}, scene=scene)
            stages['find'] = 'nothing'
            return reply('error', {'code': 'nothing_found', 'message': NOTHING_FOUND_WORDS}, scene=scene, surface=surface)
        found['sam'] = by_sam
        found['masks'] = sum(1 for o in objects if o['outline_source'] == 'sam_mask')
        found['points'] = len(objects) - by_sam
        if found['points']:
            stages['find'] = 'points' if not by_sam else 'some_points'
        # the floor: SAM's own mask of it, which the page takes as the play
        # area; without one, the page grows the floor from Muse Spark's
        # points inside SAM's floor boxes (with none of either, it keeps to
        # the horizon)
        floor = {'view': room['view'], 'seeds': room['floor_seeds'], 'boxes': floor_boxes}
        if exact_floor:
            floor['mask'] = exact_floor
        # no last check of the clock: every call kept to the photo's time,
        # and what was found is kept
        return reply('ok', None, scene=scene, surface=surface, objects=objects, floor=floor)

    def _log_photo(self, r, stages):
        if self.log is None:
            return
        self.log.write(event='photo', request_id=r['request_id'], status=r['status'], bytes=r['received']['bytes'],
                       type=r['received']['type'], width=r['received']['width'], height=r['received']['height'],
                       stages=stages, calls=r['usage']['calls'],
                       tokens_in=r['usage']['tokens_in'], tokens_out=r['usage']['tokens_out'],
                       estimated_usd=r['usage']['estimated_usd'], mode=r['provenance']['mode'],
                       found=found_counts(r))


def found_counts(r):
    """For the log, per name sent to SAM: how many matches SAM gave, how
    many were kept, how many were placed by Muse Spark's points instead, and
    the codes of what was dropped or surprised the reader. Counts and codes
    only, in the order of the names: never the names themselves (what is in
    the photo), the photo or its fingerprint, a box, a point, a reason, an
    answer text or the key."""
    points = {}
    for o in r['objects']:
        if o.get('found_by') == 'points':
            points[o['name']] = points.get(o['name'], 0) + 1
    out = []
    for c in r['provenance']['calls']:
        if c['stage'] != 'find' or 'noun' not in c:
            continue
        row = {'name': c['noun'], 'matches': c.get('matches', 0), 'kept': c.get('kept', 0)}
        if c.get('surface'):
            row['surface'] = True
        else:
            row['points'] = points.get(c['noun'], 0)
        if c.get('dropped'):
            row['dropped'] = c['dropped']
        if c.get('diagnostics'):
            row['diagnostics'] = c['diagnostics']
        if c.get('error'):
            row['error'] = c['error']
        out.append(row)
    # the calls finish in any order: the surface first, then by name, and
    # the name is left out
    out.sort(key=lambda row: (not row.get('surface'), row['name']))
    return [{k: v for k, v in row.items() if k != 'name'} for row in out]
