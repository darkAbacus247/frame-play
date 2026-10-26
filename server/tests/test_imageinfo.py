import unittest

from server.imageinfo import ImageError, check_photo, size, sniff, strip_metadata
from server.tests import images


class TypesAndSizes(unittest.TestCase):
    def test_type_comes_from_magic_bytes(self):
        self.assertEqual(sniff(images.jpeg()), 'image/jpeg')
        self.assertEqual(sniff(images.png()), 'image/png')
        self.assertEqual(sniff(images.webp()), 'image/webp')
        self.assertIsNone(sniff(b'GIF89a' + b'\x00' * 20))
        self.assertIsNone(sniff(b'<svg xmlns="http://www.w3.org/2000/svg"/>'))
        self.assertIsNone(sniff(b''))

    def test_size_from_the_header(self):
        self.assertEqual(size(images.jpeg(640, 480), 'image/jpeg'), (640, 480))
        self.assertEqual(size(images.png(123, 45), 'image/png'), (123, 45))
        self.assertEqual(size(images.webp(1000, 750), 'image/webp'), (1000, 750))

    def test_too_large_or_damaged_is_refused(self):
        with self.assertRaises(ImageError):
            check_photo(images.png(5000, 10), 4096)
        with self.assertRaises(ImageError):
            check_photo(images.jpeg()[:30], 4096)
        with self.assertRaises(ImageError):
            check_photo(b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\x0dIHDR', 4096)
        with self.assertRaises(ImageError):
            check_photo(b'not an image at all', 4096)


class Metadata(unittest.TestCase):
    def test_jpeg_app1_to_app15_and_comments_go(self):
        data = images.jpeg()
        clean, removed = strip_metadata(data, 'image/jpeg')
        self.assertGreater(removed, 40)
        self.assertEqual(len(clean), len(data) - removed)
        for word in (b'Exif', b'GPS', b'Photoshop', b'comment'):
            self.assertNotIn(word, clean)
        self.assertIn(b'JFIF', clean, 'APP0 stays')
        self.assertTrue(clean.endswith(b'\x12\x34\xff\x00\x56\xff\xd0\x78\xff\xd9'), 'the scan is copied untouched')
        self.assertEqual(size(clean, 'image/jpeg'), (64, 48))

    def test_png_text_exif_and_time_go(self):
        data = images.png()
        clean, removed = strip_metadata(data, 'image/png')
        self.assertGreater(removed, 0)
        for kind in (b'tEXt', b'iTXt', b'tIME', b'eXIf', b'GPS', b'someone'):
            self.assertNotIn(kind, clean)
        self.assertIn(b'IDAT', clean)
        self.assertEqual(size(clean, 'image/png'), (40, 30))

    def test_webp_exif_and_xmp_go_and_the_flags_follow(self):
        data = images.webp()
        clean, removed = strip_metadata(data, 'image/webp')
        self.assertGreater(removed, 0)
        self.assertNotIn(b'EXIF', clean)
        self.assertNotIn(b'XMP ', clean)
        self.assertEqual(clean[20] & 0x0C, 0, 'VP8X no longer claims EXIF or XMP')
        self.assertEqual(int.from_bytes(clean[4:8], 'little'), len(clean) - 8, 'RIFF size updated')
        self.assertEqual(size(clean, 'image/webp'), (50, 20))

    def test_a_clean_photo_loses_nothing(self):
        for make, kind in ((images.jpeg, 'image/jpeg'), (images.png, 'image/png'), (images.webp, 'image/webp')):
            data = make(metadata=False)
            clean, removed = strip_metadata(data, kind)
            self.assertEqual(removed, 0)
            self.assertEqual(clean, data)

    def test_check_photo_reports_everything(self):
        r = check_photo(images.jpeg(800, 600), 4096)
        self.assertEqual((r['type'], r['width'], r['height']), ('image/jpeg', 800, 600))
        self.assertGreater(r['metadata_bytes_removed'], 0)
        self.assertNotIn(b'GPS', r['bytes'])


if __name__ == '__main__':
    unittest.main()
