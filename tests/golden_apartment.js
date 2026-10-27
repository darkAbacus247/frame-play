// The golden replay of The Apartment through the stand-in (not Meta): the
// pipeline's reply to the stand-in's top-down answer set, and the level the
// page builds from it on the painted picture. tests/apartment.test.js
// compares a fresh replay with server/tests/fixtures/apartment_rehearsal.json
// field for field; `node tests/golden_apartment.js --write` makes that file
// again after a deliberate change (and the diff says what changed).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRoom } from '../src/rooms.js';
import { paintRoom } from '../src/painter.js';
import { levelFromReply } from '../src/own.js';
import { jpegLike } from './jpegsim.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
export const GOLDEN = new URL('../server/tests/fixtures/apartment_rehearsal.json', import.meta.url);

// A sample room's answers from the stand-in through the real pipeline, in
// one process with no socket (server/tests/standin_replay.py).
export function standInReply(room, golden = false) {
  const out = execFileSync(PYTHON, ['-B', '-m', 'server.tests.standin_replay', '--room', room, ...(golden ? ['--golden'] : [])], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out);
}

export const apartment = () => loadRoom(JSON.parse(readFileSync(new URL('../rooms/apartment.json', import.meta.url), 'utf8')));

// What the page made of a reply, without what changes from run to run.
export function levelSummary(level) {
  return {
    view: level.view,
    floor: level.provenance.floor,
    surface: { name: level.surface.name, source: level.surface.source, rooms: level.surface.rooms, doorways: level.surface.doorways },
    objects: level.objects.map((o) => ({ id: o.id, name: o.name, instance: o.instance, role: o.role, box: o.box, outline: o.outline.source })),
    rules: level.rules,
    start: level.start,
    proof: { order: level.proof.order, route_length: level.proof.route_length },
    changes_by_code: level.changes_by_code,
  };
}

export async function replayApartment() {
  const reply = standInReply('apartment', true);
  const room = apartment();
  const W = room.width, H = room.height;
  const pixels = { width: W, height: H, data: jpegLike(paintRoom(room).rgba, W, H, 90) };
  const entry = await levelFromReply(JSON.parse(JSON.stringify(reply)), { width: W, height: H }, pixels, { kind: 'sample', id: 'apartment' }, () => Promise.resolve());
  return { reply, entry };
}

if (process.argv[2] === '--write') {
  const { reply, entry } = await replayApartment();
  if (entry.built.error) throw new Error(entry.built.error);
  writeFileSync(GOLDEN, `${JSON.stringify({ reply, level: levelSummary(entry.built.level) }, null, 1)}\n`);
  console.log(`wrote ${fileURLToPath(GOLDEN)}`);
}
