"""For the page's end-to-end test (tests/own_e2e.test.js): the stand-in and
the app's server in rehearsal mode, both on this machine's loopback at free
ports, in one process. Prints {"port": N} for the app's server, then serves
until its standard input closes. Never live: the settings are built from an
empty environment, so no key or live switch can reach them.

  python -B -m server.tests.rehearsal_pair --room desk
"""
import argparse
import json
import sys
import threading

from server.config import settings_from
from server.server import Log, build_server
from server.standin import StandIn, make_server


def main(argv=None):
    ap = argparse.ArgumentParser(description='stand-in and server in rehearsal, for tests (not Meta)')
    ap.add_argument('--room', default='desk')
    args = ap.parse_args(argv)
    standin = make_server(StandIn(args.room), '127.0.0.1', 0)
    threading.Thread(target=standin.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{standin.server_address[1]}/v1'
    srv = build_server(settings_from({}, base, args.room), '127.0.0.1', 0, log=Log(stream=[]))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(json.dumps({'port': srv.server_address[1]}), flush=True)
    try:
        sys.stdin.read()
    finally:
        srv.shutdown()
        srv.server_close()
        standin.shutdown()
        standin.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
