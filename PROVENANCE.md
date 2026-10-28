# Provenance

- This repository was created on 2026-10-26 after 16:00 UTC, the start of the
  Meta Global AI Developer Hackathon. Every file in it was written during the
  event, except rooms/kitchen.jpg, a photo (below). The git history carries
  the true time of every commit.
- Pre-existing: Meta's Muse Spark and SAM 3.1 models, SAM's mask format
  (ported under its license), and the written notes of my pre-event
  prototype (Oct 21 to 25), read as a spec, with none of its code; built
  during the event, from the first commit: all the code, art, music and
  tests. None of the prototype's source was opened while this code was
  written.
- Built with AI assistance: Claude Code (Anthropic) wrote the code under the
  author's direction.
- The first day's pace: the design was written from 16:11 to 16:18 UTC on
  2026-10-26, before the first commit at 16:23:40 UTC, and Claude Code
  (Anthropic) wrote the code from it under the author's direction. So the
  first playable build was committed at 16:54:29 UTC, and about 11,000
  lines were added by 17:43:37 UTC (commits S0 to S14). The design is a separate
  document, kept outside this repository.
- Model outputs (from Meta's muse-spark-1.3 and sam-3.1, in live mode) are data
  read at run time. They are never code. Two recorded sets are kept as data,
  byte for byte as the models answered: the first live answers for the desk
  sample picture (server/tests/fixtures/desk_1027.json, a test fixture), and
  the answers for the sample kitchen photo, read on 2026-10-27
  (server/replay/kitchen/: one muse-spark-1.3 answer and six sam-3.1
  answers), which the server replays where no model may be called and every
  screen says so. They hold no personal data: one kitchen, no people.
- rooms/kitchen.jpg is the author's own photo of a real kitchen (1024 x 399,
  camera data removed), added on Oct 27, 2026, during the event, with no
  recorded capture date. It is released with this repository under the MIT
  license.
- FIRST_COMMITS.md lists every file's first-commit time, made from the git
  history by `python -B tools/first_commits.py`, and is made again at the
  freeze.

## Disclosure

FRAME//PLAY was built during the Meta Global AI Developer Hackathon (October
26 to Nov. 4, 2026). Pre-existing: Meta's Muse Spark and SAM 3.1 models,
SAM's mask format (ported under its license), and the written notes of my
pre-event prototype (Oct 21 to 25), read as a spec, with none of its code;
built during the event, from the first commit: all the code, art, music and
tests. Built with AI assistance: Claude Code (Anthropic) wrote the code
under my direction. Live rooms are read by Meta's muse-spark-1.3 and sam-3.1
through the Meta Model API; sample rooms are drawn by code and labeled MOCK.
