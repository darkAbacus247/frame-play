import hashlib
import random
import re
import unittest
from pathlib import Path

from server import sam_mask
from server.sam_mask import ALPHABET, InvalidMaskError, decode_data, decode_mask, encode_one_bit, pack, unpack
from server.samtext import ALPHABET as WIRE_ALPHABET

REPO = Path(__file__).resolve().parents[2]

# The protocol notes' own record: a 5 x 5 one_bit mask.
DOC_PAYLOAD = '!!!!!(QO(0lu8?'


class Envelope(unittest.TestCase):
    def test_the_alphabet_is_the_documented_one(self):
        self.assertEqual(ALPHABET, "!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`"
                                   'abcdefghijklmnopqrstuvwxyz{')
        self.assertEqual(len(ALPHABET), 85)
        self.assertEqual(ALPHABET, WIRE_ALPHABET)    # the answer reader's check agrees

    def test_the_doc_example_unpacks_to_six_bytes(self):
        self.assertEqual(unpack(DOC_PAYLOAD[1:]), bytes.fromhex('874b2b9cf378'))

    def test_pack_and_unpack_are_inverse_for_every_tail_length(self):
        rng = random.Random(7)
        for n in range(0, 23):
            body = bytes(rng.randrange(256) for _ in range(n))
            text = pack(body)
            self.assertEqual(len(text), 5 + n // 4 * 5 + (n % 4 + 1 if n % 4 else 0))
            self.assertEqual(unpack(text), body)
        self.assertEqual(pack(bytes(4)), '!!!!&!!!!!')       # prefix 4 = '&', then 0
        self.assertEqual(pack(bytes(85 * 85))[:5], '!!#!!')  # 7225 = 1 * 85**2


class OneBit(unittest.TestCase):
    def test_the_doc_example_decodes_and_round_trips(self):
        raster = decode_mask('one_bit', DOC_PAYLOAD, 5, 5)
        self.assertEqual(len(raster), 25)
        self.assertLessEqual(set(raster), {0, 1})
        self.assertEqual(encode_one_bit(raster, 5, 5), DOC_PAYLOAD)
        self.assertEqual(decode_data('5,5,' + DOC_PAYLOAD), (raster, 5, 5))

    def test_any_raster_round_trips_through_the_encoder(self):
        rng = random.Random(11)
        for w, h in ((1, 1), (3, 7), (17, 5), (40, 30)):
            for fill in (0.0, 0.2, 0.5, 1.0):
                raster = bytes(1 if rng.random() < fill else 0 for _ in range(w * h))
                payload = encode_one_bit(raster, w, h)
                self.assertEqual(payload[0], '!')
                self.assertEqual(decode_mask('one_bit', payload, w, h), raster)

    def test_a_disc_round_trips(self):
        w, h = 64, 48
        raster = bytes(int((x - 30) ** 2 + (y - 22) ** 2 < 300) for y in range(h) for x in range(w))
        payload = encode_one_bit(raster, w, h)
        self.assertLess(len(payload), 120)      # a smooth shape codes small
        self.assertEqual(decode_mask('one_bit', payload, w, h), raster)

    def test_errors_carry_the_reference_code(self):
        with self.assertRaises(InvalidMaskError) as caught:
            decode_mask('one_bit', '!', 5, 5)
        self.assertEqual(caught.exception.code, 'invalid_mask_payload')
        self.assertIsInstance(caught.exception, ValueError)


# The reference library's README publishes one answer with two lossless masks
# (a 320 x 334 frame); both are rounded rectangles that fill their boxes.
README_ANSWER = (
    '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>'
    "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
    ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>'
    '<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n')
README_DATA = [part.split('|>')[0] for part in README_ANSWER.split('data=')[1:]]


def rows_of(raster, w):
    return [''.join('#' if v else '.' for v in raster[i:i + w]) for i in range(0, len(raster), w)]


class PublishedExamples(unittest.TestCase):
    def test_the_readme_lossless_masks_decode_to_rounded_boxes(self):
        (a, aw, ah), (b, bw, bh) = (decode_data(d) for d in README_DATA)
        self.assertEqual((aw, ah, len(a), sum(a)), (60, 27, 1620, 1539))
        self.assertEqual((bw, bh, len(b), sum(b)), (48, 27, 1296, 1236))
        ra, rb = rows_of(a, aw), rows_of(b, bw)
        self.assertEqual(ra[0], '.....' + '#' * 49 + '......')
        self.assertEqual(ra[8], '#' * 60)
        self.assertEqual(ra[-1], '.......' + '#' * 45 + '........')
        self.assertEqual(rb[0], '....' + '#' * 39 + '.....')
        self.assertEqual(rb[10], '#' * 48)
        self.assertEqual(rb[-1], '......' + '#' * 36 + '......')
        for rows in (ra, rb):                    # convex: every row one run, every column too
            self.assertTrue(all(re.fullmatch(r'\.*#+\.*', r) for r in rows))
            self.assertTrue(all(re.fullmatch(r'\.*#+\.*', ''.join(c)) for c in zip(*rows)))

    def test_lossless_accepts_trailing_bytes_as_the_notes_allow(self):
        payload = README_DATA[0].split(',')[2]
        longer = '~' + pack(unpack(payload[1:]) + b'\x00\x07')
        self.assertEqual(decode_mask('lossless', longer, 60, 27), decode_mask('lossless', payload, 60, 27))

    def test_the_doc_example_is_stable(self):
        self.assertEqual(rows_of(decode_mask('one_bit', DOC_PAYLOAD, 5, 5), 5),
                         ['#..#.', '..##.', '.....', '#.###', '#...#'])


class Rejected(unittest.TestCase):
    """Invalid payloads are refused as the reference refuses them, message for message."""

    LOSSLESS = README_DATA[0].split(',')[2]

    def refuse(self, message, encoding, payload, width=5, height=5):
        with self.assertRaises(InvalidMaskError) as caught:
            decode_mask(encoding, payload, width, height)
        self.assertEqual(str(caught.exception), message)

    def test_encoding_dimensions_and_type(self):
        self.refuse('Unsupported complete mask encoding: rle.', 'rle', DOC_PAYLOAD)
        for w, h in ((0, 5), (5, -1), (True, 5), (2.5, 5), ('5', 5), (None, 5), (2 ** 53, 1), (float('inf'), 5)):
            self.refuse('Mask dimensions must be positive safe integers.', 'one_bit', DOC_PAYLOAD, w, h)
        self.refuse('Mask dimensions produce an unsafe decoded area.', 'one_bit', DOC_PAYLOAD, 2 ** 27, 2 ** 27)
        self.refuse('Mask payload must be a string.', 'one_bit', DOC_PAYLOAD.encode())
        self.refuse('one_bit mask payloads must start with !.', 'one_bit', self.LOSSLESS)
        self.refuse('lossless mask payloads must start with ~.', 'lossless', DOC_PAYLOAD)
        self.assertEqual(decode_mask('one_bit', DOC_PAYLOAD, 5.0, 5), decode_mask('one_bit', DOC_PAYLOAD, 5, 5))

    def test_envelope(self):
        self.refuse('Mask payload is missing its length prefix.', 'one_bit', '!abc')
        self.refuse('Mask payload contains an invalid character.', 'one_bit', '!!!!}' + DOC_PAYLOAD[5:])
        self.refuse('Mask payload contains an invalid character.', 'one_bit', DOC_PAYLOAD[:-1] + 'é')
        self.refuse('Mask payload contains an invalid character.', 'one_bit', DOC_PAYLOAD[:-1] + '~')
        self.refuse('Mask payload length does not match its prefix.', 'one_bit', DOC_PAYLOAD[:-1])   # truncated
        self.refuse('Mask payload length does not match its prefix.', 'one_bit', DOC_PAYLOAD + '!')  # trailing
        self.refuse('Mask payload length does not match its prefix.', 'one_bit', DOC_PAYLOAD[:-1] + '\U0001F600')
        self.refuse('Mask payload contains an out-of-range group.', 'one_bit', '!!!!!&{{{{{')
        self.refuse('Mask payload contains an out-of-range tail.', 'one_bit', '!!!!!#{{')
        self.refuse('Mask payload is not in canonical form.', 'one_bit', '!!!!!#!#')  # same byte, other spelling

    def test_one_bit_coding(self):
        body = unpack(DOC_PAYLOAD[1:])
        self.refuse('Mask payload is missing its finalization.', 'one_bit', '!' + pack(b'\x00\x00'))
        self.refuse('Mask payload ended before decoding completed.', 'one_bit', DOC_PAYLOAD, 50, 50)
        self.refuse('Mask payload ended before decoding completed.', 'one_bit', '!' + pack(body[:-1]))
        self.refuse('Mask payload is not canonical or has invalid finalization.', 'one_bit',
                    '!' + pack(body + b'\x00'))                                       # a trailing byte
        self.refuse('Mask payload is not canonical or has invalid finalization.', 'one_bit', DOC_PAYLOAD, 4, 4)

    def test_lossless_coding(self):
        body = unpack(self.LOSSLESS[1:])
        self.refuse('Lossless mask payload is truncated.', 'lossless', '~' + pack(bytes(4)))
        self.refuse('Lossless mask payload uses an invalid predictor.', 'lossless',
                    '~' + pack(b'\x09' + body[1:]), 60, 27)
        self.refuse('Mask payload ended before decoding completed.', 'lossless', self.LOSSLESS, 60, 40)

    def test_data_values(self):
        for data in ('5,5', '5;5,' + DOC_PAYLOAD, 'x,5,' + DOC_PAYLOAD, '5,5,abc', '-5,5,' + DOC_PAYLOAD):
            with self.assertRaises(InvalidMaskError):
                decode_data(data)


class Licence(unittest.TestCase):
    """The SAM License travels with the derived file, verbatim."""

    ORIGINAL_SHA256 = '4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be'

    def test_the_license_file_is_the_original_text(self):
        # stored as plain UTF-8, byte for byte the original: no BOM, no CR
        data = (REPO / 'LICENSES' / 'SAM_LICENSE.txt').read_bytes()
        self.assertTrue(data.startswith(b'SAM License\n'))
        self.assertNotIn(b'\r', data)
        self.assertEqual(hashlib.sha256(data).hexdigest(), self.ORIGINAL_SHA256)
        data.decode('utf-8')

    def test_the_derived_file_says_so(self):
        head = Path(sam_mask.__file__).read_text(encoding='utf-8')[:600]
        self.assertIn("Meta's meta-sam-parser 0.1.0", head)
        self.assertIn('SAM License', head)
        readme = (REPO / 'README.md').read_text(encoding='utf-8')
        self.assertIn('LICENSES/SAM_LICENSE.txt', readme)


if __name__ == '__main__':
    unittest.main()
