// The reveal's and the closing card's sentence count what Muse Spark named
// as kinds of thing, and say how many things the room holds when it holds
// more than that: "Muse Spark named 8 kinds of thing (12 things) and gave
// each a role. SAM 3.1 found 11; ..." read "named 8, found 11" on the judge
// walk of 11-01. With as many things as kinds the sentence is as it was, and
// so it is when fewer things were found than kinds named (our kitchen: 8
// named, 5 found): "8 kinds of thing (5 things)" would contradict itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryLine, aiLine } from '../src/screens.js';

// a LIVE read of n things, every outline traced inside SAM's box
const level = (n) => ({
  origin: 'live', title: 'A room', objects: Array.from({ length: n }, (_, k) => ({ id: `o${k}` })),
  provenance: { outline_sources: { traced_in_box: n } },
});
const REST = 'Code traced 12 outlines inside SAM’s boxes and kept 0 as boxes, then proved the room can be won.';

test('more things than kinds: the kinds, then the things in brackets', () => {
  assert.equal(summaryLine(level(12), { named: 8 }),
    `Muse Spark named 8 kinds of thing (12 things) and gave each a role. SAM 3.1 found 12 of them. ${REST}`);
  assert.equal(aiLine(level(12), { named: 8 }),
    'Muse Spark named 8 kinds of thing (12 things) in your photo and gave each a role, SAM 3.1 found 12 of them, and code traced 12 outlines inside SAM’s boxes and kept 0 as boxes, then proved the room can be won.');
  assert.match(summaryLine(level(3), { named: 1 }), /^Muse Spark named 1 kind of thing \(3 things\) and gave each a role\. /, 'one kind');
});

test('as many things as kinds: the sentence as it was', () => {
  assert.equal(summaryLine(level(12), { named: 12 }), `Muse Spark named 12 things and gave each a role. SAM 3.1 found 12 of them. ${REST}`);
  assert.match(aiLine(level(12), { named: 12 }), /^Muse Spark named 12 things in your photo and gave each a role, SAM 3\.1 found 12 of them, /);
  assert.match(summaryLine(level(1), { named: 1 }), /^Muse Spark named 1 thing and gave each a role\. SAM 3\.1 found 1 of them\. /);
});

test('fewer things than kinds (some kinds not found): the sentence as it was', () => {
  const five = { ...level(5), provenance: { outline_sources: { traced_in_box: 5 } } };
  assert.match(summaryLine(five, { named: 8 }), /^Muse Spark named 8 things and gave each a role\. SAM 3\.1 found 5 of them\. /);
  assert.match(aiLine(five, { named: 8 }), /^Muse Spark named 8 things in your photo and gave each a role, SAM 3\.1 found 5 of them, /);
  assert.doesNotMatch(summaryLine(five, { named: 8 }), /kinds of thing/);
});
