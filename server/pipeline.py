"""The live path: one muse-spark-1.3 call reads the room, then one sam-3.1
call per on-surface noun (and one for the surface), in parallel, finds every
match with an exact box and a confidence. The reply (schema
frameplay.room.reply/2) goes back to the page, which traces the outlines and
builds the level. The server keeps nothing.

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
import uuid
from concurrent.futures import ThreadPoolExecutor

from server import config, samtext
from server.limits import SAM_COST, SPARK_WORST, Refusal, spark_cost
from server.meta_api import CallError, Transport, excerpt

REPLY_SCHEMA = 'frameplay.room.reply/2'
ROLES = ('collect', 'avoid', 'exit', 'solid', 'flat')
PER_NOUN = {'collect': 3, 'solid': 2, 'avoid': 1, 'exit': 1, 'flat': 1}
MAX_OBJECTS = 12
MIN_CONFIDENCE = 0.35
# Choosing among several matches for one name (choose_matches): a Muse Spark
# point counts for a match up to 3% of the picture outside it (on the desk's
# recorded answers its coin points fell 12 to 13 px beside the coins); with
# no point in any match, matches under FLOOR are dropped; and two names may
# not keep the same box (SAME_BOX: IoU of at least 0.5).
SEED_REACH = 0.03
FLOOR = 0.5
SAME_BOX = 0.5
# When SAM finds nothing usable for a thing (point_regions): a region around
# Muse Spark's points, grown by 5% of the long side; points to collect less
# than 10% apart are one thing.
POINT_MARGIN = 0.05
POINT_GROUP = 0.10

PROMPT = """You are reading one photo of a room or a desk top for a small game.
An explorer will walk on ONE play surface (such as floor, desk, table, bed or counter).
Things standing on that surface become walls the explorer walks around; one of them is
the exit, one to three are things to collect, and zero to two are things to avoid.

Return JSON only, in the given schema:
- people_present: true if any person or part of a person is visible. If true, the
  other fields may be empty.
- surface.name: one noun phrase for the play surface that an image segmenter can find.
- objects: 1 to 8 distinct things you can see. For each:
  - name: 1 to 3 words, one singular generic noun phrase (such as "mug", "desk lamp").
    No lists, no spatial words (left, top, behind ...), no people or body words.
  - role: exactly one of collect, avoid, exit, solid, flat. Propose exactly one exit,
    1 to 3 collect and 0 to 2 avoid; the rest are solid (an obstacle) or flat (part of
    the surface, such as a rug or paper).
  - reason: why, in 80 characters or fewer, playful and plain.
  - on_surface: true if it stands or lies on the play surface; false for scenery such
    as a picture on the wall or a ceiling lamp.
  - seeds: up to 3 points on the object, on a 0 to 1000 grid over the photo (x right, y down).
- title: a game title for this room, 60 characters or fewer.
- theme_line: one line of story, 120 characters or fewer."""

SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['people_present', 'surface', 'objects', 'title', 'theme_line'],
    'properties': {
        'people_present': {'type': 'boolean'},
        'surface': {
            'type': 'object', 'additionalProperties': False, 'required': ['name'],
            'properties': {'name': {'type': 'string'}},
        },
        'objects': {
            'type': 'array',
            'items': {
                'type': 'object', 'additionalProperties': False,
                'required': ['name', 'role', 'reason', 'on_surface', 'seeds'],
                'properties': {
                    'name': {'type': 'string'},
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
PEOPLE_WORDS = 'This photo seems to show a person. Please use one with no people.'

SPATIAL = {'left', 'right', 'top', 'bottom', 'behind', 'front', 'near', 'far', 'under', 'above', 'below', 'beside',
           'next', 'middle', 'center', 'centre', 'corner', 'on', 'in', 'at', 'back', 'side', 'upper', 'lower'}
PEOPLE = {'person', 'people', 'man', 'men', 'woman', 'women', 'child', 'children', 'kid', 'kids', 'boy', 'girl', 'baby',
          'human', 'face', 'head', 'hand', 'hands', 'arm', 'arms', 'leg', 'legs', 'foot', 'feet', 'finger', 'fingers',
          'body', 'hair', 'eye', 'eyes', 'mouth', 'selfie', 'someone', 'me', 'you', 'him', 'her', 'them'}
LIST_WORDS = {'and', 'or', 'with', 'plus'}


def name_problem(name):
    """Why a noun cannot go to SAM, or None when it can."""
    words = name.split()
    if not 1 <= len(words) <= 3:
        return 'not 1 to 3 words'
    if not re.fullmatch(r"[a-z][a-z' -]*[a-z]|[a-z]", name):
        return 'not a plain noun phrase'
    if any(w in LIST_WORDS for w in words) or ',' in name or '/' in name:
        return 'a list'
    if any(w in SPATIAL for w in words):
        return 'a spatial word'
    if any(w in PEOPLE for w in words):
        return 'a people or body word'
    return None


def normalize_name(raw):
    return re.sub(r'\s+', ' ', str(raw).strip().lower())


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
        content = choice['message']['content']
    except (KeyError, IndexError, TypeError):
        raise CallError('malformed', 'The room read came back in an unexpected shape', excerpt=excerpt(json.dumps(j)[:600], holder)) from None
    if finish == 'content_filter':
        raise CallError('content_filter', 'Muse Spark declined to read this photo', billed=True)
    if isinstance(content, list):
        content = ''.join(p.get('text', '') for p in content if isinstance(p, dict))
    try:
        read = json.loads(content)
    except (TypeError, ValueError):
        raise CallError('malformed', 'The room read was not valid JSON', excerpt=excerpt(content, holder)) from None
    if not isinstance(read, dict) or not isinstance(read.get('people_present'), bool):
        raise CallError('malformed', 'The room read is missing its fields', excerpt=excerpt(content, holder))
    usage = j.get('usage') or {}
    tin = int(usage.get('prompt_tokens') or 0)
    tout = int(usage.get('completion_tokens') or 0)
    details = usage.get('completion_tokens_details') or {}
    reasoning = int(details.get('reasoning_tokens') or 0) if isinstance(details, dict) else 0
    return read, tin, tout, reasoning


def clean_read(read, W, H, warnings):
    """Keep what the server accepts from the read: names SAM can find, roles,
    reasons of 80 characters, seeds in pixels. Merges repeated names."""
    objs = []
    by_name = {}
    raw = read.get('objects') if isinstance(read.get('objects'), list) else []
    for o in raw[:8]:
        if not isinstance(o, dict):
            continue
        name = normalize_name(o.get('name', ''))
        why = name_problem(name)
        if why:
            warnings.append(f'dropped the name "{clip(name, 40)}": {why}')
            continue
        role = o.get('role') if o.get('role') in ROLES else 'solid'
        seeds = []
        for s in (o.get('seeds') or [])[:3]:
            if isinstance(s, dict) and isinstance(s.get('x'), int) and isinstance(s.get('y'), int) \
                    and 0 <= s['x'] <= 1000 and 0 <= s['y'] <= 1000:
                seeds.append([round(s['x'] * W / 1000, 1), round(s['y'] * H / 1000, 1)])
        if name in by_name:
            by_name[name]['seeds'] = (by_name[name]['seeds'] + seeds)[:6]
            continue
        entry = {'name': name, 'role': role, 'reason': clip(o.get('reason', ''), 80),
                 'on_surface': o.get('on_surface') is not False, 'seeds': seeds}
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
        'objects': objs,
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
    role's count (the surface's choice: no points to go by)."""
    keep = sorted((r for r in records if _conf(r) >= MIN_CONFIDENCE), key=_rank)
    return keep[:PER_NOUN.get(role, 1)]


def _reach(p, box, W, H):
    """How far a point lies outside a half-open box, as a share of the
    picture's width or height (the larger); 0 inside."""
    x0, y0, x1, y1 = box
    dx = max(x0 - p[0], p[0] - x1, 0.0)
    dy = max(y0 - p[1], p[1] - y1, 0.0)
    return max(dx / W, dy / H)


def choose_matches(records, seeds, role, W, H):
    """Which of SAM's matches for one name are this object. A match that
    holds one of Muse Spark's points for it is kept (each point picks the
    match it falls in, or the nearest within SEED_REACH of the picture, since
    the points are rough); with no point in any match, the most confident
    matches at or above FLOOR. Never more than the role keeps.
    Returns (kept, dropped): kept as (record, seeded), dropped as (record, why)."""
    cap = PER_NOUN.get(role, 1)
    usable = sorted((r for r in records if _conf(r) >= MIN_CONFIDENCE), key=_rank)
    dropped = [(r, 'low') for r in records if _conf(r) < MIN_CONFIDENCE]
    picked = []
    for p in seeds:
        near = [(_reach(p, r['box'], W, H), k) for k, r in enumerate(usable)]
        near = [x for x in near if x[0] <= SEED_REACH]
        if near:
            k = min(near)[1]
            if k not in picked:
                picked.append(k)
    if picked:
        kept = [(usable[k], True) for k in sorted(picked)]
        dropped += [(r, 'no_point') for k, r in enumerate(usable) if k not in picked]
    else:
        kept = [(r, False) for r in usable if _conf(r) >= FLOOR]
        dropped += [(r, 'below_floor') for r in usable if _conf(r) < FLOOR]
    dropped += [(r, 'over_count') for r, _ in kept[cap:]]
    return kept[:cap], dropped


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def settle_claims(picks):
    """One box is never two objects: of matches of different names that
    cover the same thing (IoU at least SAME_BOX), the one holding a Muse
    Spark point wins, then the more confident, then the earlier name.
    picks: [(order, name, record, seeded)]. Returns (kept, lost) where lost
    holds (pick, the name that kept the box)."""
    ranked = sorted(picks, key=lambda q: (not q[3], -_conf(q[2]), q[0], q[2]['id']))
    kept, lost = [], []
    for q in ranked:
        rival = next((k for k in kept if k[1] != q[1] and iou(k[2]['box'], q[2]['box']) >= SAME_BOX), None)
        if rival:
            lost.append((q, rival[1]))
        else:
            kept.append(q)
    return kept, lost


def point_regions(seeds, role, W, H):
    """Where to trace a thing SAM did not find: around Muse Spark's own
    points for it, as half-open boxes with the points they hold. (A point
    may lie inside a box SAM found for another name: a coin on a notebook.)
    Things to collect may be several (Muse Spark gives a point on each
    coin), so their points form one region per group of points closer than
    POINT_GROUP of the picture's long side; any other role is one region.
    Each region is the points' bounds grown by POINT_MARGIN of the long side:
    smaller than the thing may be, and said to be what it is."""
    pts = list(seeds)
    if not pts:
        return []
    side = max(W, H)
    groups = []
    for p in pts:
        g = next((g for g in groups if role == 'collect' and any(math.dist(p, q) <= POINT_GROUP * side for q in g)), None)
        if g is None and groups and role != 'collect':
            g = groups[0]
        if g is None:
            groups.append([p])
        else:
            g.append(p)
    m = max(16, round(POINT_MARGIN * side))
    out = []
    for g in groups[:PER_NOUN.get(role, 1)]:
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
}


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
            return handler.send_json(429, {'schema': REPLY_SCHEMA, 'status': 'refused', 'error': {'code': e.code, 'message': e.message}}, extra)
        try:
            if not stream:
                reply = self.run(photo)
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
            line({'type': 'reply', 'reply': reply})
            chunk(b'')  # the terminating chunk: 0, then an empty line
        finally:
            self.limits.finish()

    def failed_reply(self):
        """A read that broke after the stream began: an error reply in this
        server's mode, in words, with nothing in it to build from."""
        s = self.settings
        prov = {'mode': s.mode, 'label': s.label, 'models': [], 'calls': [], 'image_retained': False}
        if s.mode == 'rehearsal':
            prov['rehearsal'] = {'stand_in_base': s.base, 'room': s.rehearsal_room}
        return {'schema': REPLY_SCHEMA, 'request_id': uuid.uuid4().hex, 'status': 'error', 'provenance': prov,
                'objects': [], 'warnings': [],
                'error': {'code': 'server_error', 'message': 'The server could not finish reading this photo. Please try again.'}}

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

        def reply(status, error=None, scene=None, surface=None, objects=None):
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
                'objects': objects or [],
                'usage': {**usage, 'estimated_usd': round(usage['estimated_usd'], 5)},
                'warnings': warnings,
                'error': error,
            }
            if s.mode == 'rehearsal':
                r['provenance']['rehearsal'] = {'stand_in_base': s.base, 'room': s.rehearsal_room}
            if found:
                who = 'The stand-in for SAM 3.1' if s.mode == 'rehearsal' else 'SAM 3.1'
                more = f'; for {found["points"]} more, code traces around Muse Spark’s points' if found['points'] else ''
                r['provenance']['found'] = {**found, 'words': f'{who} found {found["sam"]}{more}.'}
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
            return reply('error', {'code': e.code, 'message': e.message})
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
        scene = {'title': room['title'], 'theme_line': room['theme_line'], 'people_present': False,
                 'scenery': [{'name': o['name'], 'reason': o['reason']} for o in room['objects'] if not o['on_surface']]}
        on = [o for o in room['objects'] if o['on_surface']]
        if not on:
            stages['read'] = 'nothing'
            return reply('error', {'code': 'nothing_found', 'message': 'Muse Spark found nothing standing on a surface in this photo. Try another photo.'}, scene=scene)

        # stage 3: find every object
        if progress:
            progress(*PROGRESS[1])
        nouns = [o['name'] for o in on][:config.SAM_CALLS_PER_PHOTO - (1 if room['surface'] else 0)]
        jobs = ([('surface', room['surface'])] if room['surface'] else []) + [('object', n) for n in nouns]
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

        with ThreadPoolExecutor(max_workers=max(1, len(jobs))) as pool:
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
        if room['surface']:
            parsed, err = answers[('surface', room['surface'])]
            if parsed is not None and not ('size_mismatch' in parsed.errors) and parsed.records:
                best = choose(parsed.records, 'flat')
                if best:
                    surface = {'name': room['surface'], 'box': best[0]['box'], 'confidence': best[0]['confidence']}
            if surface is None:
                warnings.append(f'not found: {room["surface"]} (the play surface); the full width below the horizon is used')
        # which matches are which object: each name's own choice, then no box
        # kept by two names
        picks = []
        dropped = {}
        for k, o in enumerate(on):
            if o['name'] not in nouns:
                continue
            parsed, err = answers[('object', o['name'])]
            if err is not None or 'size_mismatch' in parsed.errors:
                continue
            kept, lost = choose_matches(parsed.records, o['seeds'], o['role'], W, H)
            picks += [(k, o['name'], r, seeded) for r, seeded in kept]
            dropped[o['name']] = [(r, DROP_WORDS[why], why) for r, why in lost]
        picks, lost = settle_claims(picks)
        for (k, name, r, seeded), winner in lost:
            dropped[name].append((r, f'the same box was kept for the {winner}', 'same_box'))
        for c in calls:
            if c['stage'] == 'find' and c.get('surface'):
                c['kept'] = 1 if surface else 0
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
            if err is not None:
                why = err.message if isinstance(err, (CallError, Refusal)) else 'error'
            elif 'size_mismatch' in parsed.errors:
                why = 'the answer was for a different picture size'
            else:
                for r, words, _ in sorted(dropped[o['name']], key=lambda d: d[0]['id']):
                    if r['confidence'] is not None and r['confidence'] >= MIN_CONFIDENCE:
                        warnings.append(f'not used: a match for {o["name"]} at {round(r["confidence"] * 100)}% ({words})')
                picked = sorted((q[2] for q in picks if q[0] == k), key=_rank)
                why = None
            if not picked:
                # SAM found nothing usable: Muse Spark's own points, when it
                # gave any, still say where the thing is
                regions = point_regions(o['seeds'], o['role'], W, H)
                if not regions:
                    warnings.append(f'not found: {o["name"]}' + (f' ({why})' if why else ''))
                    continue
                warnings.append(f'not found by SAM 3.1: {o["name"]}' + (f' ({why})' if why else '')
                                + '; code traces around Muse Spark’s points for it instead')
                for box, pts in regions:
                    if len(objects) >= MAX_OBJECTS:
                        break
                    counts[o['name']] = counts.get(o['name'], 0) + 1
                    objects.append({
                        'id': f'o{len(objects) + 1}', 'name': o['name'], 'instance': counts[o['name']],
                        'role': o['role'], 'reason': o['reason'], 'on_surface': True,
                        'found_by': 'points', 'box': box, 'confidence': None, 'seeds': pts, 'mask': None,
                    })
                continue
            for m in picked:
                if len(objects) >= MAX_OBJECTS:
                    break
                counts[o['name']] = counts.get(o['name'], 0) + 1
                x0, y0, x1, y1 = m['box']
                seeds = [p for p in o['seeds'] if x0 <= p[0] < x1 and y0 <= p[1] < y1]
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
                    'mask': {'height': y1 - y0, 'width': x1 - x0, 'encoding': 'one_bit', 'decoded': False,
                             'payload_chars': (m['mask'] or {}).get('payload_chars')},
                })
        by_sam = sum(1 for o in objects if o['found_by'] == 'sam')
        if spend_stopped and not by_sam:
            return reply('refused', {'code': 'spend_stop', 'message': 'This server reached its spending stop while reading this photo.'}, scene=scene)
        if not objects:
            stages['find'] = 'nothing'
            return reply('error', {'code': 'nothing_found', 'message': 'SAM 3.1 found none of the things Muse Spark named, and Muse Spark gave no points to trace around instead. Try another photo with clearer edges.'}, scene=scene, surface=surface)
        found['sam'] = by_sam
        found['points'] = len(objects) - by_sam
        if found['points']:
            stages['find'] = 'points' if not by_sam else 'some_points'
        if self.clock() > deadline:
            return reply('error', {'code': 'timeout', 'message': 'The photo ran out of time. Please try again.'}, scene=scene)
        return reply('ok', None, scene=scene, surface=surface, objects=objects)

    def _log_photo(self, r, stages):
        if self.log is None:
            return
        self.log.write(event='photo', request_id=r['request_id'], status=r['status'], bytes=r['received']['bytes'],
                       type=r['received']['type'], width=r['received']['width'], height=r['received']['height'],
                       sha256=r['provenance']['image_sha256'], stages=stages, calls=r['usage']['calls'],
                       tokens_in=r['usage']['tokens_in'], tokens_out=r['usage']['tokens_out'],
                       estimated_usd=r['usage']['estimated_usd'], mode=r['provenance']['mode'],
                       found=found_counts(r))


def found_counts(r):
    """For the log, per name sent to SAM: how many matches SAM gave, how
    many were kept, how many were placed by Muse Spark's points instead, and
    the codes of what was dropped or surprised the reader. Names, counts and
    codes only: never the photo, a box, a point, a reason, an answer text or
    the key."""
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
    # the calls finish in any order: the surface first, then by name
    return sorted(out, key=lambda row: (not row.get('surface'), row['name']))
