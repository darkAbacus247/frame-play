"""The repository's own words about itself (README.md, PROVENANCE.md and the
page's comments) say only what the code keeps."""
import importlib.util
import os
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def text(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def flat(rel):
    """A file's words on one line, so a phrase may wrap anywhere."""
    return ' '.join(text(rel).split())


class Controls(unittest.TestCase):
    def test_no_stick_is_promised(self):
        # claims-2: the explorer is steered by the keys, the pad and taps;
        # the page reads no gamepad and draws no stick
        page = ['README.md', 'app.js', 'index.html'] + sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'src').glob('*.js'))
        for rel in page:
            self.assertIsNone(re.search(r'\b(stick|joystick|gamepad)\b', text(rel), re.I), rel)
        self.assertIn('by the keys, the pad and taps', flat('README.md'))


# The one sentence the organizers asked for, the same wherever it is said
# (here, in the write-up and on the video's opening card).
PRE_EXISTING = ("Pre-existing: Meta's Muse Spark and SAM 3.1 models, SAM's mask format (ported under its license), "
                "and the written notes of my pre-event prototype (Oct 21 to 25), read as a spec, with none of its code; "
                "built during the event, from the first commit: all the code, art, music and tests.")


class WhatWasPreExisting(unittest.TestCase):
    def test_one_account_of_what_was_pre_existing(self):
        # rules-1, claims-4: the opening of the README, its Disclosure and
        # PROVENANCE.md (its list and its Disclosure) say the same sentence,
        # the earlier prototype in it, and no other account
        for rel in ('README.md', 'PROVENANCE.md'):
            words = flat(rel)
            self.assertEqual(words.count(PRE_EXISTING), 2, rel)
            self.assertNotIn('Everything else was built this week', words, rel)
            self.assertNotIn('An earlier prototype informed the design', words, rel)
        readme = flat('README.md')
        self.assertLess(readme.index(PRE_EXISTING), readme.index('**Who it is for.**'), 'said before anything else')
        # the page's own Disclosure (Settings, About), in its typographic
        # apostrophes
        page = re.search(r"^export const DISCLOSURE = '(.*)';$", text('app.js'), re.M).group(1)
        self.assertIn(PRE_EXISTING.replace("'", '’'), page)
        self.assertNotIn('An earlier prototype informed the design', page)

    def test_every_notice_pointer_finds_the_notice(self):
        # rules-6: there is no NOTICE file; the notice is the paragraph under
        # License in the README, and every pointer says where it is
        readme = flat('README.md')
        self.assertFalse((ROOT / 'NOTICE').exists())
        self.assertIn('## License', readme)
        self.assertIn('**NOTICE.**', readme.split('## License', 1)[1])
        pointers = re.findall(r'\bNOTICE\b(?!\.\*\*)(.{0,16})', readme)
        self.assertTrue(pointers)
        for after in pointers:
            self.assertTrue(after.startswith((' below', ' under License')), after)


class Voice(unittest.TestCase):
    def test_no_aside_names_the_author_as_his(self):
        # the repository is read by judges: a choice is the author's, said
        # in a neutral voice (this file, which holds the pattern, aside)
        files = ['README.md', 'PROVENANCE.md', 'app.js', 'index.html']
        for folder, pattern in (('src', '*.js'), ('tests', '*.js'), ('server', '*.py'), ('server/tests', '*.py')):
            files += sorted(str(p.relative_to(ROOT)) for p in (ROOT / folder).glob(pattern))
        for rel in files:
            if Path(rel).name == Path(__file__).name:
                continue
            self.assertIsNone(re.search(r'\bhis \d\d-\d\d\b|\(his ', text(rel)), rel)


class Claims(unittest.TestCase):
    def test_the_people_refusal_is_said_for_reads_only(self):
        # claims-5: Muse Spark's flag stops a LIVE read; in MOCK nothing
        # reads the photo, so nothing checks it for people
        readme = flat('README.md')
        self.assertIn('in LIVE, Muse Spark sees a person in the photo it reads, and the read stops there', readme)
        self.assertIn('In MOCK no model reads the photo, so nothing checks it for people', readme)

    def test_a_riddle_count_is_the_number_of_its_answers(self):
        # claims-6: n is len(answer_ids) Muse Spark chose (server/riddles.py),
        # each one a thing SAM found; SAM does not give the count
        self.assertIn("'n': len(ids)", text('server/riddles.py'))
        for rel in ('README.md', 'server/riddles.py', 'src/riddle.js'):
            words = flat(rel)
            for said in ('where they are and how many there are', "from SAM's records", 'count from SAM', 'count SAM confirmed', 'how many come from SAM'):
                self.assertNotIn(said, words, rel)
        self.assertIn('code fills in the count of those answers', flat('README.md'))

    def test_screen_reader_support_is_said_as_far_as_it_is_checked(self):
        # claims-11: the tests run on a stand-in page; no real screen reader
        # run is recorded
        readme = flat('README.md')
        self.assertNotIn('every screen works by keyboard and screen reader', readme)
        self.assertIn('no run with a real screen reader is recorded here yet', readme)

    def test_object_outlines_keep_their_holes_the_floor_does_not(self):
        # claims-16: src/geom.js keeps holes (even-odd); src/floor_mask.js
        # fills the floor's
        readme = flat('README.md')
        self.assertNotIn("walk, read even-odd (a mug's handle stays open)", readme)
        self.assertIn("An object's outline keeps its holes; the floor's holes, where things stand, are filled as hidden floor", readme)


def git_history():
    """True when this copy carries its git history and git can read it."""
    try:
        return (ROOT / '.git').exists() and subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True).returncode == 0
    except OSError:
        return False


class Provenance(unittest.TestCase):
    def test_the_first_days_pace_is_explained(self):
        # rules-2: the design came first, and Claude Code wrote the code
        words = flat('PROVENANCE.md')
        self.assertIn('the design was written from 16:11 to 16:18 UTC on 2026-10-26, before the first commit at 16:23:40 UTC', words)
        self.assertIn('Claude Code (Anthropic) wrote the code from it under the author\'s direction', words)

    def test_the_kitchen_photo_is_said_as_far_as_it_is_known(self):
        # claims-4: the photo was added during the event; when it was taken
        # is not recorded, so "every file was written during the event" is
        # not said of it
        words = flat('PROVENANCE.md')
        self.assertNotIn('Every file in it was written during the event.', words)
        self.assertIn('Every file in it was written during the event, except rooms/kitchen.jpg', words)
        self.assertIn("rooms/kitchen.jpg is the author's own photo of a real kitchen (1024 x 399, camera data removed), "
                      'added on Oct 27, 2026, during the event, with no recorded capture date', words)

    @unittest.skipUnless(git_history(), 'no git history in this copy')
    def test_the_kitchen_photo_was_added_on_oct_27(self):
        out = subprocess.run(['git', 'log', '--diff-filter=A', '--format=%ad', '--date=format-local:%Y-%m-%d',
                              '--', 'rooms/kitchen.jpg'], cwd=ROOT, capture_output=True, text=True,
                             env={**os.environ, 'TZ': 'UTC'})
        self.assertEqual(out.stdout.split(), ['2026-10-27'])

    def test_the_first_commit_table_is_in_the_repository(self):
        # rules-6, claims-15: the table PROVENANCE.md promises is here
        self.assertIn('FIRST_COMMITS.md lists every file\'s first-commit time', flat('PROVENANCE.md'))
        self.assertNotIn('is generated at the freeze', flat('PROVENANCE.md'))
        self.assertTrue(text('FIRST_COMMITS.md').startswith('# First commit of every file\n'))

    @unittest.skipUnless(git_history(), 'no git history in this copy')
    def test_the_table_is_what_git_says(self):
        # the table, made again from git for the commit it names, is the same
        # to the byte
        spec = importlib.util.spec_from_file_location('first_commits', ROOT / 'tools' / 'first_commits.py')
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        table = text('FIRST_COMMITS.md')
        commit = re.search(r'^Every file tracked at commit ([0-9a-f]{7}) ', table, re.M).group(1)
        self.assertEqual(table, tool.table(commit))
        self.assertEqual(tool.first_commits(commit)[0][1:], ('2026-10-26 16:23:40', '3158da3'), 'the first commit')


class License(unittest.TestCase):
    # the two files the SAM License covers, each saying so in its header
    SAM_FILES = ('server/sam_mask.py', 'server/tests/lossless_encoder.py')

    def test_mit_is_never_said_without_the_two_sam_files(self):
        # rules-7, claims-14: wherever the repository names its license, the
        # two files under the SAM License are named with it
        for rel in self.SAM_FILES:
            self.assertIn('distributed under the SAM License (LICENSES/SAM_LICENSE.txt)', ' '.join(text(rel).split()), rel)
        license = flat('README.md').split('## License', 1)[1].strip()
        self.assertTrue(license.startswith('MIT, except two files under the SAM License (see NOTICE below).'), license[:80])
        for rel in self.SAM_FILES:
            self.assertIn(rel, license)
        self.assertIn("'MIT license, except two files under the SAM License.", text('app.js'))
        self.assertNotIn("'MIT license.", text('app.js'))
        self.assertIn('"license": "MIT AND LicenseRef-SAM-License"', text('package.json'))


if __name__ == '__main__':
    unittest.main()
