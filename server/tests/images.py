"""Small photo files built byte by byte for the tests, carrying metadata."""
import struct
import zlib


def png(w=40, h=30, metadata=True):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\x80\x40\x20' * w for _ in range(h))
    parts = [b'\x89PNG\r\n\x1a\n', chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))]
    if metadata:
        parts += [chunk(b'tEXt', b'Comment\x00taken at home'), chunk(b'tIME', b'\x07\xea\x0a\x1a\x10\x00\x00'),
                  chunk(b'eXIf', b'MM\x00*GPS-here')]
    parts += [chunk(b'IDAT', zlib.compress(raw))]
    if metadata:
        parts += [chunk(b'iTXt', b'Author\x00\x00\x00\x00\x00someone')]
    parts += [chunk(b'IEND', b'')]
    return b''.join(parts)


def jpeg(w=64, h=48, metadata=True):
    def seg(marker, data):
        return b'\xff' + bytes([marker]) + struct.pack('>H', len(data) + 2) + data
    parts = [b'\xff\xd8', seg(0xE0, b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00')]
    if metadata:
        parts += [seg(0xE1, b'Exif\x00\x00MM\x00*GPS 51.5N 0.1W camera serial 1234'),
                  seg(0xED, b'Photoshop 3.0\x00place'), seg(0xFE, b'a comment with a name')]
    parts += [seg(0xDB, b'\x00' + bytes(range(64))),
              seg(0xC0, b'\x08' + struct.pack('>HH', h, w) + b'\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01'),
              seg(0xC4, b'\x00' + b'\x00' * 16),
              seg(0xDA, b'\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00'),
              b'\x12\x34\xff\x00\x56\xff\xd0\x78',  # scan data with a stuffed byte and a restart marker
              b'\xff\xd9']
    return b''.join(parts)


def webp(w=50, h=20, metadata=True):
    def chunk(kind, data):
        pad = b'\x00' if len(data) & 1 else b''
        return kind + struct.pack('<I', len(data)) + data + pad
    flags = 0x0C if metadata else 0
    vp8x = bytes([flags, 0, 0, 0]) + (w - 1).to_bytes(3, 'little') + (h - 1).to_bytes(3, 'little')
    bits = (w - 1) | ((h - 1) << 14)
    vp8l = b'\x2f' + bits.to_bytes(4, 'little') + b'\x00\x00\x00'
    parts = [chunk(b'VP8X', vp8x), chunk(b'VP8L', vp8l)]
    if metadata:
        parts += [chunk(b'EXIF', b'MM\x00*GPS here'), chunk(b'XMP ', b'<x:xmpmeta>who</x:xmpmeta>')]
    body = b'WEBP' + b''.join(parts)
    return b'RIFF' + struct.pack('<I', len(body)) + body
