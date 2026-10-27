# Derived from Meta's meta-sam-parser 0.1.0 (the mask codec,
# _mask_codec.py / mask-codec.js), Copyright (c) Meta Platforms, Inc. and
# affiliates. All Rights Reserved.
#
# This file is distributed under the SAM License (LICENSES/SAM_LICENSE.txt),
# not under the MIT license that covers the rest of this repository. It was
# written for this repository from a reading of the reference library; no
# code from the library is imported or run.
"""SAM 3.1 mask payloads: the strict decoder for one_bit and lossless masks.

A SAM answer carries each match's mask as `data=ROWS,COLS,PAYLOAD`, where
ROWS x COLS is the raster's own size (the box's inclusive height and width)
and PAYLOAD is opaque text:

- The first character is the encoding marker: '!' one_bit, '~' lossless.
- The rest is base85 in an alphabet of its own: the printable characters
  '!' to '{' in ASCII order, minus the seven the wire grammar uses as
  delimiters (" \\ , ; < > |). So '!' is digit 0 as well as the one_bit
  marker, and short masks begin '!!!!!'.
- Five digits give the byte count of the body, most significant first.
- The body follows, four bytes to five digits as big-endian 32-bit groups.
  A last group of n bytes is written with n + 1 digits; reading it, the
  missing digits count as the top digit (84).
- one_bit: the body is a binary range code. Each pixel, in row-major order,
  is one bit coded with an adaptive count pair chosen by a 12-pixel context
  (two pixels to the left, five above, five two rows above).
- lossless: the first body byte picks a spatial predictor; the rest is a
  range code of per-pixel coverage residuals (a zero flag, then a mixed
  order-0/1/2 model for the value). Coverage 129 and up is inside.

Checks, as strict as the reference's: a supported encoding and marker,
positive safe dimensions, a prefix, a length that matches it, digits in the
alphabet, groups below 2**32, the canonical packed spelling, enough bytes
to finish decoding, and, for one_bit, a canonical round trip (re-encoding
the raster must give back the very same payload). Anything else raises
InvalidMaskError; its messages are the reference's.

decode_mask(encoding, payload, width, height) -> bytes of 0 and 1, row major.
"""
from __future__ import annotations

import math
from array import array

# --- errors ------------------------------------------------------------------


class InvalidMaskError(ValueError):
    """A complete mask payload that does not decode (code invalid_mask_payload)."""

    code = 'invalid_mask_payload'

    def __init__(self, message, cause=None):
        super().__init__(message)
        self.cause = cause
        if cause is not None:
            self.__cause__ = cause


# --- constants -----------------------------------------------------------------

_DELIMITERS = frozenset('"\\,;<>|')
# '!' .. '{'; '}' and '~' are never digits ('~' is only the lossless marker).
ALPHABET = ''.join(ch for ch in map(chr, range(0x21, 0x7C)) if ch not in _DELIMITERS)
RADIX = 85
PREFIX_LENGTH = 5
_DIGIT_VALUE = [-1] * 128
for _i, _ch in enumerate(ALPHABET):
    _DIGIT_VALUE[ord(_ch)] = _i
assert len(ALPHABET) == RADIX

MAX_SAFE_INTEGER = (1 << 53) - 1     # the reference's limit (JavaScript's)

_U8, _U16, _U32 = 0xFF, 0xFFFF, 0xFFFFFFFF
_TOP = 1 << 24                        # range coder: renormalize below this
_BOTTOM = 1 << 16                     # range coder: never let range drop below

# one_bit model
_CONTEXTS = 1 << 12
_PADDING = 2
_INCREMENT = 14
_COUNT_LIMIT = 4096

# lossless model
_SYMBOLS = 256
_TOTAL = _SYMBOLS                     # index of the running total in an order-2 table
_PREDICTORS = 5
_ZERO_INCREMENT, _ZERO_LIMIT = 32, 16384
_ORDER_ONE_INITIAL, _ORDER_ONE_INCREMENT, _ORDER_ONE_LIMIT = 1, 56, 8192
_ORDER_TWO_STEP, _ORDER_TWO_LIMIT = 14 * 44, 14 * 3584
_ORDER_ZERO_INITIAL, _ORDER_ZERO_STEP, _ORDER_ZERO_LIMIT = 2, 2 * 16, 2 * 2048

LOSSLESS_INSIDE = 129                 # coverage at or above this is inside


def _i32(value):
    value &= _U32
    return value - (1 << 32) if value >= 1 << 31 else value


def _safe_integer(value):
    """An int (or an integral float) within the safe range, else None. Not bool."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        value = int(value)
    if isinstance(value, int) and abs(value) <= MAX_SAFE_INTEGER:
        return value
    return None


def _js_length(text):
    # The reference counts UTF-16 code units, so a character beyond the BMP is 2.
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


# --- the base85 envelope --------------------------------------------------------


def _digit(ch):
    code = ord(ch)
    value = _DIGIT_VALUE[code] if code < 128 else -1
    if value < 0:
        raise InvalidMaskError('Mask payload contains an invalid character.')
    return value


def _digits_of(value):
    """Five base85 digits of a 32-bit value, most significant first."""
    out = [0] * 5
    for i in range(4, -1, -1):
        value, out[i] = divmod(value, RADIX)
    return out


def pack(body):
    """Bytes -> base85 text (the length prefix and the groups, no marker)."""
    length = len(body)
    prefix = []
    rest = length
    for _ in range(PREFIX_LENGTH):
        rest, d = divmod(rest, RADIX)
        prefix.append(ALPHABET[d])
    if rest:
        raise InvalidMaskError('Mask payload is too large.')
    out = prefix[::-1]
    full = length - length % 4
    for at in range(0, full, 4):
        value = int.from_bytes(bytes(body[at:at + 4]), 'big')
        out.extend(ALPHABET[d] for d in _digits_of(value))
    tail = length - full
    if tail:
        value = int.from_bytes(bytes(body[full:]) + bytes(4 - tail), 'big')
        out.extend(ALPHABET[d] for d in _digits_of(value)[:tail + 1])
    return ''.join(out)


def unpack(text):
    """Base85 text (no marker) -> bytes, checked strictly against its prefix."""
    text_length = _js_length(text)
    if text_length < PREFIX_LENGTH:
        raise InvalidMaskError('Mask payload is missing its length prefix.')
    length = 0
    for ch in text[:PREFIX_LENGTH]:
        length = length * RADIX + _digit(ch)
    if length > MAX_SAFE_INTEGER:
        raise InvalidMaskError('Mask payload length is unsupported.')
    tail = length % 4
    expected = PREFIX_LENGTH + (length // 4) * 5 + (tail + 1 if tail else 0)
    if text_length != expected:
        raise InvalidMaskError('Mask payload length does not match its prefix.')

    body = bytearray(length)
    src = PREFIX_LENGTH
    for at in range(0, length - tail, 4):
        value = 0
        for ch in text[src:src + 5]:
            value = value * RADIX + _digit(ch)
        if value > _U32:
            raise InvalidMaskError('Mask payload contains an out-of-range group.')
        body[at:at + 4] = value.to_bytes(4, 'big')
        src += 5
    if tail:
        value = 0
        for i in range(5):
            value = value * RADIX + (_digit(text[src + i]) if i <= tail else RADIX - 1)
        if value > _U32:
            raise InvalidMaskError('Mask payload contains an out-of-range tail.')
        body[length - tail:] = value.to_bytes(4, 'big')[:tail]

    # One spelling per body: a tail written with other low digits is refused.
    if pack(body) != text:
        raise InvalidMaskError('Mask payload is not in canonical form.')
    return bytes(body)


# --- the range coder -------------------------------------------------------------
# A carry-less range coder (Subbotin's): 32-bit low and range; a byte goes out
# whenever the top byte of low is settled, or range has fallen below 2**16
# (then range is cut to what is left before the next 2**16 boundary).


class RangeEncoder:
    def __init__(self):
        self.low = 0
        self.range = _U32
        self.out = bytearray()

    def encode(self, cumulative, frequency, total):
        scaled = self.range // total
        self.low = (self.low + scaled * cumulative) & _U32
        self.range = scaled * frequency
        self._normalize()

    def _normalize(self):
        while True:
            if (self.low ^ ((self.low + self.range) & _U32)) < _TOP:
                pass
            elif self.range < _BOTTOM:
                self.range = (-self.low) & _U32 & (_BOTTOM - 1)
            else:
                return
            self.out.append(self.low >> 24)
            self.low = (self.low << 8) & _U32
            self.range = (self.range << 8) & _U32

    def finish(self):
        for _ in range(4):
            self.out.append(self.low >> 24)
            self.low = (self.low << 8) & _U32
        return bytes(self.out)


class RangeDecoder:
    def __init__(self, data):
        if len(data) < 4:
            raise InvalidMaskError('Mask payload is missing its finalization.')
        self.data = data
        self.at = 0
        self.low = 0
        self.range = _U32
        self.scaled = 0
        self.code = 0
        for _ in range(4):
            self.code = ((self.code << 8) | self._byte()) & _U32

    def _byte(self):
        if self.at >= len(self.data):
            raise InvalidMaskError('Mask payload ended before decoding completed.')
        value = self.data[self.at]
        self.at += 1
        return value

    def frequency(self, total):
        """Where the code falls on a 0..total-1 scale; call decode() next."""
        self.scaled = self.range // total
        if self.scaled == 0:
            raise InvalidMaskError('Mask payload has invalid coding state.')
        value = ((self.code - self.low) & _U32) // self.scaled
        return total - 1 if value >= total else value

    def decode(self, cumulative, frequency):
        self.low = (self.low + self.scaled * cumulative) & _U32
        self.range = self.scaled * frequency
        while True:
            if (self.low ^ ((self.low + self.range) & _U32)) < _TOP:
                pass
            elif self.range < _BOTTOM:
                self.range = (-self.low) & _U32 & (_BOTTOM - 1)
            else:
                return
            self.code = ((self.code << 8) | self._byte()) & _U32
            self.low = (self.low << 8) & _U32
            self.range = (self.range << 8) & _U32


# --- one_bit ---------------------------------------------------------------------
# The raster sits in a padded frame (two zero columns each side, two zero rows
# above) so every pixel has a full context:
#
#     row y-2:  b7 b8 b9 b10 b11        (x-2 .. x+2)
#     row y-1:  b2 b3 b4 b5  b6         (x-2 .. x+2)
#     row y:          b1 b0  ?          (x-2, x-1)


def _context(p, at, w):
    up = at - w
    up2 = at - 2 * w
    return (p[at - 1] | p[at - 2] << 1
            | p[up - 2] << 2 | p[up - 1] << 3 | p[up] << 4 | p[up + 1] << 5 | p[up + 2] << 6
            | p[up2 - 2] << 7 | p[up2 - 1] << 8 | p[up2] << 9 | p[up2 + 1] << 10 | p[up2 + 2] << 11)


def _count(counts, slot, bit):
    """Count one observation of bit; halve the pair (never to 0) when it is full."""
    counts[slot + bit] = (counts[slot + bit] + _INCREMENT) & _U16
    if counts[slot] + counts[slot + 1] >= _COUNT_LIMIT:
        counts[slot] = counts[slot] >> 1 or 1
        counts[slot + 1] = counts[slot + 1] >> 1 or 1


def encode_one_bit(raster, width, height):
    """A binary raster -> its canonical one_bit payload (with the '!' marker)."""
    encoder = RangeEncoder()
    counts = array('H', [1]) * (_CONTEXTS * 2)
    pw = width + 2 * _PADDING
    padded = bytearray(pw * (height + _PADDING))
    for y in range(height):
        row = (y + _PADDING) * pw + _PADDING
        for x in range(width):
            at = row + x
            slot = _context(padded, at, pw) << 1
            zero, one = counts[slot], counts[slot + 1]
            bit = raster[y * width + x]
            if bit == 0:
                encoder.encode(0, zero, zero + one)
            elif bit == 1:
                encoder.encode(zero, one, zero + one)
            else:
                raise InvalidMaskError('Decoded mask is not binary.')
            padded[at] = bit
            _count(counts, slot, bit)
    return '!' + pack(encoder.finish())


def _decode_one_bit(payload, width, height):
    decoder = RangeDecoder(unpack(payload[1:]))
    counts = array('H', [1]) * (_CONTEXTS * 2)
    pw = width + 2 * _PADDING
    padded = bytearray(pw * (height + _PADDING))
    out = bytearray(width * height)
    for y in range(height):
        row = (y + _PADDING) * pw + _PADDING
        for x in range(width):
            at = row + x
            slot = _context(padded, at, pw) << 1
            zero, one = counts[slot], counts[slot + 1]
            if decoder.frequency(zero + one) < zero:
                bit = 0
                decoder.decode(0, zero)
            else:
                bit = 1
                decoder.decode(zero, one)
            padded[at] = bit
            out[y * width + x] = bit
            _count(counts, slot, bit)
    return bytes(out)


# --- lossless ----------------------------------------------------------------------


def _paeth(left, up, upper_left):
    estimate = left + up - upper_left
    dl, du, dul = abs(estimate - left), abs(estimate - up), abs(estimate - upper_left)
    if dl <= du and dl <= dul:
        return left
    return up if du <= dul else upper_left


def _predict(out, at, x, y, mode, width):
    """The predicted coverage at (x, y) from decoded neighbours; mode is the selector."""
    if not 0 <= mode < _PREDICTORS:
        raise InvalidMaskError('Lossless mask payload uses an invalid predictor.')
    left = out[at - 1] if x > 0 else 0
    up = out[at - width] if y > 0 else 0
    if mode == 1:
        return up
    if mode == 2:
        return left
    if mode == 3:
        return (left + up) >> 1
    upper_left = out[at - width - 1] if x > 0 and y > 0 else 0
    if mode == 0:
        return _paeth(left, up, upper_left)
    # mode 4: the median edge detector (LOCO-I)
    if upper_left >= max(left, up):
        return min(left, up)
    if upper_left <= min(left, up):
        return max(left, up)
    return left + up - upper_left


def _unzigzag(symbol, prediction):
    delta = -((symbol + 1) >> 1) if symbol & 1 else symbol >> 1
    return (prediction + delta) & _U8


def _zero_context(residuals, at, x, y, width):
    """Which of left, up, upper-left, upper-right had a zero residual (1 off the edge)."""
    left = residuals[at - 1] == 0 if x > 0 else 1
    up = residuals[at - width] == 0 if y > 0 else 1
    upper_left = residuals[at - width - 1] == 0 if x > 0 and y > 0 else 1
    upper_right = residuals[at - width + 1] == 0 if y > 0 and x < width - 1 else 1
    return int(left) | int(up) << 1 | int(upper_left) << 2 | int(upper_right) << 3


def _decode_lossless(payload, width, height):
    """The coverage bytes (0..255) of a lossless payload, row major."""
    if not payload.startswith('~'):
        raise InvalidMaskError('lossless mask payloads must start with ~.')
    body = unpack(payload[1:])
    if len(body) < 5:
        raise InvalidMaskError('Lossless mask payload is truncated.')
    selector = body[0]
    decoder = RangeDecoder(body[1:])
    length = width * height
    out = bytearray(length)
    residuals = bytearray(length)

    zero_counts = array('I', [1]) * 32                  # 16 contexts x (zero, nonzero)
    order_zero = array('H', [_ORDER_ZERO_INITIAL]) * _SYMBOLS
    order_zero_total = _SYMBOLS * _ORDER_ZERO_INITIAL
    order_one = array('H', [_ORDER_ONE_INITIAL]) * (_SYMBOLS * _SYMBOLS)   # by previous residual
    order_one_totals = array('i', [_SYMBOLS * _ORDER_ONE_INITIAL]) * _SYMBOLS
    order_two = {}                                      # by (previous, above) residuals
    previous = 0

    for at in range(length):
        x, y = at % width, at // width

        # Is the residual zero?
        slot = _zero_context(residuals, at, x, y, width) << 1
        zero, nonzero = zero_counts[slot], zero_counts[slot + 1]
        bit = 0 if decoder.frequency(zero + nonzero) < zero else 1
        if bit == 0:
            decoder.decode(0, zero)
        else:
            decoder.decode(zero, nonzero)
        zero_counts[slot + bit] = (zero_counts[slot + bit] + _ZERO_INCREMENT) & _U32
        if zero_counts[slot] + zero_counts[slot + 1] >= _ZERO_LIMIT:
            zero_counts[slot] = zero_counts[slot] >> 1 or 1
            zero_counts[slot + 1] = zero_counts[slot + 1] >> 1 or 1

        # If not, which value (1..255): the three orders' counts summed, symbol 0 left out.
        symbol = 0
        if bit:
            above = residuals[at - width] if at >= width else 0
            key = previous << 8 | above
            second = order_two.get(key)
            if second is None:
                second = order_two[key] = array('H', [0]) * (_SYMBOLS + 1)
            first = previous << 8
            total = (second[_TOTAL] + order_one_totals[previous] + order_zero_total
                     - (second[0] + order_one[first] + order_zero[0]))
            target = decoder.frequency(total)
            cumulative = 0
            symbol = 1
            frequency = second[1] + order_one[first + 1] + order_zero[1]
            while cumulative + frequency <= target:
                cumulative += frequency
                symbol += 1
                if symbol >= _SYMBOLS:
                    raise InvalidMaskError('Lossless mask payload is malformed.')
                frequency = second[symbol] + order_one[first + symbol] + order_zero[symbol]
            decoder.decode(cumulative, frequency)

            second[symbol] = (second[symbol] + _ORDER_TWO_STEP) & _U16
            second[_TOTAL] = (second[_TOTAL] + _ORDER_TWO_STEP) & _U16
            if second[_TOTAL] >= _ORDER_TWO_LIMIT:
                scaled_total = 0
                for s in range(_SYMBOLS):
                    second[s] >>= 1
                    scaled_total += second[s]
                second[_TOTAL] = scaled_total & _U16

            order_one[first + symbol] = (order_one[first + symbol] + _ORDER_ONE_INCREMENT) & _U16
            order_one_totals[previous] = _i32(order_one_totals[previous] + _ORDER_ONE_INCREMENT)
            if order_one_totals[previous] >= _ORDER_ONE_LIMIT:
                scaled_total = 0
                for s in range(_SYMBOLS):
                    order_one[first + s] = order_one[first + s] >> 1 or 1
                    scaled_total += order_one[first + s]
                order_one_totals[previous] = _i32(scaled_total)

            order_zero[symbol] = (order_zero[symbol] + _ORDER_ZERO_STEP) & _U16
            order_zero_total += _ORDER_ZERO_STEP
            if order_zero_total >= _ORDER_ZERO_LIMIT:
                scaled_total = 0
                for s in range(_SYMBOLS):
                    order_zero[s] >>= 1
                    scaled_total += order_zero[s]
                order_zero_total = scaled_total

        residuals[at] = symbol
        out[at] = _unzigzag(symbol, _predict(out, at, x, y, selector, width))
        previous = symbol
    return bytes(out)


# --- the entry point -----------------------------------------------------------------


def decode_mask(encoding, payload, width, height):
    """Strictly decode one complete mask to width * height bytes of 0 and 1.

    encoding is 'one_bit' or 'lossless'; payload is the text after
    'ROWS,COLS,' including its marker; width = COLS, height = ROWS.
    """
    if encoding not in ('one_bit', 'lossless'):
        raise InvalidMaskError(f'Unsupported complete mask encoding: {encoding}.')
    width = _safe_integer(width)
    height = _safe_integer(height)
    if width is None or height is None or width <= 0 or height <= 0:
        raise InvalidMaskError('Mask dimensions must be positive safe integers.')
    if width * height > MAX_SAFE_INTEGER:
        raise InvalidMaskError('Mask dimensions produce an unsafe decoded area.')
    if not isinstance(payload, str):
        raise InvalidMaskError('Mask payload must be a string.')
    if encoding == 'one_bit' and not payload.startswith('!'):
        raise InvalidMaskError('one_bit mask payloads must start with !.')
    if encoding == 'lossless' and not payload.startswith('~'):
        raise InvalidMaskError('lossless mask payloads must start with ~.')
    try:
        if encoding == 'lossless':
            coverage = _decode_lossless(payload, width, height)
            return bytes(value >= LOSSLESS_INSIDE for value in coverage)
        raster = _decode_one_bit(payload, width, height)
        if encode_one_bit(raster, width, height) != payload:
            raise InvalidMaskError('Mask payload is not canonical or has invalid finalization.')
        return raster
    except (InvalidMaskError, MemoryError):
        raise
    except Exception as error:   # anything else the bytes provoke is a bad payload too
        raise InvalidMaskError('Mask payload could not be decoded.', error) from error


def encoding_of(payload):
    """The encoding a payload's marker selects (as the reference reads it)."""
    return 'lossless' if isinstance(payload, str) and payload.startswith('~') else 'one_bit'


def decode_data(data):
    """The mask token's data value 'ROWS,COLS,PAYLOAD' -> (raster, width, height)."""
    rows, sep1, rest = data.partition(',')
    cols, sep2, payload = rest.partition(',')
    if not (sep1 and sep2 and rows.isascii() and rows.isdigit() and cols.isascii() and cols.isdigit()
            and payload[:1] in ('!', '~')):
        raise InvalidMaskError('Mask data must be ROWS,COLS,PAYLOAD.')
    width, height = int(cols), int(rows)
    return decode_mask(encoding_of(payload), payload, width, height), width, height
