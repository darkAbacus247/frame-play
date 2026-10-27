// A small floor plan seen from above, for the floor and wall tests: three
// rooms (wood, tile, carpet) inside dark walls; the wood room opens to the
// tile room, the tile room to the carpet room, and the wood room and the
// carpet room share a wall with no doorway in it. Painted by the room
// painter, like the sample rooms.
export const PLAN_ROOMS = { wood: [34, 34, 280, 200], tile: [328, 34, 258, 200], carpet: [34, 248, 552, 178] };
export const PLAN_DOORS = { woodTile: [314, 100, 14, 50], tileCarpet: [420, 234, 50, 14] };

const rect = (x, y, w, h) => ({ rect: [x, y, w, h] });

// doors: which doorways are open (both, unless said)
export function planJson(objects = [], doors = Object.keys(PLAN_DOORS)) {
  const R = PLAN_ROOMS, D = PLAN_DOORS;
  return {
    schema: 'frameplay.room/1', id: 'plan', title: 'A plan', theme_line: '', width: 640, height: 480, seed: 7, view: 'top_down',
    background: [
      { shape: rect(0, 0, 640, 480), paint: '#efebe4', grain: 2 },
      { shape: rect(20, 20, 580, 420), paint: '#2f2b28', grain: 2 },
    ],
    surface: {
      name: 'floor',
      shape: { rings: [rect(...R.wood), rect(...R.tile), rect(...R.carpet), ...doors.map((d) => rect(...D[d]))] },
      seeds: [[60, 60], [560, 60], [300, 400]],
      paint: { linear: [0, 34, 0, 234], stops: ['#c08a55', '#a87444'] }, grain: 5,
    },
    foreground: [
      { shape: { rings: [rect(...R.tile), ...(doors.includes('tileCarpet') ? [rect(...D.tileCarpet)] : [])] }, paint: '#d6dadc', grain: 3 },
      { shape: rect(...R.carpet), paint: '#8597ad', grain: 4 },
    ],
    objects,
  };
}

// Which room a point is in ('wood', 'tile', 'carpet'), 'door' in a doorway,
// or null off the floor.
export function roomAt(x, y, doors = Object.keys(PLAN_DOORS)) {
  const inRect = ([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h;
  for (const [name, r] of Object.entries(PLAN_ROOMS)) if (inRect(r)) return name;
  for (const d of doors) if (inRect(PLAN_DOORS[d])) return 'door';
  return null;
}
