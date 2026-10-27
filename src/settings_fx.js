// Sound and motion settings: Music on or off with its volume, Effects on or
// off, and Reduce motion. Kept on the device like the other settings
// (src/store.js), and only once the person changes one: a fresh visitor gets
// music and effects on, the music at a gentle level, and motion as the
// system asks. Reduce motion is the same choice as the page's Motion switch.
// A change is told to the bus ('settings'), which the synth follows.
import { readPref, writePref, reducedMotion, setMotion } from './store.js';
import { el } from './ui.js';
import { emit } from './events.js';
import { MUSIC_DEFAULT_VOLUME } from './music.js';

export function musicOn() { return readPref('music', true) !== false; }
export function setMusicOn(on) { return writePref('music', !!on); }

// 0 to 1; a damaged value falls back to the default
export function musicVolume() {
  const v = readPref('musicVolume', null);
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : MUSIC_DEFAULT_VOLUME;
}
export function setMusicVolume(v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  return writePref('musicVolume', Math.round(n * 100) / 100);
}

export function effectsOn() { return readPref('effects', true) !== false; }
export function setEffectsOn(on) { return writePref('effects', !!on); }

export function systemReduced() {
  const mq = globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)');
  return !!(mq && mq.matches);
}
export function motionReduced() { return reducedMotion(systemReduced()); }

export function fxSettings() {
  return { music: musicOn(), volume: musicVolume(), effects: effectsOn(), reducedMotion: motionReduced() };
}

function announceChange() {
  const s = fxSettings();
  const root = globalThis.document && globalThis.document.documentElement;
  if (root && root.classList) root.classList.toggle('rm', s.reducedMotion);
  emit('settings', s);
  return s;
}

function sw(label, on, onToggle, tipText) {
  return el('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), tip: tipText, onclick: onToggle }, [
    el('span', { class: 'switch-label', text: label }),
    el('span', { class: 'switch-state', text: on ? 'On' : 'Off' }),
  ]);
}

function setSwitch(b, on) {
  b.setAttribute('aria-checked', String(on));
  b.children[1].textContent = on ? 'On' : 'Off';
}

// Renders the block into container (appended); returns { el, refresh }.
// The controls stay in place when flipped, so focus stays where it was.
export function mountFxSettings(container) {
  const slider = el('input', {
    type: 'range', min: '0', max: '100', step: '5', class: 'fx-volume', id: 'fx-volume',
    oninput: () => { setMusicVolume(Number(slider.value) / 100); emit('settings', fxSettings()); refresh(); },
    onchange: () => { announceChange(); refresh(); },
  });
  const flip = (change) => () => { change(); announceChange(); refresh(); };
  const music = sw('Music', true, flip(() => setMusicOn(!musicOn())), 'Background music, made in code, at a gentle level');
  const effects = sw('Effects', true, flip(() => setEffectsOn(!effectsOn())), 'Steps, chimes, the win and the other game sounds');
  const motion = sw('Reduce motion', false, flip(() => setMotion(motionReduced())), 'No particles, no outlines drawing in, no walk bob');
  const block = el('div', { class: 'fx-settings', role: 'group', 'aria-label': 'Music, effects and motion' }, [
    music,
    el('label', { class: 'fx-volume-row', for: 'fx-volume' }, [el('span', { text: 'Music volume' }), slider]),
    effects,
    motion,
  ]);
  function refresh() {
    const s = fxSettings();
    const pct = Math.round(s.volume * 100);
    setSwitch(music, s.music);
    setSwitch(effects, s.effects);
    setSwitch(motion, s.reducedMotion);
    slider.value = String(pct);
    slider.setAttribute('value', String(pct));
    slider.setAttribute('aria-valuetext', `${pct} percent`);
    slider.disabled = !s.music;
  }
  refresh();
  container.append(block);
  return { el: block, refresh };
}
