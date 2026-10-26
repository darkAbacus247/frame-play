// A plain PNG writer and reader for tests: 8-bit RGBA, no interlace. The
// reader takes every filter, so it reads what the writer makes and more.
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePNG(rgba, width, height) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 6; // RGBA
  const raw = Buffer.alloc((4 * width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (4 * width + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + 4 * width * y, 4 * width).copy(raw, y * (4 * width + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePNG(bytes) {
  const b = Buffer.from(bytes);
  if (!b.subarray(0, 8).equals(Buffer.from(SIG))) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('only 8-bit RGBA, not interlaced');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 4 * width;
  const out = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? out[(y - 1) * stride + x - 4] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = up;
      else if (f === 3) p = (a + up) >> 1;
      else if (f === 4) {
        const e = a + up - c, pa = Math.abs(e - a), pb = Math.abs(e - up), pc = Math.abs(e - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = (v + p) & 255;
    }
  }
  return { width, height, data: out };
}
