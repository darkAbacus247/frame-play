// Page helpers: elements, modal cards, tooltips placed by measuring, and
// speech. Only this file, render, game, photo, audio and app touch the page.

export function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k === 'tip') tip(e, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(kids)) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

// ---- modal cards (end cards, welcome back): focus stays on the card ----
export function showCard(dialog, { title, lines = [], label, primary, secondary = [] }) {
  dialog.replaceChildren();
  const h = el('h2', { id: 'card-title', text: title });
  const body = el('div', { class: 'card-body' }, [h]);
  for (const t of lines) if (t) body.append(el('p', { text: t }));
  if (label) body.append(el('p', { class: 'label', text: label }));
  const bar = el('div', { class: 'actions' });
  if (primary) {
    bar.append(el('button', { type: 'button', class: 'btn primary', 'data-primary': 'true', text: primary.label, onclick: () => { closeCard(dialog); primary.onClick(); } }));
  }
  for (const s of secondary) {
    bar.append(el('button', { type: 'button', class: 'btn', text: s.label, onclick: () => { closeCard(dialog); s.onClick(); } }));
  }
  body.append(bar);
  dialog.append(body);
  if (!dialog.dataset.bound) {
    // Only the card's own buttons may close it. Escape is stopped before the
    // dialog sees it; 'cancel' is refused too (browsers honour that refusal
    // only once without a new click); and should the dialog close anyway
    // while the card is still required, it is shown again at once.
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); e.stopPropagation(); }
    }, { capture: true });
    dialog.addEventListener('cancel', (e) => e.preventDefault());
    dialog.addEventListener('close', () => {
      if (dialog.dataset.required) openCard(dialog);
    });
    dialog.dataset.bound = '1';
  }
  dialog.dataset.required = '1';
  hideTip();
  openCard(dialog);
}

function openCard(dialog) {
  if (!dialog.open) dialog.showModal();
  (dialog.querySelector('[data-primary]') || dialog.querySelector('button'))?.focus();
}

export function closeCard(dialog) {
  delete dialog.dataset.required;
  if (dialog.open) dialog.close();
}

export function cardOpen() {
  return !!document.querySelector('dialog[open]');
}

// ---- tooltips ----
// Every control has plain words: shown on hover, focus and long press, and
// given to screen readers through aria-describedby. A tooltip is placed by
// measuring the space beside its control where it covers no control; when
// no such spot exists it is not shown. Never while a card or the tour is up.
const descNodes = new Map();
let tipEl = null;
let tipFor = null;
let suppressed = () => false;

export function tip(control, text) {
  control.dataset.tip = text;
  let node = descNodes.get(text);
  if (!node || !node.isConnected) {
    node = document.createElement('span');
    node.className = 'sr-only';
    node.id = `tip-${descNodes.size + 1}-${Math.random().toString(36).slice(2, 7)}`;
    node.textContent = text;
    (document.getElementById('tips') || document.body).append(node);
    descNodes.set(text, node);
  }
  control.setAttribute('aria-describedby', node.id);
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function placeTip(ctrlRect, size, vw, vh, others, gap = 8) {
  const { w, h } = size;
  const cx = ctrlRect.left + ctrlRect.width / 2, cy = ctrlRect.top + ctrlRect.height / 2;
  const cands = [
    { left: cx - w / 2, top: ctrlRect.top - gap - h },
    { left: cx - w / 2, top: ctrlRect.bottom + gap },
    { left: ctrlRect.right + gap, top: cy - h / 2 },
    { left: ctrlRect.left - gap - w, top: cy - h / 2 },
  ];
  for (const c of cands) {
    const r = { left: c.left, top: c.top, right: c.left + w, bottom: c.top + h };
    if (r.left < 4 || r.top < 4 || r.right > vw - 4 || r.bottom > vh - 4) continue;
    if (others.some((o) => overlaps(r, o))) continue;
    return r;
  }
  return null;
}

function controlsExcept(ctrl) {
  const out = [];
  for (const e of document.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"], canvas')) {
    if (e === ctrl || ctrl.contains(e) || e.closest('[hidden]')) continue;
    const r = e.getBoundingClientRect();
    if (r.width && r.height) out.push(r);
  }
  return out;
}

function showTip(ctrl) {
  if (suppressed() || cardOpen()) return;
  const text = ctrl.dataset.tip;
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('aria-hidden', 'true');
    document.body.append(tipEl);
  }
  tipEl.textContent = text;
  tipEl.hidden = false;
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  const size = { w: tipEl.offsetWidth, h: tipEl.offsetHeight };
  const spot = placeTip(ctrl.getBoundingClientRect(), size, innerWidth, innerHeight, controlsExcept(ctrl));
  if (!spot) { tipEl.hidden = true; return; }
  tipEl.style.left = `${Math.round(spot.left)}px`;
  tipEl.style.top = `${Math.round(spot.top)}px`;
  tipFor = ctrl;
}

export function hideTip() {
  if (tipEl) tipEl.hidden = true;
  tipFor = null;
}

export function initTooltips(isSuppressed) {
  suppressed = isSuppressed || suppressed;
  let press = 0;
  const find = (t) => (t && t.closest ? t.closest('[data-tip]') : null);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const c = find(e.target);
    if (c && c !== tipFor) showTip(c);
  });
  document.addEventListener('pointerout', (e) => {
    const c = find(e.target);
    if (c && !c.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', (e) => { const c = find(e.target); if (c) showTip(c); else hideTip(); });
  document.addEventListener('focusout', () => hideTip());
  document.addEventListener('pointerdown', (e) => {
    hideTip();
    if (e.pointerType !== 'touch') return;
    const c = find(e.target);
    clearTimeout(press);
    if (c) press = setTimeout(() => showTip(c), 550);
  });
  document.addEventListener('pointerup', () => clearTimeout(press));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  document.addEventListener('scroll', hideTip, true);
  addEventListener('resize', hideTip);
}

// ---- speech ----
export function speak(text) {
  try {
    const s = globalThis.speechSynthesis;
    if (!s || !globalThis.SpeechSynthesisUtterance) return false;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en';
    s.speak(u);
    return true;
  } catch {
    return false;
  }
}
