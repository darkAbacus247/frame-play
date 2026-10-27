"""The project's own sample photo, read by Meta's models once and replayed.

rooms/kitchen.jpg is the author's own photo of a real kitchen (1024 x 399,
camera data already removed), released with the repository. On 2026-10-27
it went through the live path: one muse-spark-1.3 answer and six sam-3.1
answers (the stove, the kitchen island, the refrigerator, the counter, the
floor and the door, each with real one_bit masks), kept byte for byte in
server/replay/kitchen/.

Where no model may be called (MOCK, REHEARSAL), POST /api/replay/kitchen
replays them: the very same Pipeline that reads a live photo runs on the
kitchen photo, with a transport that answers each call with its recorded
answer in place of the network. The same reader, mask decoder, match
choice, floor and outlines run; nothing is sent anywhere. The reply says
so: its mode is 'replay', it claims no model called now, its calls are
marked replayed, its usage is zero, and its words say when the models read
the photo.
"""
import hashlib
import json
import threading
from pathlib import Path

from server import config
from server.config import Settings
from server.imageinfo import check_photo
from server.limits import Refusal, Reservation
from server.meta_api import CallError
from server.pipeline import PROGRESS, Pipeline

ROOT = Path(__file__).resolve().parent.parent
PHOTO = ROOT / 'rooms' / 'kitchen.jpg'
ANSWERS = Path(__file__).resolve().parent / 'replay' / 'kitchen'
# the photo the answers are for: a different file is never replayed as it
PHOTO_SHA256 = '2de87d6b4789bc08269eaba5f05bb61b391294a5672f334543bccb4063335d7c'
RECORDED = '2026-10-27'
WORDS = ("Meta’s models read this photo on Oct 27, 2026; this copy replays their recorded answer; "
         'no model was called now.')
# the replay's own progress words, in place of the live read's
REPLAY_PROGRESS = {
    PROGRESS[0][1]: 'Replaying Muse Spark’s recorded read',
    PROGRESS[1][1]: 'Replaying SAM 3.1’s recorded answers',
}
NOT_RECORDED_WORDS = 'This call has no recorded answer, so it cannot be replayed.'
MISMATCH_WORDS = 'The sample photo on this server is not the one the recorded answers are for, so they are not replayed.'


def load_answers(folder=ANSWERS):
    """The recorded answers: the room read, and SAM's answer by noun."""
    read, sam = None, {}
    for f in sorted(folder.glob('*.json')):
        rec = json.loads(f.read_text(encoding='utf-8'))
        if rec['route'] == '/chat/completions':
            read = rec['answer']
        elif rec['route'] == '/responses':
            sam[rec['prompt_text'][0]] = rec['answer']
    if read is None or not sam:
        raise ValueError('the recorded answers are incomplete')
    return read, sam


class ReplayTransport:
    """Answers each call with its recorded answer; nothing is sent. `asked`
    lists the calls in the order the pipeline made them."""

    def __init__(self, answers=None):
        self.read, self.sam = answers or load_answers()
        self.asked = []
        self.lock = threading.Lock()

    def post(self, route, body, deadline, sleep=None, clock=None):
        if route == '/chat/completions':
            with self.lock:
                self.asked.append(('read', None))
            return json.loads(json.dumps(self.read)), 1, 0
        noun = body['input'][0]['content'][0]['text']
        with self.lock:
            self.asked.append(('find', noun))
        if noun not in self.sam:
            raise CallError('not_recorded', NOT_RECORDED_WORDS, billed=False)
        return json.loads(json.dumps(self.sam[noun])), 1, 0


class ReplayLimits:
    """A replay costs nothing and sends nothing: only the photos in flight
    are held to the server's ceiling; no spend, hour or day is counted."""

    def __init__(self, in_flight=config.IN_FLIGHT):
        self.lock = threading.Lock()
        self.max_in_flight = min(in_flight, config.IN_FLIGHT)
        self.in_flight = 0

    def admit(self):
        with self.lock:
            if self.in_flight >= self.max_in_flight:
                raise Refusal('busy', 'Every reader on this server is busy with other photos. Please try again in a few seconds.', 5)
            self.in_flight += 1
            return True

    def finish(self):
        with self.lock:
            self.in_flight = max(0, self.in_flight - 1)

    def reserve(self, usd):
        return Reservation(0.0)

    def settle(self, res, actual_usd):
        res.open = False

    def release(self, res):
        res.open = False


def replay_settings():
    """A replay's settings: no key, no address that could be called."""
    return Settings('replay', 'Replaying the recorded answers for the sample kitchen photo; no model is called.')


def kitchen_photo():
    """The kitchen photo as the server's checks take it, or a ValueError when
    it is not the photo the answers are for."""
    data = PHOTO.read_bytes()
    if hashlib.sha256(data).hexdigest() != PHOTO_SHA256:
        raise ValueError(MISMATCH_WORDS)
    return check_photo(data, config.MAX_SIDE)


class ReplayPipeline(Pipeline):
    """The live Pipeline, its transport the recorded answers. Its reply is
    marked a replay in every place that says how the photo was read."""

    def __init__(self, log=None, transport=None, clock=None):
        kw = {'clock': clock} if clock else {}
        super().__init__(replay_settings(), ReplayLimits(), log=log, transport=transport or ReplayTransport(),
                         sleep=lambda s: None, **kw)

    def run(self, photo, progress=None):
        said = (lambda stage, words: progress(stage, REPLAY_PROGRESS.get(words, words))) if progress else None
        reply = super().run(photo, progress=said)
        prov = reply['provenance']
        recorded_usage = reply.get('usage')
        prov['models'] = []
        prov['replay'] = {
            'recorded': RECORDED, 'models': list(config.MODELS), 'photo': 'rooms/kitchen.jpg',
            'photo_sha256': PHOTO_SHA256, 'answers': len(self.transport.sam) + 1, 'words': WORDS,
            'recorded_usage': recorded_usage,
        }
        for c in prov['calls']:
            c['replayed'] = True
        reply['usage'] = {'calls': 0, 'spark_calls': 0, 'sam_calls': 0, 'tokens_in': 0, 'tokens_out': 0,
                          'reasoning_tokens': 0, 'estimated_usd': 0.0}
        return reply

    def handle_kitchen(self, handler, stream):
        """POST /api/replay/kitchen: the kitchen photo through the pipeline."""
        try:
            photo = kitchen_photo()
        except (OSError, ValueError) as e:
            words = str(e) if isinstance(e, ValueError) and str(e) == MISMATCH_WORDS else 'The sample photo is not on this server.'
            return handler.send_json(503, {'status': 'error', 'error': {'code': 'replay_unavailable', 'message': words}})
        return self.handle(handler, photo, stream)


def main():
    """Prints the replay's reply: python -B -m server.replay"""
    print(json.dumps(ReplayPipeline().run(kitchen_photo())))


if __name__ == '__main__':
    main()
