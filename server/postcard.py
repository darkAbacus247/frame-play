"""A room postcard: one Muse Image edit of the round's photo, then a Muse
Spark read-back of its printed text.

The prompt asks for a postcard of this very room with printed text
'Greetings from ' + the room's name, keeps the room recognizable, and always
says 'No people, no faces.' The read-back is one chat completion whose answer
is strict JSON {"lines": [...]}; the comparer normalises case and
punctuation, then reports match True or the first differing words. A read-back
that fails never fails the postcard.
"""
import json
import re

from server import config
from server.limits import spark_cost
from server.meta_api import CallError, excerpt, image_edit

# What the postcard carries, and its honesty label on the way back.
POSTCARD_LABEL = 'Made by Muse Image (AI)'
IMAGE_MODEL = 'muse-image-1.0'

# A room name is the room's own word in the prompt: short and one line.
ROOM_NAME_LIMIT = 60


def clean_room_name(room):
    """The room's name as one short line, or '' when there is none."""
    name = re.sub(r'\s+', ' ', str(room or '')).strip()
    return name[:ROOM_NAME_LIMIT]


def postcard_prompt(room):
    """The edit's prompt for this room."""
    name = clean_room_name(room) or 'this room'
    return (f'Make a postcard of this very room, keeping the room recognizable: '
            f'the same furniture and layout, with printed text "Greetings from {name}" '
            f'across the top in large friendly letters. No people, no faces.')


# ---- the read-back ----

READBACK_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['lines'],
    'properties': {
        'lines': {'type': 'array', 'items': {'type': 'string'}},
    },
}


def readback_body(prompt_text, data_url):
    """The chat completion that reads the postcard's printed text, built the
    way server/riddles.py builds its riddle body."""
    return {
        'model': config.SPARK_MODEL,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': prompt_text},
            {'type': 'image_url', 'image_url': {'url': data_url}},
        ]}],
        'response_format': {'type': 'json_schema', 'json_schema': {
            'name': 'postcard_readback', 'strict': True, 'schema': READBACK_SCHEMA}},
        'reasoning_effort': 'low',
        'max_completion_tokens': config.READBACK_MAX_COMPLETION_TOKENS,
    }


READBACK_PROMPT = ('Read the printed text on this postcard. Answer with the exact '
                   'lines of printed text, in order, and nothing else.')


def read_readback(j, holder=None):
    """The read-back's lines and token counts from a chat completion."""
    try:
        choice = j['choices'][0]
    except (KeyError, IndexError, TypeError):
        raise CallError('malformed', 'Muse Spark’s answer to the read-back could not be read.',
                        excerpt=excerpt(str(j)[:400], holder)) from None
    if choice.get('finish_reason') == 'content_filter':
        raise CallError('content_filter', 'Muse Spark would not read this postcard’s printed text.', billed=False)
    try:
        raw = json.loads(choice['message']['content'])
    except (KeyError, TypeError, ValueError):
        raise CallError('malformed', 'Muse Spark’s answer to the read-back could not be read.',
                        excerpt=excerpt(str(j)[:400], holder)) from None
    if not isinstance(raw, dict) or not isinstance(raw.get('lines'), list) \
            or not all(isinstance(x, str) for x in raw['lines']):
        raise CallError('malformed', 'Muse Spark’s answer to the read-back could not be read.',
                        excerpt=excerpt(str(j)[:400], holder)) from None
    usage = j.get('usage') or {}
    try:
        tin = int(usage.get('prompt_tokens') or 0)
        tout = int(usage.get('completion_tokens') or 0)
    except (TypeError, ValueError):
        raise CallError('malformed', 'Muse Spark’s answer to the read-back could not be read.',
                        excerpt=excerpt(str(j)[:400], holder)) from None
    return raw['lines'], tin, tout


_WORDS = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")


def normalise(text):
    """Lower case words without punctuation, in order."""
    return _WORDS.findall(str(text).lower())


def compare_readback(lines, room):
    """The read-back against 'Greetings from ' + the room's name: match True,
    or the first differing words."""
    expected = normalise('Greetings from ' + (clean_room_name(room) or 'this room'))
    got = normalise(' '.join(lines))
    n = min(len(expected), len(got))
    for i in range(n):
        if expected[i] != got[i]:
            return {'match': False,
                    'difference': f'expected "{expected[i]}" but read "{got[i]}"'}
    if len(got) < len(expected):
        return {'match': False, 'difference': f'missing "{expected[len(got)]}"'}
    if len(got) > len(expected):
        return {'match': True, 'difference': f'extra "{got[len(expected)]}"'}
    return {'match': True, 'difference': ''}


def readback(transport, postcard_b64, deadline, sleep, clock):
    """One read-back of the postcard image. Returns (lines, tin, tout, sends)."""
    data_url = 'data:image/jpeg;base64,' + postcard_b64
    j, attempt, _ = transport.post('/chat/completions', readback_body(READBACK_PROMPT, data_url),
                                   deadline, sleep, clock)
    holder = getattr(transport, 'holder', None)
    lines, tin, tout = read_readback(j, holder)
    return lines, tin, tout, attempt


# The worst case a postcard is reserved at before it is sent: the picture's
# fixed price plus the read-back at its worst (the read's input bound and the
# read-back's own output ceiling).
READBACK_WORST = spark_cost(config.SPARK_WORST_IN_TOKENS, config.READBACK_MAX_COMPLETION_TOKENS)
POSTCARD_WORST = config.POSTCARD_USD + READBACK_WORST


def edit_postcard(transport, room, photo_data_url, user_id, deadline, sleep, clock):
    """The picture call: returns (b64 JPEG, usage, sends)."""
    return image_edit(transport, postcard_prompt(room), photo_data_url, user_id, deadline, sleep, clock)
