# Derived from Meta's meta-sam-parser 0.1.0 (the lossless mask format of its
# mask codec), Copyright (c) Meta Platforms, Inc. and affiliates. All Rights
# Reserved.
#
# This file is distributed under the SAM License (LICENSES/SAM_LICENSE.txt),
# not under the MIT license that covers the rest of this repository.
"""For tests only: a lossless ('~') mask encoder, the mirror image of
server/sam_mask.py's decoder (the reference ships no lossless encoder). Each
pixel's coverage is predicted from its decoded neighbours, the residual is
zigzagged, and the zero flag and the value are range coded with the very
models the decoder keeps, so decode(encode(x)) == x is the proof."""
from array import array

from server import sam_mask as m


def _zigzag(value, prediction):
    delta = ((value - prediction + 128) & 0xFF) - 128
    return 2 * delta if delta >= 0 else -2 * delta - 1


def encode_lossless(coverage, width, height, selector=4):
    """Coverage bytes (0..255, row major) -> a '~' payload."""
    enc = m.RangeEncoder()
    length = width * height
    out = bytearray(length)
    residuals = bytearray(length)
    zero_counts = array('I', [1]) * 32
    order_zero = array('H', [m._ORDER_ZERO_INITIAL]) * m._SYMBOLS
    order_zero_total = m._SYMBOLS * m._ORDER_ZERO_INITIAL
    order_one = array('H', [m._ORDER_ONE_INITIAL]) * (m._SYMBOLS * m._SYMBOLS)
    order_one_totals = array('i', [m._SYMBOLS * m._ORDER_ONE_INITIAL]) * m._SYMBOLS
    order_two = {}
    previous = 0
    for at in range(length):
        x, y = at % width, at // width
        prediction = m._predict(out, at, x, y, selector, width)
        symbol = _zigzag(coverage[at], prediction)
        bit = int(symbol != 0)
        slot = m._zero_context(residuals, at, x, y, width) << 1
        zero, nonzero = zero_counts[slot], zero_counts[slot + 1]
        if bit == 0:
            enc.encode(0, zero, zero + nonzero)
        else:
            enc.encode(zero, nonzero, zero + nonzero)
        zero_counts[slot + bit] = (zero_counts[slot + bit] + m._ZERO_INCREMENT) & m._U32
        if zero_counts[slot] + zero_counts[slot + 1] >= m._ZERO_LIMIT:
            zero_counts[slot] = zero_counts[slot] >> 1 or 1
            zero_counts[slot + 1] = zero_counts[slot + 1] >> 1 or 1
        if bit:
            above = residuals[at - width] if at >= width else 0
            key = previous << 8 | above
            second = order_two.get(key)
            if second is None:
                second = order_two[key] = array('H', [0]) * (m._SYMBOLS + 1)
            first = previous << 8
            total = (second[m._TOTAL] + order_one_totals[previous] + order_zero_total
                     - (second[0] + order_one[first] + order_zero[0]))
            cumulative = sum(second[s] + order_one[first + s] + order_zero[s] for s in range(1, symbol))
            frequency = second[symbol] + order_one[first + symbol] + order_zero[symbol]
            enc.encode(cumulative, frequency, total)
            second[symbol] = (second[symbol] + m._ORDER_TWO_STEP) & m._U16
            second[m._TOTAL] = (second[m._TOTAL] + m._ORDER_TWO_STEP) & m._U16
            if second[m._TOTAL] >= m._ORDER_TWO_LIMIT:
                scaled_total = 0
                for s in range(m._SYMBOLS):
                    second[s] >>= 1
                    scaled_total += second[s]
                second[m._TOTAL] = scaled_total & m._U16
            order_one[first + symbol] = (order_one[first + symbol] + m._ORDER_ONE_INCREMENT) & m._U16
            order_one_totals[previous] = m._i32(order_one_totals[previous] + m._ORDER_ONE_INCREMENT)
            if order_one_totals[previous] >= m._ORDER_ONE_LIMIT:
                scaled_total = 0
                for s in range(m._SYMBOLS):
                    order_one[first + s] = order_one[first + s] >> 1 or 1
                    scaled_total += order_one[first + s]
                order_one_totals[previous] = m._i32(scaled_total)
            order_zero[symbol] = (order_zero[symbol] + m._ORDER_ZERO_STEP) & m._U16
            order_zero_total += m._ORDER_ZERO_STEP
            if order_zero_total >= m._ORDER_ZERO_LIMIT:
                scaled_total = 0
                for s in range(m._SYMBOLS):
                    order_zero[s] >>= 1
                    scaled_total += order_zero[s]
                order_zero_total = scaled_total
        residuals[at] = symbol
        out[at] = coverage[at]
        previous = symbol
    return '~' + m.pack(bytes([selector]) + enc.finish())


def encode_lossless_raster(raster, width, height, selector=4):
    """A 0/1 raster as a lossless payload (inside 255, outside 0)."""
    return encode_lossless(bytes(255 if v else 0 for v in raster), width, height, selector)
