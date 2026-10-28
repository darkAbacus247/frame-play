# Provenance

- This repository was created on 2026-10-26 after 16:00 UTC, the start of the
  Meta Global AI Developer Hackathon. Every file in it was written during the
  event. The git history carries the true time of every commit.
- Pre-existing: Meta's Muse Spark and SAM 3.1 models, SAM's mask format
  (ported under its license), and the written notes of my pre-event
  prototype (Oct 21 to 25), read as a spec, with none of its code; built
  during the event, from the first commit: all the code, art, music and
  tests. None of the prototype's source was opened while this code was
  written.
- Built with AI assistance: Claude Code (Anthropic) wrote the code under the
  author's direction.
- Model outputs (from Meta's muse-spark-1.3 and sam-3.1, in live mode) are data
  read at run time. They are never code. Two recorded sets are kept as data,
  byte for byte as the models answered: the first live answers for the desk
  sample picture (server/tests/fixtures/desk_1027.json, a test fixture), and
  the answers for the sample kitchen photo, read on 2026-10-27
  (server/replay/kitchen/: one muse-spark-1.3 answer and six sam-3.1
  answers), which the server replays where no model may be called and every
  screen says so. They hold no personal data: one kitchen, no people.
- rooms/kitchen.jpg is the author's own photo of a real kitchen (1024 x 399,
  camera data removed), released with this repository under its license.
- A table of every file's first-commit time is generated at the freeze.

## Disclosure

FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October
26 to Nov. 4, 2026). Pre-existing: Meta's Muse Spark and SAM 3.1 models,
SAM's mask format (ported under its license), and the written notes of my
pre-event prototype (Oct 21 to 25), read as a spec, with none of its code;
built during the event, from the first commit: all the code, art, music and
tests. Built with AI assistance: Claude Code (Anthropic) wrote the code
under my direction. Live rooms are read by Meta's muse-spark-1.3 and sam-3.1
through the Meta Model API; sample rooms are drawn by code and labeled MOCK.
