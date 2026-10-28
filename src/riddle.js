// Ask the room: after a round, riddles about the picture, answered by
// touching a thing in it. The truth splits three ways: Muse Spark (or the
// sample's author) says which things answer a riddle, each one a thing SAM
// 3.1 found, SAM 3.1 says where they are, this code counts them, and it says
// whether the player touched them. No model ever judges the player's answer. Pure logic.
import { pointInShape, distToRings, bounds, shapeArea } from './geom.js';
import { objectWords } from './level.js';

export const MAX_RIDDLES = 3;
export const RULES = ['one', 'any', 'all'];
export const MISSES = 2;
export const TEXT_MIN = 12, TEXT_MAX = 90, WHY_MAX = 80;
// where a riddle came from: a sample room's author, Meta (live), the local
// stand-in (rehearsal), or Meta's recorded answer replayed (our kitchen)
export const RIDDLE_ORIGINS = ['sample', 'live', 'rehearsal', 'replay'];
// outlines that are only a box (or Spark's points): a tap on them is less
// sure than on a traced or painted shape
const BOXY = new Set(['box', 'points_box']);

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const COUNT_WORDS = new Set([...NUMBER_WORDS.slice(2), 'dozen', 'both']);
// Persons and bodies (server/pipeline.py PEOPLE, less the pronouns a riddle
// speaks with: you, me, him, her, them, someone): never in a riddle or its reason
const PEOPLE = new Set(['person', 'people', 'man', 'men', 'woman', 'women', 'child', 'children', 'kid', 'kids', 'boy', 'girl', 'baby',
  'human', 'face', 'head', 'hand', 'hands', 'arm', 'arms', 'leg', 'legs', 'foot', 'feet', 'finger', 'fingers',
  'body', 'hair', 'eye', 'eyes', 'mouth', 'selfie']);

const words = (s) => String(s).toLowerCase().match(/[a-z]+/g) || [];
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

// "{n}" becomes the number of the riddle's answers (each one a thing SAM
// found), as a word: "Find the three things".
export function fillCount(text, n) {
  return String(text).replace('{n}', NUMBER_WORDS[n] || String(n));
}

// Why a riddle's text may not be used, or null. The same rules as the live
// cleaner (server/riddles.py): a length, no digits, the count only as {n}
// (filled in by code, never written by a model), and no word of any
// answer's name, so the riddle never gives itself away.
export function textProblem(text, rule, answerNames) {
  const t = String(text || '');
  if (t.length < TEXT_MIN || t.length > TEXT_MAX) return `its text is ${t.length} characters long`;
  if (/\d/.test(t)) return 'it writes a digit';
  const holes = t.split('{n}').length - 1;
  if (rule === 'all') {
    if (holes !== 1) return 'it does not leave the count to the game';
    if (words(t).some((w) => COUNT_WORDS.has(w))) return 'it writes a count itself';
  } else if (holes) return 'it asks for a count but has one answer';
  const said = new Set(words(t.replace('{n}', '')).map(stem));
  for (const name of answerNames) {
    for (const w of words(name)) if (w.length >= 3 && said.has(stem(w))) return `it names its answer ("${w}")`;
  }
  return null;
}

// The riddles a level may keep, each checked against the level itself:
// every answer is a thing in it with an outline, at least one thing is not
// an answer, the rule fits the count, the text keeps the rules. Dropped
// riddles come back as warnings in words; a room always plays without them.
export function checkRiddles(level, riddles) {
  const kept = [], warnings = [];
  const byId = new Map(level.objects.map((o, k) => [o.id, k]));
  const seen = new Set();
  const sets = new Set();
  for (const raw of Array.isArray(riddles) ? riddles : []) {
    const n = kept.length + warnings.length + 1;
    const drop = (why) => warnings.push(`dropped riddle ${n}: ${why}`);
    if (!raw || typeof raw !== 'object') { drop('it is not a riddle'); continue; }
    if (!RULES.includes(raw.rule)) { drop('its rule is unknown'); continue; }
    const answers = [...new Set(Array.isArray(raw.answers) ? raw.answers.map(String) : [])];
    if (!answers.length) { drop('it has no answer'); continue; }
    if (answers.some((id) => !byId.has(id))) { drop('an answer is not a thing in this room'); continue; }
    if (answers.some((id) => { const o = level.objects[byId.get(id)]; return !o.outline || !Array.isArray(o.outline.rings) || !o.outline.rings.length; })) {
      drop('an answer has no outline'); continue;
    }
    if (answers.length >= level.objects.length) { drop('every thing answers it'); continue; }
    let rule = raw.rule;
    if (rule === 'any' && answers.length === 1) rule = 'one';
    if (rule === 'one' && answers.length !== 1) { drop('it has one answer but several things'); continue; }
    if (rule === 'all' && answers.length < 2) { drop('it asks for all but has one answer'); continue; }
    const names = answers.map((id) => level.objects[byId.get(id)].name);
    const why = textProblem(raw.text, rule, names);
    if (why) { drop(why); continue; }
    const person = words(`${raw.text} ${raw.why || ''}`).find((w) => PEOPLE.has(w));
    if (person) { drop(`it is about people ("${person}")`); continue; }
    const key = [...answers].sort().join('|');
    if (sets.has(key)) { drop('another riddle has the same answer'); continue; }
    if (kept.length >= MAX_RIDDLES) { drop(`a room keeps at most ${MAX_RIDDLES}`); continue; }
    sets.add(key);
    let id = String(raw.id || `q${kept.length + 1}`);
    if (seen.has(id)) id = `q${kept.length + 1}`;
    seen.add(id);
    const origin = RIDDLE_ORIGINS.includes(raw.origin) ? raw.origin : 'sample';
    const regions = {};
    for (const a of answers) {
      const given = raw.regions && raw.regions[a];
      regions[a] = typeof given === 'string' ? given : level.objects[byId.get(a)].outline.source;
    }
    kept.push({
      id, text: String(raw.text), rule, answers, n: answers.length,
      why: String(raw.why || '').replace(/\s+/g, ' ').trim().slice(0, WHY_MAX),
      origin, points: Array.isArray(raw.points) ? raw.points : [], regions,
      ...(raw.recorded ? { recorded: String(raw.recorded) } : {}),
    });
  }
  return { kept, warnings };
}

// A sample room's hand-written riddles, for its level (MOCK).
export function riddlesFromRoom(room, level) {
  const list = (room && Array.isArray(room.riddles) ? room.riddles : []).map((r) => ({ ...r, origin: 'sample', points: [] }));
  return checkRiddles(level, list);
}

// The picture pixels around a tap that still count as touching a thing:
// 1.2% of the long side, or 16 CSS pixels where the board is drawn small.
export function riddleSlack(level, cssPxInPicture = 0) {
  const L = Math.max(level.picture.width, level.picture.height);
  return Math.max(0.012 * L, 16 * cssPxInPicture);
}

// The thing a tap picks: one whose outline holds the point, else the
// nearest outline within the slack (a "near" pick, said aloud), else none.
// Among several holding the point: a thing standing on a flat one wins
// (a mug on a notebook), a traced shape beats a bare box, and then the
// thing nearest the camera (seen from above, the smallest).
export function pickAt(level, x, y, slack = 0) {
  const inside = [];
  level.objects.forEach((o, k) => {
    if (o.outline && Array.isArray(o.outline.rings) && pointInShape(x, y, o.outline.rings)) inside.push(k);
  });
  if (inside.length) {
    const above = level.view === 'top_down';
    const rank = (k) => {
      const o = level.objects[k];
      const depth = above ? shapeArea(o.outline.rings) : -(o.baseline_y ?? bounds(o.outline.rings).y1);
      return [o.role === 'flat' ? 1 : 0, BOXY.has(o.outline.source) ? 1 : 0, depth];
    };
    inside.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a - b;
    });
    return { k: inside[0], near: false };
  }
  let best = -1, bd = Infinity;
  level.objects.forEach((o, k) => {
    if (!o.outline || !Array.isArray(o.outline.rings)) return;
    const d = distToRings(x, y, o.outline.rings);
    if (d < bd) { bd = d; best = k; }
  });
  return best >= 0 && bd <= slack ? { k: best, near: true } : null;
}

// A pick for this riddle: as pickAt, except that an answer graded on its
// box (its outline missed the part Muse Spark pointed at) takes any tap in
// that box the outlines did not give to another answer. It errs toward the
// player, never past SAM's box.
export function pickForRiddle(level, riddle, x, y, slack = 0) {
  const p = pickAt(level, x, y, slack);
  if (p && riddle.answers.includes(level.objects[p.k].id)) return p;
  for (const id of riddle.answers) {
    if ((riddle.regions || {})[id] !== 'box') continue;
    const k = level.objects.findIndex((o) => o.id === id);
    if (k < 0) continue;
    const o = level.objects[k];
    const b = o.box ? { x0: o.box[0], y0: o.box[1], x1: o.box[2], y1: o.box[3] } : bounds(o.outline.rings);
    if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) return { k, near: false };
  }
  return p;
}

export function newRiddleState(riddle) {
  return { riddle, found: [], wrong: [], misses: 0, done: null };
}

// One pick, graded by code. 'one' and 'any': a right pick solves it. 'all':
// each answer is found once ("already found" costs nothing) until all n
// are found. A wrong pick is a miss; the same wrong thing twice counts once;
// two misses end the riddle.
export function gradePick(rs, id) {
  if (rs.done) return { kind: 'over', id };
  const r = rs.riddle;
  if (r.answers.includes(id)) {
    if (rs.found.includes(id)) return { kind: 'already', id };
    rs.found.push(id);
    if (r.rule !== 'all' || rs.found.length >= r.n) {
      rs.done = 'solved';
      return { kind: 'solved', id };
    }
    return { kind: 'found', id, count: rs.found.length };
  }
  if (rs.wrong.includes(id)) return { kind: 'again', id };
  rs.wrong.push(id);
  rs.misses++;
  if (rs.misses >= MISSES) {
    rs.done = 'missed';
    return { kind: 'missed', id };
  }
  return { kind: 'wrong', id, left: MISSES - rs.misses };
}

// "the mug" for a single thing, "coin 2" for one of several.
export function thingWords(level, k) {
  const o = level.objects[k];
  const many = level.objects.filter((x) => x.name === o.name).length > 1;
  return many ? objectWords(level, k) : `the ${o.name}`;
}

// "the mug", or "coin 1, coin 2 and coin 3".
export function answerWords(level, riddle) {
  const ks = riddle.answers.map((id) => level.objects.findIndex((o) => o.id === id)).filter((k) => k >= 0);
  const ws = ks.map((k) => thingWords(level, k));
  return ws.length > 1 ? `${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}` : ws[0] || '';
}

// Where a thing sits in the picture, in thirds: "top, left", "middle".
export function placeOf(level, k) {
  const W = level.picture.width, H = level.picture.height;
  const b = bounds(level.objects[k].outline.rings);
  const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2;
  const v = y < H / 3 ? 'top' : y > (2 * H) / 3 ? 'bottom' : 'middle';
  const h = x < W / 3 ? 'left' : x > (2 * W) / 3 ? 'right' : 'middle';
  return v === h ? 'middle' : `${v} ${h}`;
}

// The choices for "Answer with": every thing with an outline, in
// alphabetical order (the order gives nothing away), each with its place,
// so same-named things can be told apart without sight.
export function answerChoices(level) {
  return level.objects
    .map((o, k) => ({ k, id: o.id, text: `${objectWords(level, k)} · ${placeOf(level, k)}` }))
    .filter((c) => level.objects[c.k].outline && Array.isArray(level.objects[c.k].outline.rings))
    .sort((a, b) => a.text.localeCompare(b.text));
}

// The label under a riddle, honest by where it came from (and, live, by
// what its answers are graded on).
export function riddleLabel(riddle) {
  switch (riddle.origin) {
    case 'live': return `Riddle by muse-spark-1.3 · found by sam-3.1 · ${gradedOn(riddle)}`;
    case 'rehearsal': return 'REHEARSAL · riddle from the stand-in’s sample data, not Meta';
    case 'replay': return `REPLAY · Riddle by muse-spark-1.3, recorded${riddle.recorded ? ` ${riddle.recorded}` : ''} · no model was called now`;
    default: return 'Riddle written into this sample room · MOCK · no model was asked';
  }
}

function gradedOn(riddle) {
  const rs = Object.values(riddle.regions || {});
  if (rs.some((r) => BOXY.has(r))) return 'graded on SAM’s boxes';
  if (rs.length && rs.every((r) => r === 'sam_mask')) return 'graded on SAM 3.1’s own masks';
  return 'graded on outlines traced inside SAM’s boxes';
}

// The words before a riddle's reason on its card.
export function reasonPrefix(origin) {
  return { live: 'Muse Spark says: ', replay: 'Muse Spark said: ', rehearsal: 'The stand-in says: ' }[origin] || 'Written into the sample: ';
}

// A riddles line from the server is taken only for the room it belongs to
// (the reply's request id) and only when it is honest about where it came
// from: live riddles from a live server, the stand-in's from a rehearsal,
// and the recorded ones (no model called now) with our kitchen's replay.
export function acceptRiddles(line, { mode, requestId }) {
  if (!line || line.schema !== 'frameplay.riddles/1') return { ok: false, why: 'not a riddles line' };
  if (!requestId || line.request_id !== requestId) return { ok: false, why: 'it is for another photo' };
  if (line.status !== 'ok') return { ok: false, why: line.status || 'no riddles' };
  const p = line.provenance || {};
  if (mode === 'live' && p.mode !== 'live') return { ok: false, why: 'a live room takes live riddles only' };
  if (mode === 'rehearsal' && (p.mode !== 'rehearsal' || (p.models && p.models.length))) return { ok: false, why: 'a rehearsal claims no model' };
  if (mode === 'replay' && (p.mode !== 'replay' || (p.models && p.models.length) || !line.recorded)) return { ok: false, why: 'a replay calls no model and says when they were recorded' };
  if (mode !== 'live' && mode !== 'rehearsal' && mode !== 'replay') return { ok: false, why: 'riddles come only with a live, rehearsal or replayed room' };
  return { ok: true };
}

// The server's riddles, made the level's. Muse Spark's points are checked
// once more against the built outlines: an answer whose point lies off its
// outline (but near SAM's box, or the server would have dropped it) is
// graded on its box, so a riddle is never graded on less than SAM's
// evidence allows, and the label says so.
export function riddlesFromLine(line, level, origin) {
  const L = Math.max(level.picture.width, level.picture.height);
  const g = 0.015 * L;
  const byId = new Map(level.objects.map((o, k) => [o.id, k]));
  const list = (Array.isArray(line.riddles) ? line.riddles : []).map((r) => {
    const regions = {};
    for (const id of Array.isArray(r.answers) ? r.answers : []) {
      const k = byId.get(id);
      if (k === undefined) continue;
      const o = level.objects[k];
      regions[id] = o.outline.source;
      const pts = (Array.isArray(r.points) ? r.points : []).filter((p) => Array.isArray(p) && p[2] === id);
      const off = pts.length && pts.every(([x, y]) => !pointInShape(x, y, o.outline.rings) && distToRings(x, y, o.outline.rings) > g);
      if (off) regions[id] = 'box';
    }
    return { ...r, origin, regions, ...(line.recorded ? { recorded: line.recorded } : {}) };
  });
  return checkRiddles(level, list);
}
