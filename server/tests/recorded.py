"""The first live answers (10-27, the desk sample picture), played back to
the pipeline by a test double in place of its transport: nothing is sent
anywhere. Muse Spark's read and sam-3.1's answer texts are the recorded
ones (fixtures/desk_1027.json); `answers` may replace some of them.

  python -B -m server.tests.recorded            prints the pipeline's reply
  python -B -m server.tests.recorded --sam none  every SAM answer is no match
  python -B -m server.tests.recorded --spoil-mask "coffee mug"
      that noun's masks no longer decode (the payloads keep their alphabet)
"""
import argparse
import json
import sys
from pathlib import Path

from server import config
from server.config import settings_from
from server.imageinfo import check_photo
from server.limits import Limits
from server.pipeline import Pipeline
from server.tests import images
from server.tests.fakemeta import sam_answer

FIXTURE = json.loads((Path(__file__).parent / 'fixtures' / 'desk_1027.json').read_text(encoding='utf-8'))
W, H = FIXTURE['width'], FIXTURE['height']


class RecordedTransport:
    """Answers each call with its recorded answer. The settings are a
    rehearsal's (built from an empty environment), so no key can be near."""

    def __init__(self, answers=None):
        self.answers = dict(FIXTURE['answers'], **(answers or {}))
        self.sent = []

    def post(self, route, body, deadline, sleep=None, clock=None):
        if route == '/chat/completions':
            self.sent.append(('read', None))
            return {'object': 'chat.completion', 'model': config.SPARK_MODEL,
                    'choices': [{'index': 0, 'finish_reason': 'stop',
                                 'message': {'role': 'assistant', 'content': json.dumps(FIXTURE['read'])}}],
                    'usage': FIXTURE['read_usage']}, 1, 5
        noun = body['input'][0]['content'][0]['text']
        self.sent.append(('find', noun))
        return json.loads(sam_answer(self.answers.get(noun, '<0f>\n'))[2]), 1, 5


def spoilt(text):
    """The same answer with every mask payload spoilt: its last three
    characters changed, so it keeps its alphabet and length and no longer
    decodes."""
    parts = text.split('data=')
    out = [parts[0]]
    for part in parts[1:]:
        rows, cols, rest = part.split(',', 2)
        payload, tail = rest.split('|>', 1)
        out.append(f'{rows},{cols},{payload[:-3]}abc|>{tail}')
    return 'data='.join(out)


def run(answers=None, log=None):
    pipe = Pipeline(settings_from({}, 'http://127.0.0.1:9/v1', 'desk'), Limits(), log=log,
                    transport=RecordedTransport(answers), sleep=lambda s: None)
    return pipe.run(check_photo(images.jpeg(W, H), config.MAX_SIDE))


def main(argv=None):
    ap = argparse.ArgumentParser(description='the recorded desk answers through the pipeline (nothing is sent)')
    ap.add_argument('--sam', choices=('recorded', 'none'), default='recorded')
    ap.add_argument('--none-for', default='', help='comma-separated nouns whose SAM answer becomes no match')
    ap.add_argument('--spoil-mask', default='', help='comma-separated nouns whose masks no longer decode')
    args = ap.parse_args(argv)
    nouns = list(FIXTURE['answers']) if args.sam == 'none' else [n for n in args.none_for.split(',') if n]
    answers = {n: spoilt(FIXTURE['answers'][n]) for n in args.spoil_mask.split(',') if n}
    answers.update({n: '<0f>\n' for n in nouns})
    print(json.dumps(run(answers)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
