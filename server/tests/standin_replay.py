"""A sample room's answers from the stand-in (not Meta), played to the
pipeline in this process, with no socket: the stand-in answers each call as
it would over the loopback, in sam-3.1's own grammar. The reply is a
rehearsal's (built from an empty environment, so no key can be near).

  python -B -m server.tests.standin_replay --room apartment
  python -B -m server.tests.standin_replay --room apartment --golden
      (the reply with what changes from run to run taken out)
"""
import argparse
import json
import sys

from server import config
from server.config import settings_from
from server.imageinfo import check_photo
from server.limits import Limits
from server.meta_api import CallError
from server.pipeline import Pipeline
from server.standin import StandIn
from server.tests import images


class StandInTransport:
    def __init__(self, standin):
        self.standin = standin

    def post(self, route, body, deadline, sleep=None, clock=None):
        status, _, obj = self.standin.answer('/v1' + route, {'Authorization': 'Bearer ' + config.REHEARSAL_CREDENTIAL}, body)
        if status != 200:
            raise CallError(f'http_{status}', f'The stand-in answered {status}.', status=status)
        return obj, 1, 5


def run(room):
    standin = StandIn(room)
    W, H = standin.room['width'], standin.room['height']
    pipe = Pipeline(settings_from({}, 'http://127.0.0.1:9/v1', room), Limits(),
                    transport=StandInTransport(standin), sleep=lambda s: None)
    return pipe.run(check_photo(images.jpeg(W, H), config.MAX_SIDE))


def golden(reply):
    """The reply without what changes from run to run."""
    out = json.loads(json.dumps(reply))
    out.pop('request_id', None)
    prov = out['provenance']
    for k in ('started', 'total_ms', 'image_sha256'):
        prov.pop(k, None)
    for c in prov['calls']:
        c.pop('ms', None)
    prov['calls'].sort(key=lambda c: (c['stage'], c.get('noun', '')))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='a sample room through the stand-in and the pipeline, in one process (not Meta)')
    ap.add_argument('--room', default='desk')
    ap.add_argument('--golden', action='store_true')
    args = ap.parse_args(argv)
    reply = run(args.room)
    # ASCII only, so no console's own encoding can change a word
    print(json.dumps(golden(reply) if args.golden else reply, indent=1 if args.golden else None))
    return 0


if __name__ == '__main__':
    sys.exit(main())
