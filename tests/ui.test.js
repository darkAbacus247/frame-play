import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './fakedom.js';
import { el, showCard, cardOpen, reserveHeight } from '../src/ui.js';

test('an end card is modal: one primary, focus on it, Escape cannot close it', () => {
  const doc = installFakeDocument();
  const dialog = el('dialog', { id: 'card' });
  doc.body.append(el('main', { id: 'main' }, [el('button', { type: 'button', text: 'behind' })]), dialog);
  const calls = [];
  showCard(dialog, {
    title: 'Room cleared!',
    lines: ['Your route: 1.3 times the shortest.'],
    label: 'Sample room · MOCK · drawn by code; no model was called',
    primary: { label: 'Continue: another room', onClick: () => calls.push('primary') },
    secondary: [{ label: 'Play this room again', onClick: () => calls.push('again') }],
  });
  assert.equal(dialog.open, true);
  assert.equal(doc.modal, dialog, 'shown with showModal, so the board behind is inert and dimmed');
  assert.equal(cardOpen(), true);
  const buttons = dialog.querySelectorAll('button');
  const primaries = dialog.querySelectorAll('[data-primary]');
  assert.equal(primaries.length, 1, 'exactly one primary');
  assert.equal(doc.activeElement, primaries[0], 'focus starts on the primary');
  assert.ok(primaries[0].classList.contains('primary'));
  assert.ok(buttons.slice(1).every((b) => !b.classList.contains('primary')), 'the rest are visibly secondary');
  const esc = dialog.dispatch('cancel');
  assert.equal(esc.defaultPrevented, true, 'a cancel request is refused');
  assert.equal(dialog.open, true);
  for (let i = 0; i < 10; i++) doc.pressKey('Escape');
  assert.equal(dialog.open, true, 'ten Escapes in a row cannot dismiss the card');
  assert.equal(doc.activeElement, primaries[0]);
  primaries[0].click();
  assert.deepEqual(calls, ['primary']);
  assert.equal(dialog.open, false);
  assert.equal(cardOpen(), false);
});

test('the welcome-back card is modal too, with Start fresh secondary', () => {
  const doc = installFakeDocument();
  const dialog = el('dialog', { id: 'card' });
  doc.body.append(dialog);
  let chosen = '';
  showCard(dialog, {
    title: 'Welcome back',
    primary: { label: 'Continue where you left off (Step 4 of 15: Play)', onClick: () => { chosen = 'continue'; } },
    secondary: [{ label: 'Start fresh', onClick: () => { chosen = 'fresh'; } }],
  });
  assert.equal(doc.modal, dialog);
  assert.equal(doc.activeElement.textContent, 'Continue where you left off (Step 4 of 15: Play)');
  dialog.querySelectorAll('button')[1].click();
  assert.equal(chosen, 'fresh');
  assert.equal(dialog.open, false);
});

function cardOnPage() {
  const doc = installFakeDocument();
  const dialog = el('dialog', { id: 'card' });
  doc.body.append(el('main', { id: 'main' }, [el('button', { type: 'button', text: 'behind' })]), dialog);
  return { doc, dialog };
}

test('the fake page refuses Escape only once, as Chrome does, so the checks below mean something', () => {
  const { doc, dialog } = cardOnPage();
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.showModal();
  doc.pressKey('Escape');
  assert.equal(dialog.open, true, 'the first refusal holds');
  doc.pressKey('Escape');
  assert.equal(dialog.open, false, 'the second Escape closes a dialog that only refuses cancel');
});

for (const which of ['an end card', 'the welcome-back card']) {
  test(`${which} survives any number of Escapes, from either button, and only its buttons close it`, () => {
    const { doc, dialog } = cardOnPage();
    const calls = [];
    const show = () => showCard(dialog, which === 'an end card'
      ? { title: 'Room cleared!', primary: { label: 'Continue: another room', onClick: () => calls.push('primary') },
        secondary: [{ label: 'Play this room again', onClick: () => calls.push('again') }] }
      : { title: 'Welcome back', primary: { label: 'Continue where you left off (Step 4 of 15: Play)', onClick: () => calls.push('primary') },
        secondary: [{ label: 'Start fresh', onClick: () => calls.push('fresh') }] });
    show();
    const [, second] = dialog.querySelectorAll('button');
    for (let i = 0; i < 25; i++) {
      const e = doc.pressKey('Escape');
      assert.equal(e.defaultPrevented, true, `Escape ${i + 1} is stopped before the dialog sees it`);
      assert.equal(dialog.open, true, `still open after Escape ${i + 1}`);
      assert.equal(doc.modal, dialog);
    }
    second.focus();
    for (let i = 0; i < 5; i++) doc.pressKey('Escape');
    assert.equal(dialog.open, true, 'Escape from the secondary button is stopped too');
    assert.deepEqual(calls, [], 'no button ran');
    second.click();
    assert.equal(dialog.open, false);
    assert.equal(calls.length, 1);
    show();
    assert.equal(doc.activeElement, dialog.querySelector('[data-primary]'), 'shown again, focus is back on the primary');
  });
}

test('a card that is closed by anything but its buttons comes straight back, focus on its primary', () => {
  const { doc, dialog } = cardOnPage();
  showCard(dialog, { title: 'Room cleared!', primary: { label: 'Continue', onClick: () => {} }, secondary: [{ label: 'Again', onClick: () => {} }] });
  dialog.requestClose();
  dialog.requestClose();
  dialog.requestClose();
  assert.equal(dialog.open, true, 'close requests that cannot be refused still leave the card up');
  dialog.close();
  assert.equal(dialog.open, true, 'a bare close re-shows the card');
  assert.equal(doc.modal, dialog);
  assert.equal(doc.activeElement, dialog.querySelector('[data-primary]'));
  dialog.querySelector('[data-primary]').click();
  assert.equal(dialog.open, false, 'its own button does close it');
});

test('the header keeps its height when a round ends on the same step, and resizes freely on a new one', () => {
  const box = { offsetHeight: 104, style: {} };
  reserveHeight(box, true);
  assert.equal(box.style.minHeight, '104px', 'the height is held before the contents change');
  box.offsetHeight = 104; // the why line went away, but min-height holds the box
  reserveHeight(box, true);
  assert.equal(box.style.minHeight, '104px');
  reserveHeight(box, false);
  assert.equal(box.style.minHeight, '', 'a new step lets it size itself');
  const hidden = { offsetHeight: 0, style: {} };
  reserveHeight(hidden, true);
  assert.equal(hidden.style.minHeight, undefined, 'nothing is held for a box that is not laid out');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function renderHeader()'), app.indexOf('function renderDock()'));
  assert.ok(fn.indexOf("reserveHeight($('top'), A.headerStep === r.step)") >= 0, 'renderHeader holds the height on the same step');
  assert.ok(fn.indexOf('reserveHeight') < fn.indexOf('replaceChildren'), 'and does so before it changes anything');
  assert.ok(fn.indexOf('reserveHeight') < fn.indexOf("$('lap').textContent"));
});

test('el skips empty attributes and gives every tooltip to screen readers', () => {
  const doc = installFakeDocument();
  doc.body.append(el('div', { id: 'tips' }));
  const b = el('button', { type: 'button', disabled: false, tip: 'Opens the settings', text: 'Settings' });
  assert.equal(b.hasAttribute('disabled'), false);
  const desc = doc.getElementById(b.getAttribute('aria-describedby'));
  assert.ok(desc, 'the tooltip words are in the page');
  assert.equal(desc.textContent, 'Opens the settings');
  assert.equal(b.dataset.tip, 'Opens the settings');
});
