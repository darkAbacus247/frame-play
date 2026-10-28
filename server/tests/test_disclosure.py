"""The repository's own words about itself (README.md, PROVENANCE.md and the
page's comments) say only what the code keeps."""
import re
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
