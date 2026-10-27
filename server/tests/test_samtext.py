import json
import unittest
from pathlib import Path

from unittest import mock

from server import sam_mask
from server.samtext import ALPHABET, compose, mask_shape, parse
from server.tests.lossless_encoder import encode_lossless_raster

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
        payload = REAL['coffee mug'].split('data=99,110,')[1].split('|>')[0]
        self.assertEqual(r['mask'], {'encoding': 'one_bit', 'rows': 99, 'cols': 110, 'x': 0, 'y': 0, 'payload_chars': 98,
                                     'left': 560, 'top': 383, 'payload': payload})

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


class Masks(unittest.TestCase):
    """The masks are read: both markers, decoded once, placed on the picture."""

    def test_every_recorded_mask_decodes_onto_its_box(self):
        for noun, text in REAL.items():
            for r in parse(text, 1024, 768).records:
                shape = mask_shape(r, (1024, 768))
                self.assertIsNotNone(shape, noun)
                x0, y0, x1, y1 = r['box']
                bx0, by0, bx1, by1 = shape['bounds']
                self.assertTrue(x0 <= bx0 < bx1 <= x1 and y0 <= by0 < by1 <= y1, noun)
                self.assertGreater(shape['area'], 0.3 * (x1 - x0) * (y1 - y0) if noun != 'desk' else 0)

    def test_the_mug_keeps_its_handle_hole(self):
        shape = mask_shape(parse(REAL['coffee mug'], 1024, 768).records[0])
        self.assertEqual(len(shape['rings']), 2, 'an outline and the hole inside the handle')
        areas = sorted(sam_mask._signed_area(ring) for ring in shape['rings'])
        self.assertLess(areas[0], 0, 'the hole runs the other way')
        self.assertGreater(areas[1], 0)
        for ring in shape['rings']:
            for x, y in ring:
                self.assertTrue(560 <= x <= 670 and 383 <= y <= 482)

    def test_each_mask_is_decoded_once(self):
        r = parse(REAL['potted cactus'], 1024, 768).records[0]
        copy = {**r, 'box': list(r['box'])}       # a held copy shares the mask
        with mock.patch.object(sam_mask, 'decode_mask', wraps=sam_mask.decode_mask) as decode:
            first = mask_shape(r)
            self.assertIs(mask_shape(copy), first)
            self.assertIs(mask_shape(r), first)
        self.assertEqual(decode.call_count, 1)

    def test_the_offsets_place_the_mask(self):
        raster = bytes([0, 1, 1, 0,
                        1, 1, 1, 1,
                        0, 1, 1, 0])
        payload = sam_mask.encode_one_bit(raster, 4, 3)
        text = (f'<0f>0<|box;x1=10;y1=20;x2=13;y2=22;w=64;h=64;c=0.9|>'
                f'<|mask;x=2;y=1;c=0.9;data=3,4,{payload}|>')
        shape = mask_shape(parse(text, 64, 64).records[0], (64, 64))
        self.assertEqual(shape['bounds'], [12, 21, 16, 24], 'box corner plus the mask token\'s x and y')
        self.assertEqual(shape['area'], 8)
        # held to the picture: what lies past its edge is cut off
        shape = mask_shape(parse(text, 64, 64).records[0], (14, 23))
        self.assertEqual(shape['bounds'], [12, 21, 14, 23])
        self.assertEqual(shape['area'], 3)

    def test_the_lossless_marker_is_read_too(self):
        raster = bytes(int((x - 9) ** 2 + (y - 6) ** 2 < 30) for y in range(13) for x in range(19))
        payload = encode_lossless_raster(raster, 19, 13)
        self.assertEqual(payload[0], '~')
        text = compose([{'box': [100, 50, 118, 62], 'confidence': 0.9, 'payload': payload}], 640, 480)
        p = parse(text, 640, 480)
        self.assertEqual((p.errors, p.warnings), ([], []))
        r = p.records[0]
        self.assertEqual(r['mask']['encoding'], 'lossless')
        shape = mask_shape(r, (640, 480))
        self.assertEqual(shape['area'], sum(raster))
        self.assertEqual(shape['raster']['data'], raster)
        # the reference's published lossless answer reads and decodes
        published = ('<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>'
                     "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n")
        p = parse(published, 320, 334)
        self.assertEqual(p.errors, [])
        self.assertEqual(mask_shape(p.records[0])['bounds'][:2], [211, 228])

    def test_a_mask_that_does_not_decode_says_so_and_never_raises(self):
        for data in ('8,8,!!!!!abc', '8,8,abc', '8,8,~!!!!!', '2,2,!!!!!(QO(0lu8?'):
            text = f'<0f>0<|box;x1=1;y1=1;x2=8;y2=8;w=64;h=64;c=0.9|><|mask;x=0;y=0;c=0.9;data={data}|>'
            p = parse(text, 64, 64)
            self.assertEqual(len(p.records), 1, data)
            self.assertIsNone(mask_shape(p.records[0]), data)
            self.assertTrue(p.records[0]['mask']['error'], data)
        self.assertIsNone(mask_shape(parse('<0f>' + rec(0, 1, 1, 8, 8, mask=''), 64, 64).records[0]))
        self.assertIsNone(mask_shape({'mask': None}))
        self.assertIsNone(mask_shape(None))

    def test_a_tilde_is_only_a_marker(self):
        p = parse('<0f>' + rec(0, 1, 1, 8, 8, data='8,8,!!~!!abc'), 64, 64)
        self.assertEqual(p.errors, ['malformed_record'])


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
