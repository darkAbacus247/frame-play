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


if __name__ == '__main__':
    unittest.main()
