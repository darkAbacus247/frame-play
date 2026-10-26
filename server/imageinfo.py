"""Photo checks without decoding pixels: the type from the magic bytes, the
size from the header, and metadata stripped (JPEG APP1 to APP15 and
comments; PNG text, eXIf and tIME chunks; WEBP EXIF and XMP chunks)."""
import struct


class ImageError(Exception):
    """A photo the server will not take, with the reason in words."""


def sniff(data):
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


# ---- JPEG ----
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
_STANDALONE = {0x01, 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7}


def _jpeg_segments(data):
    """Yield (marker, start, end) for each segment before the scan data, then
    ('scan', start, len) for the rest. Raises ImageError when malformed."""
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            raise ImageError('The JPEG is damaged')
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            raise ImageError('The JPEG is damaged')
        m = data[i]
        start = i - 1
        i += 1
        if m in _STANDALONE:
            yield m, start, i
            continue
        if m == 0xD9:
            yield m, start, i
            return
        if i + 2 > n:
            raise ImageError('The JPEG is damaged')
        length = struct.unpack('>H', data[i:i + 2])[0]
        if length < 2 or i + length > n:
            raise ImageError('The JPEG is damaged')
        end = i + length
        yield m, start, end
        i = end
        if m == 0xDA:
            yield 'scan', i, n
            return
    raise ImageError('The JPEG ends early')


def _jpeg_size(data):
    for m, s, e in _jpeg_segments(data):
        if m in _SOF:
            if e - s < 9:
                raise ImageError('The JPEG is damaged')
            h, w = struct.unpack('>HH', data[s + 5:s + 9])
            return w, h
        if m == 'scan':
            break
    raise ImageError('The JPEG has no size')


def _jpeg_strip(data):
    out = [data[:2]]
    removed = 0
    for m, s, e in _jpeg_segments(data):
        if isinstance(m, int) and (0xE1 <= m <= 0xEF or m == 0xFE):
            removed += e - s
            continue
        out.append(data[s:e])
    return b''.join(out), removed


# ---- PNG ----
_PNG_DROP = {b'tEXt', b'zTXt', b'iTXt', b'eXIf', b'tIME'}


def _png_chunks(data):
    i = 8
    n = len(data)
    while i + 12 <= n:
        length = struct.unpack('>I', data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        end = i + 12 + length
        if end > n:
            raise ImageError('The PNG is damaged')
        yield kind, i, end
        i = end
        if kind == b'IEND':
            return
    raise ImageError('The PNG ends early')


def _png_size(data):
    for kind, s, e in _png_chunks(data):
        if kind != b'IHDR' or e - s < 20:
            raise ImageError('The PNG has no size')
        return struct.unpack('>II', data[s + 8:s + 16])
    raise ImageError('The PNG has no size')


def _png_strip(data):
    out = [data[:8]]
    removed = 0
    for kind, s, e in _png_chunks(data):
        if kind in _PNG_DROP:
            removed += e - s
        else:
            out.append(data[s:e])
    return b''.join(out), removed


# ---- WEBP ----
def _webp_chunks(data):
    riff = struct.unpack('<I', data[4:8])[0]
    n = min(len(data), 8 + riff)
    i = 12
    while i + 8 <= n:
        kind = data[i:i + 4]
        length = struct.unpack('<I', data[i + 4:i + 8])[0]
        end = i + 8 + length + (length & 1)
        if i + 8 + length > n:
            raise ImageError('The WEBP is damaged')
        yield kind, i, min(end, n)
        i = end


def _webp_size(data):
    for kind, s, e in _webp_chunks(data):
        body = data[s + 8:e]
        if kind == b'VP8X' and len(body) >= 10:
            w = 1 + int.from_bytes(body[4:7], 'little')
            h = 1 + int.from_bytes(body[7:10], 'little')
            return w, h
        if kind == b'VP8 ' and len(body) >= 10 and body[3:6] == b'\x9d\x01\x2a':
            w, h = struct.unpack('<HH', body[6:10])
            return w & 0x3FFF, h & 0x3FFF
        if kind == b'VP8L' and len(body) >= 5 and body[0] == 0x2F:
            b = int.from_bytes(body[1:5], 'little')
            return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
    raise ImageError('The WEBP has no size')


def _webp_strip(data):
    parts = []
    removed = 0
    for kind, s, e in _webp_chunks(data):
        if kind in (b'EXIF', b'XMP '):
            removed += e - s
            continue
        chunk = data[s:e]
        if kind == b'VP8X' and len(chunk) >= 9:
            flags = chunk[8] & ~0x0C  # the EXIF and XMP flags
            chunk = chunk[:8] + bytes([flags]) + chunk[9:]
        parts.append(chunk)
    body = b'WEBP' + b''.join(parts)
    return b'RIFF' + struct.pack('<I', len(body)) + body, removed


_SIZE = {'image/jpeg': _jpeg_size, 'image/png': _png_size, 'image/webp': _webp_size}
_STRIP = {'image/jpeg': _jpeg_strip, 'image/png': _png_strip, 'image/webp': _webp_strip}


def size(data, kind):
    try:
        return _SIZE[kind](data)
    except (struct.error, IndexError):
        raise ImageError('The photo is damaged') from None


def strip_metadata(data, kind):
    """Return (clean bytes, how many bytes of metadata were removed)."""
    try:
        return _STRIP[kind](data)
    except (struct.error, IndexError):
        raise ImageError('The photo is damaged') from None


def check_photo(data, max_side):
    """The server's checks on a received photo. Returns a dict with the type,
    the size, the clean bytes and the metadata bytes removed."""
    kind = sniff(data)
    if kind is None:
        raise ImageError('Only JPEG, PNG or WEBP photos are taken')
    w, h = size(data, kind)
    if w < 1 or h < 1:
        raise ImageError('The photo has no size')
    if max(w, h) > max_side:
        raise ImageError(f'The photo is larger than {max_side} pixels on its longest side')
    clean, removed = strip_metadata(data, kind)
    if sniff(clean) != kind or size(clean, kind) != (w, h):
        raise ImageError('The photo could not be cleaned safely')
    return {'type': kind, 'width': w, 'height': h, 'bytes': clean, 'metadata_bytes_removed': removed}
