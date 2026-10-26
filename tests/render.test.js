import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRoom } from '../src/rooms.js';
import { buildLevel, inputFromRoom } from '../src/level.js';
import { drawPlan, spriteBox, fitSize } from '../src/render.js';

const room = loadRoom(JSON.parse(readFileSync(new URL('../rooms/desk.json', import.meta.url), 'utf8')));
const { level } = buildLevel(inputFromRoom(room, '2026-10-26T17:00:00Z'));
const k = (id) => level.objects.findIndex((o) => o.id === id);
const ops = (feet) => drawPlan(level, feet).map((s) => s.op);

test('a nearer object is repainted after the explorer, then the x-ray', () => {
  // feet behind the mug: above its baseline, sprite overlapping its outline
  const feet = [600, 440];
  const plan = drawPlan(level, feet);
  const names = plan.map((s) => s.op);
  const iExplorer = names.indexOf('explorer');
  const repaint = plan.findIndex((s) => s.op === 'repaint' && s.k === k('mug'));
  assert.ok(iExplorer >= 0 && repaint > iExplorer, names.join(','));
  const xray = plan.find((s) => s.op === 'xray');
  assert.ok(xray && xray.ks.includes(k('mug')));
  assert.ok(names.indexOf('xray') > repaint);
  assert.ok(names.indexOf('outlines') > names.indexOf('xray'));
});

test('a farther object, a flat object and scenery are never repainted over the explorer', () => {
  // feet in front of the mug: below its baseline
  assert.ok(!drawPlan(level, [600, 500]).some((s) => s.op === 'repaint'));
  // over the notebook (flat): nothing
  assert.ok(!drawPlan(level, [380, 470]).some((s) => s.op === 'repaint'));
  assert.ok(!drawPlan(level, [380, 470]).some((s) => s.op === 'xray'));
  // the frame on the wall never qualifies
  for (let y = 330; y < 700; y += 37) {
    assert.ok(!drawPlan(level, [820, y]).some((s) => s.op === 'repaint' && s.k === k('frame')));
  }
});

test('several nearer objects are repainted far to near; the stamp is drawn for MOCK', () => {
  const feet = [229, 355]; // behind the lamp base
  const plan = drawPlan(level, feet);
  const rep = plan.filter((s) => s.op === 'repaint').map((s) => level.objects[s.k].baseline_y);
  assert.ok(rep.length >= 1);
  for (let i = 1; i < rep.length; i++) assert.ok(rep[i] >= rep[i - 1]);
  assert.ok(plan.some((s) => s.op === 'repaint' && s.k === k('lamp')));
  assert.equal(plan[plan.length - 1].op, 'stamp');
  assert.ok(ops([512, 650]).includes('stamp'));
});

test('sprite box and fitting', () => {
  const sb = spriteBox(1024, [100, 200]);
  assert.ok(sb.y1 > 200 && sb.y0 < 200 - 50 && sb.x1 - sb.x0 > 30);
  const f = fitSize(800, 500, 1024, 768);
  assert.ok(f.cssW <= 800 && f.cssH <= 500);
  assert.ok(Math.abs(f.cssW / f.cssH - 1024 / 768) < 0.01);
});
