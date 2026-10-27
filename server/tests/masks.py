"""Real, decodable masks for test answers: the shape inscribed in a box
(an ellipse by default), coded as sam-3.1 codes it (one_bit), so the
answers the test doubles give go through the very decoder live answers do."""
from functools import lru_cache

from server.sam_mask import encode_one_bit


def ellipse_raster(w, h):
    """The ellipse inscribed in a w x h box, by pixel centres (never empty)."""
    rx, ry = w / 2, h / 2
    return bytes(int(((x + 0.5 - rx) / rx) ** 2 + ((y + 0.5 - ry) / ry) ** 2 <= 1)
                 for y in range(h) for x in range(w))


@lru_cache(maxsize=256)
def ellipse_payload(w, h):
    return encode_one_bit(ellipse_raster(w, h), w, h)


@lru_cache(maxsize=256)
def full_payload(w, h):
    return encode_one_bit(bytes([1]) * (w * h), w, h)


def payload_for(box, shape='ellipse'):
    """The payload for an inclusive [x1, y1, x2, y2] box."""
    w, h = box[2] - box[0] + 1, box[3] - box[1] + 1
    return (full_payload if shape == 'full' else ellipse_payload)(w, h)
