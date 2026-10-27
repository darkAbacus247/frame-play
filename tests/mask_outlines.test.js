// SAM 3.1's masks as the outlines: the page uses a decoded mask's rings as
// they are (holes kept), traces inside the box only where a mask did not
// decode or its rings are not usable, and says which in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskRings, outlinesFor } from '../src/own.js';
import { maskWords, tracedWords, SOURCE_WORDS } from '../src/screens.js';

const W = 64, H = 48;
const square = [[10, 10], [30, 10], [30, 30], [10, 30]];
const hole = [[15, 15], [15, 25], [25, 25], [25, 15]];
const decoded = (rings) => ({ name: 'mug', box: [10, 10, 30, 30], found_by: 'sam', seeds: [], mask: { decoded: true, rings, area: 300, bounds: [10, 10, 30, 30] } });

test('a decoded mask’s rings are the outline, holes and all', async () => {
  const pixels = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
  const out = await outlinesFor({ objects: [decoded([square, hole])] }, pixels, () => Promise.resolve());
  assert.deepEqual(out, [{ source: 'sam_mask', rings: [square, hole] }]);
});

test('a mask that did not decode, or rings that are not usable, fall back to tracing inside the box', async () => {
  const pixels = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
  const bad = [
    { ...decoded([square]), mask: { decoded: false } },
    decoded([]),
    decoded([[[10, 10], [30, 10]]]),
    decoded([[[10, 10], [30, 'x'], [30, 30]]]),
    decoded([[[10, 10], [300, 10], [30, 30]]]),
    { ...decoded([square]), mask: null },
  ];
  for (const o of bad) assert.equal(maskRings(o, W, H), null, JSON.stringify(o.mask));
  const out = await outlinesFor({ objects: bad }, pixels, () => Promise.resolve());
  for (const t of out) assert.ok(['traced_in_box', 'box'].includes(t.source), t.source);
  // a thing found by Muse Spark's points never takes a mask
  const pts = await outlinesFor({ objects: [{ ...decoded([square]), found_by: 'points', mask: { decoded: true, rings: [square] } }] }, pixels, () => Promise.resolve());
  assert.ok(/points/.test(pts[0].source));
});

test('the words say what the masks gave and what code traced', () => {
  const level = (c) => ({ provenance: { outline_sources: c } });
  assert.equal(maskWords(level({ sam_mask: 9, traced_in_box: 0, box: 0 })), 'SAM 3.1’s masks gave 9 exact outlines; code traced 0');
  assert.equal(maskWords(level({ sam_mask: 8, traced_in_box: 1, box: 0 })), 'SAM 3.1’s masks gave 8 exact outlines; code traced 1 inside SAM’s box');
  assert.equal(maskWords(level({ sam_mask: 1, traced_in_box: 2, box: 1 }), 'the stand-in for SAM 3.1'), 'the stand-in for SAM 3.1’s masks gave 1 exact outline; code traced 2 inside SAM’s boxes and kept 1 as a box');
  assert.equal(maskWords(level({ sam_mask: 0, traced_in_box: 9 })), '', 'no mask gave an outline: the tracing words stand alone');
  assert.equal(tracedWords(level({ traced_in_box: 9, box: 0 })), 'traced 9 outlines inside SAM’s boxes and kept 0 as boxes');
  assert.equal(SOURCE_WORDS.sam_mask, 'exact outline from SAM’s own mask');
});
