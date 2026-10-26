import unittest

from server import samtext
from server.samtext import envelope, parse

MASK = envelope('a1B2<c3>d4~')


def rec(i, box, c=None, mask=MASK, extra=''):
    s = f'<id>{i}<box>{box}'
    if c is not None:
        s += f'<c>{c}'
    return s + extra + f'<mask>{mask}'


class Grammar(unittest.TestCase):
    def test_records_boxes_half_open_and_size(self):
        text = '<0f><w>1024<h>768' + rec(1, '10 20 109 59', 0.93) + rec(2, '300 300 300 300', 0.5)
        p = parse(text, 1024, 768)
        self.assertEqual(p.errors, [])
        self.assertEqual(p.warnings, [])
        self.assertEqual((p.width, p.height), (1024, 768))
        self.assertEqual(p.records[0]['box'], [10, 20, 110, 60])
        self.assertEqual(p.records[0]['confidence'], 0.93)
        self.assertEqual(p.records[1]['box'], [300, 300, 301, 301], 'a one-pixel box')
        self.assertEqual(p.records[0]['mask'], {'encoding': 'one_bit', 'payload_chars': 11})

    def test_the_mask_may_hold_angle_brackets(self):
        tricky = envelope('<id>9<box>1;2;3;4')
        p = parse('<0f><w>64<h>64' + rec(1, '0 0 9 9', 0.9, tricky), 64, 64)
        self.assertEqual(len(p.records), 1)
        self.assertEqual(p.errors, [])

    def test_zero_matches(self):
        p = parse('<0f><w>64<h>64', 64, 64)
        self.assertEqual((p.records, p.errors), ([], []))

    def test_size_must_match_the_copy(self):
        p = parse('<0f><w>1000<h>768' + rec(1, '1 1 5 5', 0.9), 1024, 768)
        self.assertIn('size_mismatch', p.errors)
        p = parse('<0f>' + '<id>1<w>800<h>600<box>1 1 5 5<c>0.9<mask>' + MASK, 1024, 768)
        self.assertIn('size_mismatch', p.errors, 'a record’s own size counts too')

    def test_malformed_records_are_dropped_and_reported(self):
        text = ('<0f><w>64<h>64'
                + rec(1, '10 10 5 5', 0.9)          # x2 before x1
                + rec(2, '1 2 3', 0.9)              # three numbers
                + rec(3, '0 0 64 10', 0.9)          # x2 outside the picture
                + rec(4, '0 0 9 9', 0.9, '1' + samtext.b85_count(50) + 'short')  # envelope too short
                + rec(5, '0 0 9 9', 0.9, 'Zjunk')   # unknown encoding marker
                + rec(6, '1 1 8 8', 0.9))
        p = parse(text, 64, 64)
        self.assertEqual([r['id'] for r in p.records], [6])
        self.assertEqual(p.errors.count('malformed_record'), 5)

    def test_warnings_once_per_answer(self):
        text = ('garbage before <0f><w>64<h>64'
                + rec(1, '1 1 8 8', 0.9, extra='<zz>odd') + ' stray words '
                + rec(2, '1 1 8 8', 1.7, extra='<zz>again')
                + '<id>3<box>1 1 8 8<c>0.4<c>0.6<mask>' + MASK)
        p = parse(text, 64, 64)
        self.assertEqual(sorted(p.warnings), ['ignored_confidence', 'ignored_field', 'ignored_token'])
        self.assertEqual(len(p.warnings), 3)
        self.assertEqual(p.records[1]['confidence'], None, 'an out-of-range confidence is ignored')
        self.assertEqual(p.records[2]['confidence'], 0.4, 'a repeated confidence is ignored')

    def test_no_frame_and_non_text(self):
        self.assertEqual(parse('<id>1<box>1 1 2 2').errors, ['no_frame'])
        self.assertEqual(parse(None).errors, ['no_frame'])

    def test_envelope_checks(self):
        with self.assertRaises(ValueError):
            envelope('no spaces allowed')
        self.assertEqual(samtext.b85_count(0), '00000')
        self.assertEqual(len(samtext.b85_count(85 ** 5 - 1)), 5)


if __name__ == '__main__':
    unittest.main()
