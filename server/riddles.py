"""Ask the room: after a photo's reply has gone to the page, one more
muse-spark-1.3 call writes up to three riddles about the same photo. It sees
the photo and the list of what SAM 3.1 found, under the reply's own ids
(o1, o2, ...), and answers with those ids and one point on each answer.

Code cleans every riddle (rules 1 to 8 below; each one dropped is said in
words) and checks each answer's point against the box SAM found for that
id. So the truth splits three ways: Muse Spark says which things answer a
riddle (each one a thing SAM 3.1 found), SAM 3.1 says where they are, and
the page's code says whether the player touched them. The count is never
written by a model: the page fills it in as the number of those answers.
The server keeps nothing.

Off with FRAMEPLAY_RIDDLES=no. Only in stream mode, only after an ok reply
with at least two things, only within its own time and the spend stop.
"""
import base64
import json
import math
import re
import time

from server import config
from server.limits import Refusal, spark_cost
from server.meta_api import CallError, excerpt
from server.pipeline import AGAIN, PEOPLE

RIDDLES_SCHEMA = 'frameplay.riddles/1'
MAX_RIDDLES = 3
TEXT_MIN, TEXT_MAX, WHY_MAX = 12, 90, 80
# Muse Spark's points miss small things by about 1.2% of the picture's width
# (the desk's coin points fell 11 to 12 px beside SAM's coin boxes): a point
# counts for its thing within 1.5% of the long side of SAM's box for it.
POINT_REACH = 0.015
NUMBER_WORDS = ('two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'dozen', 'both')
# a riddle speaks to "you": the pronouns stay, persons and bodies go
PEOPLE_WORDS = PEOPLE - {'you', 'me', 'him', 'her', 'them', 'someone'}

RIDDLE_PROMPT = """You are writing riddles for a small game about ONE photo of a room or a desk top.
The player is looking at this photo. An image segmenter has already found these things
in it. Each line is an id, a name, and its box on a 0 to 1000 grid over the photo
(x right, y down). Several lines may share a name: each is a separate thing.

{LIST}

The play surface is the {SURFACE}; it is never an answer.

Write 1 to 3 riddles about the things in THIS photo. A riddle names a use, a property or
a likeness, never the thing itself: "touch the thing you would fill with hot tea", not
"touch the mug". The player answers by touching things in the photo.

Return JSON only, in the given schema. For each riddle:
- text: the riddle, 90 characters or fewer, spoken to the player. Use no word of any
  answer's name. Write no digits. When the player must find several things, write {n}
  where the number goes ("find the {n} things you could spend"); the game fills it in.
- rule: "one" when exactly one listed thing answers it; "any" when several do and
  touching any one of them is right; "all" when the player must find every one of them.
- answer_ids: the ids from the list that answer it. List every thing that answers it.
  At least one listed thing must NOT answer it.
- points: one point for each answer id, on that thing, on the same 0 to 1000 grid,
  with that id.
- why: why that is the answer, 80 characters or fewer, playful and plain.

Rules: what decides the answer must be visible in this photo. Skip any listed thing
whose box does not hold what its name says. Never write about people, bodies, faces,
who owns something, brands, writing or labels, prices, or anything unsafe. Each riddle
has a different answer. Prefer riddles a child could answer by looking."""

RIDDLE_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['riddles'],
    'properties': {
        'riddles': {
            'type': 'array',
            'items': {
                'type': 'object', 'additionalProperties': False,
                'required': ['text', 'rule', 'answer_ids', 'points', 'why'],
                'properties': {
                    'text': {'type': 'string'},
                    'rule': {'type': 'string', 'enum': ['one', 'any', 'all']},
                    'answer_ids': {'type': 'array', 'items': {'type': 'string'}},
                    'points': {
                        'type': 'array',
                        'items': {
                            'type': 'object', 'additionalProperties': False, 'required': ['id', 'x', 'y'],
                            'properties': {'id': {'type': 'string'}, 'x': {'type': 'integer'}, 'y': {'type': 'integer'}},
                        },
                    },
                    'why': {'type': 'string'},
                },
            },
        },
    },
}


def grid_box(box, W, H):
    """A half-open pixel box on Muse Spark's 0 to 1000 grid."""
    x0, y0, x1, y1 = box
    return round(x0 * 1000 / W), round(y0 * 1000 / H), round(x1 * 1000 / W), round(y1 * 1000 / H)


def listing(objects, W, H):
    """One line per thing in the reply, in reply order: id | name | box on the grid."""
    lines = []
    for o in objects:
        gx0, gy0, gx1, gy1 = grid_box(o['box'], W, H)
        lines.append(f"{o['id']} | {o['name']} | x {gx0}-{gx1}, y {gy0}-{gy1}")
    return '\n'.join(lines)


def riddle_body(list_text, surface_name, data_url):
    # .replace, never .format: the prompt holds a literal {n}
    text = RIDDLE_PROMPT.replace('{LIST}', list_text).replace('{SURFACE}', surface_name or 'floor')
    return {
        'model': config.SPARK_MODEL,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': text},
            {'type': 'image_url', 'image_url': {'url': data_url}},
        ]}],
        'response_format': {'type': 'json_schema', 'json_schema': {'name': 'room_riddles', 'strict': True, 'schema': RIDDLE_SCHEMA}},
        'reasoning_effort': 'low',
        'max_completion_tokens': config.RIDDLE_MAX_COMPLETION_TOKENS,
    }


def read_riddles(j, holder=None):
    """The riddles from a chat completion: (list, tokens in, tokens out). Raises CallError."""
    try:
        choice = j['choices'][0]
        finish = choice.get('finish_reason')
        message = choice['message']
        content = message.get('content')
    except (KeyError, IndexError, TypeError, AttributeError):
        raise CallError('malformed', f'The riddles came back in an unexpected shape. {AGAIN}', excerpt=excerpt(json.dumps(j)[:600], holder)) from None
    refusal = message.get('refusal')
    if finish == 'content_filter' or (isinstance(refusal, str) and refusal.strip()):
        raise CallError('content_filter', 'Muse Spark declined to write riddles for this photo.', billed=True)
    if finish == 'length':
        raise CallError('cut_off', 'The riddles were cut off before they finished.', billed=True,
                        excerpt=excerpt(content, holder) if isinstance(content, str) else None)
    if isinstance(content, list):
        content = ''.join(p.get('text', '') for p in content if isinstance(p, dict))
    if content is None or (isinstance(content, str) and not content.strip()):
        raise CallError('malformed', 'The riddles came back empty.', billed=True)
    try:
        got = json.loads(content)
    except (TypeError, ValueError):
        raise CallError('malformed', 'The riddles were not valid JSON.', billed=True, excerpt=excerpt(content, holder)) from None
    if not isinstance(got, dict) or not isinstance(got.get('riddles'), list):
        raise CallError('malformed', 'The riddles are missing their list.', billed=True, excerpt=excerpt(content, holder))
    usage = j.get('usage') or {}
    return got['riddles'], int(usage.get('prompt_tokens') or 0), int(usage.get('completion_tokens') or 0)


def _words(s):
    return re.findall(r'[a-z]+', str(s).lower())


def _stem(w):
    return w[:-1] if len(w) > 3 and w.endswith('s') else w


def _box_distance(x, y, box):
    """Pixels from a point to a half-open box; 0 inside."""
    x0, y0, x1, y1 = box
    dx = max(x0 - x, 0, x - x1)
    dy = max(y0 - y, 0, y - y1)
    return math.hypot(dx, dy)


def sentence_case(text, limit):
    """A riddle or reason as a sentence: a capital first letter, and an end
    stop when it has none and there is room for one (the 10-28 live read wrote
    its riddles in lower case, with no full stop)."""
    if not text:
        return text
    text = text[0].upper() + text[1:]
    if text[-1] not in '.!?"”' and len(text) < limit:
        text += '.'
    return text


def text_problem(text, rule, names):
    """Why a riddle's text cannot be used, or None (rules 2 and 4)."""
    if not TEXT_MIN <= len(text) <= TEXT_MAX:
        return f'its text is {len(text)} characters long'
    if re.search(r'\d', text):
        return 'it writes a digit'
    holes = text.count('{n}')
    if rule == 'all':
        if holes != 1:
            return 'it does not leave the count to the game'
        if any(w in NUMBER_WORDS for w in _words(text)):
            return 'it writes a count itself'
    elif holes:
        return 'it asks for a count but has one answer'
    said = {_stem(w) for w in _words(text.replace('{n}', ''))}
    for name in names:
        for w in _words(name):
            if len(w) >= 3 and _stem(w) in said:
                return f'it names its answer ("{w}")'
    return None


def clean_riddles(raw, objects, W, H, warnings):
    """Spark's riddles, kept or dropped by rule, in order (at most three).
    Each kept riddle: id q1..q3, text (with {n}), rule, answers (reply ids),
    n, why, points [[x, y, id]] in pixels."""
    by_id = {o['id']: o for o in objects}
    reach = POINT_REACH * max(W, H)
    kept, sets = [], set()
    for n, r in enumerate(raw if isinstance(raw, list) else [], 1):
        def drop(why):
            warnings.append(f'dropped riddle {n}: {why}')
        # 1. shape
        if not isinstance(r, dict) or not all(isinstance(r.get(k), str) for k in ('text', 'rule', 'why')) \
                or not isinstance(r.get('answer_ids'), list) or not isinstance(r.get('points'), list):
            drop('it is not in the riddle shape')
            continue
        text = re.sub(r'\s+', ' ', r['text']).strip()
        why_text = re.sub(r'\s+', ' ', r['why']).strip()[:WHY_MAX]
        rule = r['rule']
        if rule not in ('one', 'any', 'all'):
            drop('its rule is unknown')
            continue
        # 5. ids
        ids = []
        for a in r['answer_ids']:
            if isinstance(a, str) and a not in ids:
                ids.append(a)
        if not ids:
            drop('it has no answer')
            continue
        unknown = [a for a in ids if a not in by_id]
        if unknown:
            drop(f'its answer {unknown[0]} is not on the list')
            continue
        if len(ids) >= len(objects):
            drop('every listed thing answers it')
            continue
        # 6. rule consistency
        if rule == 'any' and len(ids) == 1:
            rule = 'one'
        if rule == 'one' and len(ids) != 1:
            drop('it has one answer but several things')
            continue
        if rule == 'all' and len(ids) < 2:
            drop('it asks for all but has one answer')
            continue
        # 2 and 4. the text, and no leak of an answer's name
        why = text_problem(text, rule, [by_id[a]['name'] for a in ids])
        if why:
            drop(why)
            continue
        # 3. people and bodies
        person = next((w for w in _words(text + ' ' + why_text) if w in PEOPLE_WORDS), None)
        if person:
            drop(f'it is about people ("{person}")')
            continue
        # 7. points: Spark's answer where SAM found it
        pts = []
        bad = None
        for a in ids:
            mine = [p for p in r['points'] if isinstance(p, dict) and p.get('id') == a
                    and isinstance(p.get('x'), (int, float)) and isinstance(p.get('y'), (int, float))]
            if not mine:
                bad = f'Muse Spark gave no point for the {by_id[a]["name"]}'
                break
            for p in mine:
                x, y = p['x'] * W / 1000, p['y'] * H / 1000
                if _box_distance(x, y, by_id[a]['box']) > reach:
                    bad = f'Muse Spark’s point for the {by_id[a]["name"]} is not where SAM found it'
                    break
                pts.append([round(x, 1), round(y, 1), a])
            if bad:
                break
        if bad:
            drop(bad)
            continue
        # 8. no repeats
        key = tuple(sorted(ids))
        if key in sets:
            drop('another riddle has the same answer')
            continue
        if len(kept) >= MAX_RIDDLES:
            drop(f'a room keeps at most {MAX_RIDDLES}')
            continue
        sets.add(key)
        kept.append({'id': f'q{len(kept) + 1}', 'text': sentence_case(text, TEXT_MAX), 'rule': rule, 'answers': ids, 'n': len(ids),
                     'why': sentence_case(why_text, WHY_MAX), 'points': pts})
    return kept


def line_for(pipeline, reply, status, riddles=(), calls=(), usage=None, warnings=(), error=None):
    s = pipeline.settings
    return {
        'schema': RIDDLES_SCHEMA,
        'request_id': reply.get('request_id'),
        'status': status,
        'provenance': {'mode': s.mode, 'label': s.label, 'models': [config.SPARK_MODEL] if s.mode == 'live' else [],
                       'calls': list(calls)},
        'riddles': list(riddles),
        'usage': usage or {'spark_calls': 0, 'tokens_in': 0, 'tokens_out': 0, 'estimated_usd': 0.0},
        'warnings': list(warnings),
        'error': error,
    }


def run_riddles(pipeline, photo, reply):
    """The riddles line for a reply already sent: one Spark call, cleaned."""
    s = pipeline.settings
    objects = [o for o in (reply.get('objects') or []) if isinstance(o.get('box'), list)]
    if reply.get('status') != 'ok':
        return line_for(pipeline, reply, 'none', error={'code': 'no_room', 'message': 'This photo made no room, so no riddle was written.'})
    if len(objects) < 2:
        return line_for(pipeline, reply, 'none', error={'code': 'too_few', 'message': 'Too few things were found for a fair riddle.'})
    W, H = photo['width'], photo['height']
    data_url = f'data:{photo["type"]};base64,' + base64.b64encode(photo['bytes']).decode('ascii')
    surface = (reply.get('surface') or {}).get('name') or 'floor'
    try:
        res = pipeline.limits.reserve(RIDDLE_WORST)
    except Refusal as e:
        return line_for(pipeline, reply, 'refused', error={'code': e.code, 'message': e.message})
    deadline = pipeline.clock() + config.RIDDLE_TIMEOUT_S
    t0 = pipeline.clock()
    usage = {'spark_calls': 1, 'tokens_in': 0, 'tokens_out': 0, 'estimated_usd': 0.0}
    calls = []
    model = pipeline.model_words(config.SPARK_MODEL)
    try:
        j, attempt, ms = pipeline.transport.post('/chat/completions', riddle_body(listing(objects, W, H), surface, data_url),
                                                 deadline, pipeline.sleep, pipeline.clock)
        raw, tin, tout = read_riddles(j, s.key)
    except CallError as e:
        if e.billed:
            pipeline.limits.settle(res, None)
            usage['estimated_usd'] = round(res.usd, 5)
        else:
            pipeline.limits.release(res)
        call = {'stage': 'riddle', 'model': model, 'status': e.status or e.code, 'ms': int((pipeline.clock() - t0) * 1000),
                'attempt': getattr(e, 'attempt', 1), 'error': e.code}
        if e.excerpt:
            call['excerpt'] = e.excerpt
        calls.append(call)
        status = 'refused' if e.code == 'content_filter' else 'error'
        if pipeline.log is not None:
            pipeline.log.write(event='riddles', request_id=reply.get('request_id'), status=status, error=e.code,
                               ms=call['ms'], listed=len(objects))
        return line_for(pipeline, reply, status, calls=calls, usage=usage, error={'code': e.code, 'message': e.message})
    cost = spark_cost(tin, tout)
    pipeline.limits.settle(res, cost)
    usage.update(tokens_in=tin, tokens_out=tout, estimated_usd=round(cost, 5))
    calls.append({'stage': 'riddle', 'model': model, 'status': 200, 'ms': ms, 'attempt': attempt,
                  'tokens_in': tin, 'tokens_out': tout, 'usd': round(cost, 5)})
    warnings = []
    kept = clean_riddles(raw, objects, W, H, warnings)
    if pipeline.log is not None:
        # numbers only: the log never holds a riddle's words
        pipeline.log.write(event='riddles', request_id=reply.get('request_id'), kept=len(kept), dropped=len(warnings), ms=ms,
                           tokens_in=tin, tokens_out=tout, estimated_usd=round(cost, 5))
    return line_for(pipeline, reply, 'ok' if kept else 'none', riddles=kept, calls=calls, usage=usage, warnings=warnings,
                    error=None if kept else {'code': 'none_kept', 'message': 'No riddle about this photo passed the checks.'})


# The worst case a riddle call is reserved at: the read's input bound and
# the riddles' own output ceiling.
RIDDLE_WORST = spark_cost(config.SPARK_WORST_IN_TOKENS, config.RIDDLE_MAX_COMPLETION_TOKENS)


def riddles_error_line(pipeline, reply):
    """A riddles line for a stage that broke: the room is untouched."""
    return line_for(pipeline, reply, 'error', error={'code': 'server_error', 'message': 'The riddles could not be written.'})


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
