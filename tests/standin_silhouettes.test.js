import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROOMS, fileFor, fileText } from './standin_silhouettes.js';

test('the silhouettes the stand-in codes as masks are still the painter’s', () => {
  for (const id of ROOMS) {
    const kept = readFileSync(fileFor(id), 'utf8');
    assert.ok(kept === fileText(id), `${id}: run node tests/standin_silhouettes.js`);
    const data = JSON.parse(kept);
    for (const c of [...Object.values(data.objects), ...Object.values(data.surface)]) {
      if (c) assert.equal(c.runs.reduce((a, b) => a + b, 0), c.w * c.h, id);
    }
  }
});
