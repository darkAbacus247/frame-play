# FRAME//PLAY

Photograph your room. Play it.

FRAME//PLAY turns one still photo of a room or a desk top into a small 2.5D
adventure stage. The outlines of the real objects in the picture become the
walls you walk around, the things you collect, the hazard you avoid and the
exit you reach.

Status: work in progress. This repository was created on 2026-10-26 after
16:00 UTC, during the event. The full README is written as the build lands.

## Running it

Python 3.10 or newer, standard library only; no packages to install.

```
python server/server.py
```

The page is at `http://127.0.0.1:8191/`. Without `MODEL_API_KEY` and
`FRAMEPLAY_LIVE=yes` in the operator's own environment the server runs in
MOCK mode: sample rooms drawn by code, labeled MOCK, and no model is called.

A rehearsal runs the live path against a local stand-in, never Meta, and
holds no key:

```
python server/standin.py --room desk --port 8192
python server/server.py --rehearse http://127.0.0.1:8192/v1 --rehearsal-room desk
```

## Tests

```
node --test
python -m unittest discover
```

## Known limits (so far)

- Live mode is written against the Model API's documented shapes and tested
  only against a local stand-in; it has not yet been run against Meta.
- sam-3.1's answer text is parsed from our reading of Meta's published SAM 3
  text format; the first live answers will confirm it.
- Live outlines are traced by code inside SAM's boxes; an object whose trace
  is not tight falls back to its box, and the reveal says so. Small, low
  contrast objects are the hardest to trace.
- One photo, one room; a 2.5D approximation with one baseline per object.

## Disclosure

FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October 26
to November 4, 2026). An earlier prototype informed the design; no prototype
code is included. Built with AI assistance: Claude Code (Anthropic) wrote the
code under my direction. Live rooms are read by Meta's muse-spark-1.3 and
sam-3.1 through the Meta Model API; sample rooms are drawn by code and labeled
MOCK.

## License

MIT. See [LICENSE](LICENSE).
