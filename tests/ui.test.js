import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './fakedom.js';
import { el, showCard, cardOpen } from '../src/ui.js';

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
  assert.equal(esc.defaultPrevented, true, 'Escape does not dismiss the card');
  assert.equal(dialog.open, true);
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
    primary: { label: 'Continue where you left off (Step 4 of 8: Play)', onClick: () => { chosen = 'continue'; } },
    secondary: [{ label: 'Start fresh', onClick: () => { chosen = 'fresh'; } }],
  });
  assert.equal(doc.modal, dialog);
  assert.equal(doc.activeElement.textContent, 'Continue where you left off (Step 4 of 8: Play)');
  dialog.querySelectorAll('button')[1].click();
  assert.equal(chosen, 'fresh');
  assert.equal(dialog.open, false);
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
