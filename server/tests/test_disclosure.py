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


if __name__ == '__main__':
    unittest.main()
