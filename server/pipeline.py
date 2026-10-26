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
           'next', 'middle', 'center', 'centre', 'corner', 'on', 'in', 'at', 'of', 'back', 'side', 'upper', 'lower'}
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


def choose(records, role):
    """Matches at or above 0.35, ranked by confidence then area, up to the
    role's count."""
    keep = [r for r in records if (r['confidence'] if r['confidence'] is not None else 0.0) >= MIN_CONFIDENCE]
    keep.sort(key=lambda r: (-(r['confidence'] or 0.0), -((r['box'][2] - r['box'][0]) * (r['box'][3] - r['box'][1])), r['id']))
    return keep[:PER_NOUN.get(role, 1)]


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
            handler.send_header('Connection', 'close')
            handler.end_headers()
            handler.close_connection = True

            def line(obj):
                text = config.redact(json.dumps(obj, ensure_ascii=False), self.settings.key)
                try:
                    handler.wfile.write(text.encode('utf-8') + b'\n')
                    handler.wfile.flush()
                except OSError:
                    pass

            reply = self.run(photo, progress=lambda stage, words: line({'type': 'progress', 'stage': stage, 'words': words, 'mode': self.settings.mode}))
            line({'type': 'reply', 'reply': reply})
        finally:
            self.limits.finish()

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
                     noun=noun, error=e.code, **({'excerpt': e.excerpt} if e.excerpt else {}))
                return job, None, e
            self.limits.settle(r, SAM_COST)
            text = sam_text(j)
            parsed = samtext.parse(text, W, H)
            extra = {'noun': noun, 'matches': len(parsed.records), 'usd': SAM_COST}
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
        objects = []
        counts = {}
        for o in on:
            if o['name'] not in nouns:
                warnings.append(f'not sent: {o["name"]} (over the call ceiling)')
                continue
            parsed, err = answers[('object', o['name'])]
            if err is not None:
                warnings.append(f'not found: {o["name"]} ({err.message if isinstance(err, (CallError, Refusal)) else "error"})')
                continue
            if 'size_mismatch' in parsed.errors:
                warnings.append(f'not used: {o["name"]} (the answer was for a different picture size)')
                continue
            picked = choose(parsed.records, o['role'])
            if not picked:
                warnings.append(f'not found: {o["name"]}')
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
                    'box': m['box'],
                    'confidence': m['confidence'],
                    'seeds': seeds,
                    'mask': {'height': H, 'width': W, 'encoding': 'one_bit', 'decoded': False,
                             'payload_chars': (m['mask'] or {}).get('payload_chars')},
                })
        if spend_stopped and not objects:
            return reply('refused', {'code': 'spend_stop', 'message': 'This server reached its spending stop while reading this photo.'}, scene=scene)
        if not objects:
            stages['find'] = 'nothing'
            return reply('error', {'code': 'nothing_found', 'message': 'SAM 3.1 found none of the things Muse Spark named. Try another photo with clearer edges.'}, scene=scene, surface=surface)
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
                       estimated_usd=r['usage']['estimated_usd'], mode=r['provenance']['mode'])
