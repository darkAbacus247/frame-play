import hashlib
import random
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


class Licence(unittest.TestCase):
    """The SAM License travels with the derived file, verbatim."""

    ORIGINAL_SHA256 = '4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be'

    def test_the_license_file_is_the_original_text(self):
        text = (REPO / 'LICENSES' / 'SAM_LICENSE.txt').read_bytes().decode('utf-16')
        self.assertTrue(text.startswith('SAM License\n'))
        self.assertEqual(hashlib.sha256(text.encode('utf-8')).hexdigest(), self.ORIGINAL_SHA256)

    def test_the_derived_file_says_so(self):
        head = Path(sam_mask.__file__).read_text(encoding='utf-8')[:600]
        self.assertIn("Meta's meta-sam-parser 0.1.0", head)
        self.assertIn('SAM License', head)
        readme = (REPO / 'README.md').read_text(encoding='utf-8')
        self.assertIn('LICENSES/SAM_LICENSE.txt', readme)


if __name__ == '__main__':
    unittest.main()
