import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadRoom, stampRect, paintOrder } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { fillRings } from '../src/raster.js';
import { sinCosDeg, boxesOverlap, bounds } from '../src/geom.js';

const ROOMS = ['desk', 'living'];
// sha256 of each painted room's pixels. A change here means the pictures
// changed: update deliberately, never to make a test pass.
const GOLDEN = {
  desk: '9b093b4853d37324b03acaf32ec8f805c5541878dfdaea69926fa793b6bb2274',
  living: 'fce79f85324ab8a13f4c40b7e971c9a966c6e5e5bf0ad969266591d5c3095cb4',
};

function load(id) {
  return loadRoom(JSON.parse(readFileSync(new URL(`../rooms/${id}.json`, import.meta.url), 'utf8')));
}

const painted = {};
function paintOnce(id) {
  if (!painted[id]) painted[id] = { room: load(id) };
  if (!painted[id].out) painted[id].out = paintRoom(painted[id].room);
  return painted[id];
}

test('degree sine and cosine match the platform within rounding', () => {
  for (let d = -720; d <= 720; d += 7.5) {
    const [s, c] = sinCosDeg(d);
    assert.ok(Math.abs(s - Math.sin((d * Math.PI) / 180)) < 1e-14);
    assert.ok(Math.abs(c - Math.cos((d * Math.PI) / 180)) < 1e-14);
  }
});

for (const id of ROOMS) {
  test(`${id}: the painter output is stable`, () => {
    const { room, out } = paintOnce(id);
    const again = paintRoom(load(id));
    const h1 = createHash('sha256').update(out.rgba).digest('hex');
    const h2 = createHash('sha256').update(again.rgba).digest('hex');
    assert.equal(h1, h2);
    if (GOLDEN[id]) assert.equal(h1, GOLDEN[id], 'painted pixels changed');
    assert.equal(out.rgba.length, room.width * room.height * 4);
  });

  test(`${id}: every object's owned pixels equal its outline's pixels exactly`, () => {
    const { room, out } = paintOnce(id);
    const W = room.width, H = room.height;
    const order = paintOrder(room);
    const fills = room.objects.map((o) => fillRings(o.rings, W, H));
    for (let k = 0; k < room.objects.length; k++) {
      const later = order.slice(order.indexOf(k) + 1);
      let owned = 0;
      for (let p = 0; p < W * H; p++) {
        let want = fills[k][p] === 1;
        if (want) for (const j of later) if (fills[j][p]) { want = false; break; }
        assert.equal(out.owner[p] === k, want, `${room.objects[k].id} at pixel ${p % W},${Math.floor(p / W)}`);
        if (want) owned++;
      }
      assert.ok(owned > 20, `${room.objects[k].id} owns too few pixels`);
    }
  });

  test(`${id}: outlines sit on the objects as painted, at sub-pixel level`, () => {
    const { room, out } = paintOnce(id);
    const W = room.width, H = room.height, SW = W * 2;
    let interior = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = 2 * y * SW + 2 * x;
        const o = [out.owner2[s], out.owner2[s + 1], out.owner2[s + SW], out.owner2[s + SW + 1]];
        const p = y * W + x;
        if (o[0] === o[1] && o[1] === o[2] && o[2] === o[3]) {
          // a pixel the painter covered with one object (or none) entirely:
          // the outline must agree with it
          assert.equal(out.owner[p], o[0], `pixel ${x},${y}`);
          if (o[0] >= 0) interior++;
        } else {
          // an anti-aliased edge pixel: its owner must be one of the painted ones
          assert.ok(o.includes(out.owner[p]), `edge pixel ${x},${y}`);
        }
      }
    }
    assert.ok(interior > 1000);
  });

  test(`${id}: the MOCK stamp sits clear of every outline`, () => {
    const { room } = paintOnce(id);
    const s = stampRect(room);
    assert.ok(s, 'no clear corner for the stamp');
    const box = { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
    assert.ok(box.x0 >= 0 && box.y0 >= 0 && box.x1 <= room.width && box.y1 <= room.height);
    for (const o of room.objects) assert.ok(!boxesOverlap(box, bounds(o.rings)), `stamp touches ${o.id}`);
  });
}
