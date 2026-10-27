import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIXTURE, fixtureText } from './desk_silhouettes.js';

test('the desk silhouettes the mask tests compare with are still the painter\'s', () => {
  const kept = readFileSync(FIXTURE, 'utf8');
  assert.ok(kept === fixtureText(), 'run: node tests/desk_silhouettes.js');
  const data = JSON.parse(kept);
  for (const o of [...data.objects, data.surface]) {
    for (const c of [o.own, o.vis]) assert.equal(c.runs.reduce((a, b) => a + b, 0), c.w * c.h, o.id);
  }
});
