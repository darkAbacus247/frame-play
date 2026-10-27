// Our kitchen photo (rooms/kitchen.jpg) and Meta's recorded answer for it,
// replayed through the server's real pipeline (python -B -m server.replay:
// the same Pipeline as a live read, its transport the recorded answers;
// nothing is sent anywhere). Shared by tests/kitchen.test.js and the booted
// page's tests.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABELS } from '../src/level.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export const KITCHEN_JPG = new Uint8Array(readFileSync(new URL('../rooms/kitchen.jpg', import.meta.url)));
export const W = 1024, H = 399;
// Node has no JPEG decoder (and no dependency is added): a plain picture of
// the photo's size stands in for its pixels. Every outline and the floor
// come from SAM 3.1's decoded masks, which do not read the pixels.
export const KITCHEN_PIXELS = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) };

let cached = null;
// the replay's reply, as the server sends it (a fresh copy each call)
export function replayReply() {
  if (!cached) cached = execFileSync(PYTHON, ['-B', '-m', 'server.replay'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return JSON.parse(cached);
}

// The same answers as a LIVE server would send them for a fresh read of the
// photo: what Meta's models answered on 2026-10-27, in LIVE's dress (its
// mode, label and models), for the copy the page sent (width x height).
export function liveKitchenReply() {
  const r = replayReply();
  const prov = { ...r.provenance, mode: 'live', label: LABELS.live, models: ['muse-spark-1.3', 'sam-3.1'] };
  delete prov.replay;
  for (const c of prov.calls) delete c.replayed;
  return { ...r, provenance: prov };
}
