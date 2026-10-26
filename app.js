// FRAME//PLAY entry module (first playable): paints the desk sample room,
// builds and proves its level, and starts a round with a plain end card.
import { loadRoom } from './src/rooms.js';
import { paintRoom } from './src/painter.js';
import { buildLevel, inputFromRoom } from './src/level.js';
import { pictureFromRGBA } from './src/render.js';
import { mountPlay } from './src/game.js';
import { Synth } from './src/audio.js';
import { soundOn } from './src/store.js';

const $ = (id) => document.getElementById(id);
const audio = new Synth();
audio.setOn(soundOn());
const unlock = () => audio.unlock();
document.addEventListener('pointerdown', unlock, { capture: true });
document.addEventListener('keydown', unlock, { capture: true });

const live = $('live');
function say(text) {
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

const reduceMotion = globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)');

async function boot() {
  const res = await fetch('rooms/desk.json');
  const room = loadRoom(await res.json());
  const painted = paintRoom(room);
  const built = buildLevel(inputFromRoom(room));
  if (built.error) {
    $('main').textContent = built.error;
    return;
  }
  const picture = pictureFromRGBA(room.width, room.height, painted.rgba);
  const card = $('card');
  card.addEventListener('cancel', (e) => e.preventDefault());
  let view = null;
  const start = () => {
    view = mountPlay($('main'), {
      level: built.level,
      rt: built.rt,
      picture,
      audio,
      say,
      ui: () => ({ outlines: true, reducedMotion: !!(reduceMotion && reduceMotion.matches), highContrast: false }),
      onEnd: (r) => {
        if (r.status !== 'won') audio.play('loss');
        say(r.words.title);
        card.innerHTML = '';
        const h = document.createElement('h2');
        h.id = 'card-title';
        h.textContent = r.words.title;
        const p = document.createElement('p');
        p.textContent = r.words.body;
        const again = document.createElement('button');
        again.className = 'btn primary';
        again.type = 'button';
        again.textContent = r.status === 'won' ? 'Play this room again' : 'Try again';
        again.addEventListener('click', () => { card.close(); view.restart(); view.focusGame(); });
        const body = document.createElement('div');
        body.className = 'card-body';
        body.append(h, p, again);
        card.append(body);
        card.showModal();
        again.focus();
      },
    });
    view.focusGame();
  };
  start();
}

boot().catch((e) => {
  $('main').textContent = `Something went wrong while loading: ${e.message}`;
});
