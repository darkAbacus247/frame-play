import json
import unittest
from pathlib import Path

from server.samtext import ALPHABET, compose, parse

FIXTURE = json.loads((Path(__file__).parent / 'fixtures' / 'desk_1027.json').read_text(encoding='utf-8'))
REAL = FIXTURE['answers']


def rec(i, x1, y1, x2, y2, c='0.9', w=64, h=64, data=None, extra_box='', mask=None):
    rows, cols = y2 - y1 + 1, x2 - x1 + 1
    box = f'{i}<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={w};h={h};c={c}{extra_box}|>'
    if mask is None:
        mask = f'<|mask;x=0;y=0;c={c};data={data or f"{rows},{cols},!!!!!abc"}|>'
    return box + mask


class RealAnswers(unittest.TestCase):
    """The answers sam-3.1 gave on the first live calls, as recorded."""

    def test_every_recorded_answer_parses_cleanly(self):
        counts = {}
        for noun, text in REAL.items():
            p = parse(text, 1024, 768)
            self.assertEqual((p.errors, p.warnings), ([], []), noun)
            self.assertEqual((p.width, p.height), (1024, 768))
            counts[noun] = len(p.records)
        self.assertEqual(counts, {'coffee mug': 1, 'desk lamp': 1, 'cardboard box': 1, 'blue notebook': 2,
                                  'desk': 1, 'gold coin': 3, 'potted cactus': 1, 'book stack': 1})

    def test_the_mug(self):
        p = parse(REAL['coffee mug'], 1024, 768)
        r = p.records[0]
        self.assertEqual(r['id'], 0)
        self.assertEqual(r['box'], [560, 383, 670, 482], 'inclusive corners made half-open')
        self.assertAlmostEqual(r['confidence'], 0.949367105960846)
        self.assertEqual(r['mask'], {'encoding': 'one_bit', 'rows': 99, 'cols': 110, 'x': 0, 'y': 0, 'payload_chars': 98})

    def test_several_matches_in_order(self):
        p = parse(REAL['gold coin'], 1024, 768)
        self.assertEqual([r['id'] for r in p.records], [0, 1, 2])
        self.assertEqual([r['box'] for r in p.records], [[725, 552, 759, 573], [283, 444, 317, 465], [453, 332, 487, 353]])
        self.assertEqual([round(r['confidence'], 4) for r in p.records], [0.8828, 0.8865, 0.8788])
        p = parse(REAL['blue notebook'], 1024, 768)
        self.assertEqual([round(r['confidence'], 4) for r in p.records], [0.9336, 0.5937])

    def test_the_mask_shape_is_the_box(self):
        for noun, text in REAL.items():
            for r in parse(text, 1024, 768).records:
                x0, y0, x1, y1 = r['box']
                self.assertEqual((r['mask']['rows'], r['mask']['cols']), (y1 - y0, x1 - x0), noun)

    def test_the_payload_alphabet(self):
        self.assertEqual(len(ALPHABET), 85)
        for ch in ',;<>|':
            self.assertNotIn(ch, ALPHABET, 'the token separators never occur in a payload')
        seen = set()
        for text in REAL.values():
            for part in text.split('data=')[1:]:
                seen |= set(part.split(',', 2)[2].split('|>')[0])
        self.assertLessEqual(seen, set(ALPHABET))

    def test_a_size_mismatch(self):
        p = parse(REAL['coffee mug'], 512, 384)
        self.assertIn('size_mismatch', p.errors)

    def test_compose_writes_what_parse_reads(self):
        text = compose([{'box': [560, 383, 669, 481], 'confidence': 0.949367105960846, 'payload': '!!!!!pEP5o'}], 1024, 768)
        self.assertEqual(text[:text.index('data=')], REAL['coffee mug'][:REAL['coffee mug'].index('data=')])
        self.assertTrue(text.endswith('|>\n'))
        self.assertEqual(parse(text, 1024, 768).records[0]['box'], [560, 383, 670, 482])
        with self.assertRaises(ValueError):
            compose([{'box': [0, 0, 1, 1], 'confidence': 0.5, 'payload': 'a|b'}], 8, 8)


class NoMatch(unittest.TestCase):
    def test_the_frame_alone(self):
        for text in ('<0f>', '<0f>\n', '<0f>  \r\n'):
            p = parse(text, 64, 64)
            self.assertEqual((p.records, p.errors, p.warnings), ([], [], []), repr(text))

    def test_an_empty_text_is_no_match_and_says_so(self):
        for text in ('', '\n'):
            p = parse(text, 64, 64)
            self.assertEqual((p.records, p.errors, p.warnings), ([], [], ['empty_answer']))

    def test_no_frame_and_non_text(self):
        self.assertEqual(parse('0<|box;x1=1;y1=1;x2=2;y2=2;w=64;h=64;c=0.9|>').errors, ['no_frame'])
        self.assertEqual(parse(None).errors, ['no_frame'])
        self.assertEqual(parse({'text': '<0f>'}).errors, ['no_frame'])


class Broken(unittest.TestCase):
    def test_malformed_records_are_dropped_and_reported(self):
        text = ('<0f>'
                + rec(0, 10, 10, 5, 5) + ','                              # x2 before x1
                + '1<|box;x1=1;y1=2;x2=3;w=64;h=64;c=0.9|><|mask;x=0;y=0;c=0.9;data=1,1,!|>,'  # no y2
                + rec(2, 0, 0, 64, 10) + ','                              # x2 outside the picture
                + rec(3, 0, 0, 9, 9, data='10,10,') + ','                 # an empty payload
                + rec(4, 0, 0, 9, 9, data='10,10,ab~c') + ','             # outside the alphabet
                + rec(5, 0, 0, 9, 9, data='ten,10,abc') + ','             # rows not a number
                + '<|box;x1=1;y1=1;x2=8;y2=8;w=64;h=64;c=0.9|><|mask;x=0;y=0;c=0.9;data=8,8,!|>,'  # no id
                + rec(7, 1, 1, 8, 8) + ','
                + '8<|box;x1=1;y1=1;x2=8;y2=8;w=64;h=64;c=0.9|><|mask;x=0;y=0;data=8,8,!!!')  # cut short
        p = parse(text, 64, 64)
        self.assertEqual([r['id'] for r in p.records], [7])
        self.assertEqual(p.errors.count('malformed_record'), 8)

    def test_a_mask_without_its_box(self):
        p = parse('<0f><|mask;x=0;y=0;c=0.9;data=1,1,!|>' + rec(1, 1, 1, 8, 8), 64, 64)
        self.assertEqual(p.errors, ['malformed_record'])
        self.assertEqual(len(p.records), 1)

    def test_warnings_once_per_answer(self):
        text = ('garbage before <0f>'
                + rec(0, 1, 1, 8, 8, extra_box=';zz=odd') + ' stray words ,'
                + rec(1, 1, 1, 8, 8, c='1.7') + ','
                + '<|note;a=b|>,'
                + rec(2, 1, 1, 8, 8, extra_box=';q=1') + ','
                + rec(3, 1, 1, 8, 8, data='5,5,abc') + ','
                + rec(4, 1, 1, 8, 8, mask='') + ','
                + '5<|box;x1=1;y1=1;x2=8;y2=8;w=64;h=64;c=0.4|><|mask;x=0;y=0;c=0.6;data=8,8,abc|>')
        p = parse(text, 64, 64)
        self.assertEqual(p.errors, [])
        self.assertEqual(sorted(p.warnings), ['ignored_confidence', 'ignored_field', 'ignored_token', 'mask_shape', 'no_mask'])
        self.assertEqual([r['id'] for r in p.records], [0, 1, 2, 3, 4, 5])
        self.assertIsNone(p.records[1]['confidence'], 'an out-of-range confidence is ignored')
        self.assertEqual(p.records[5]['confidence'], 0.4, 'the box’s confidence counts')
        self.assertIsNone(p.records[4]['mask'])

    def test_size_must_match_the_copy(self):
        p = parse('<0f>' + rec(0, 1, 1, 5, 5, w=1000, h=768), 1024, 768)
        self.assertIn('size_mismatch', p.errors)

    def test_nothing_ever_raises(self):
        samples = ['<0f>' + x for x in ('<|', '|>', '0<|box', '0<|box;|>', '0<|box;=|>', '0<|box;x1=1;x1=1|>',
                                        '<|mask', ',,,', '99999999<|box;|>', '0<|box;x1=-1;y1=0;x2=1;y2=1;w=4;h=4|>')]
        samples += [REAL['gold coin'][:k] for k in range(0, len(REAL['gold coin']), 7)]
        for text in samples:
            p = parse(text, 1024, 768)
            self.assertIsInstance(p.records, list)


if __name__ == '__main__':
    unittest.main()
