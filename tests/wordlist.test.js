import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Words that must never appear in the repo: not in a name, a comment, a
// string or a file name, in any case. They are stored backwards so this file
// passes its own scan.
const BANNED = ['rohcna', 'latrop', 'mlaer', 'tfir', 'rebme', 'rednic']
  .map((w) => [...w].reverse().join(''));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// local output, caches and secrets are not the repo's own files (and secrets
// are never opened)
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'tmp', 'out', '.vscode', '.idea']);
const SKIP_FILE = /^\.env(\..*)?$|\.(key|log|pyc)$/i;

function repoFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) repoFiles(join(dir, e.name), out);
    } else if (!SKIP_FILE.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

// The one exception, and it is narrow on purpose: the SAM License is a
// third-party text kept verbatim (README, NOTICE), and its date line names
// the eleventh month, an innocent word that happens to hold a banned one.
// Only in that one file, only that exact word, whole and capitalised as
// written, is skipped (it is spelt in pieces here so this file still holds
// no banned word); every other check stays as strict, and the license file
// is still scanned for everything else.
const EXCEPTIONS = new Map([
  ['LICENSES/SAM_LICENSE.txt', new RegExp('\\bNov' + BANNED[4] + '\\b', 'g')],
]);

function hits(text, rel = '') {
  const allowed = EXCEPTIONS.get(rel);
  const low = (allowed ? text.replace(allowed, ' ') : text).toLowerCase();
  return BANNED.filter((w) => low.includes(w));
}

test('the scan knows its words and finds them in any case', () => {
  assert.equal(BANNED.length, 6);
  assert.deepEqual(hits('A ' + BANNED[0].toUpperCase() + ' here'), [BANNED[0]]);
  assert.deepEqual(hits('seedCells and seedPixels'), []);
});

test('no file name or file content in the repo holds a banned word', () => {
  const files = repoFiles();
  assert.ok(files.length > 20, 'the scan sees the repo');
  const found = [];
  for (const f of files) {
    const rel = relative(ROOT, f).split('\\').join('/');
    for (const w of hits(rel)) found.push(`${rel}: file name holds "${w}"`);
    const lines = readFileSync(f, 'latin1').split('\n');
    lines.forEach((line, i) => {
      for (const w of hits(line, rel)) found.push(`${rel}:${i + 1}: "${w}"`);
    });
  }
  assert.deepEqual(found, []);
});

test('the one exception cannot hide a banned word anywhere else', () => {
  const lic = 'LICENSES/SAM_LICENSE.txt';
  const word = 'Nov' + BANNED[4];
  // the exact word, in that file only
  assert.deepEqual(hits(`Last Updated: ${word} 19, 2025`, lic), []);
  // the same word in any other file, or a file name, is still found
  for (const rel of ['README.md', 'LICENSES/OTHER.txt', 'src/SAM_LICENSE.txt', 'licenses/sam_license.txt', '']) {
    assert.deepEqual(hits(`Last Updated: ${word} 19, 2025`, rel), [BANNED[4]], rel);
  }
  // in that file, every banned word outside the exact word is still found
  for (const w of BANNED) {
    assert.ok(hits(`${word} ${w}`, lic).includes(w), w);
    assert.ok(hits(w.toUpperCase(), lic).includes(w), w);
  }
  // only the whole word as written: other cases, prefixes and suffixes are found
  for (const near of [word.toUpperCase(), word.toLowerCase(), 'De' + word.slice(3), word + 's', 'X' + word, word + BANNED[4]]) {
    assert.deepEqual(hits(near, lic), [BANNED[4]], near);
  }
  // the license file is scanned like any other, and holds the word only on its date line
  const text = readFileSync(join(ROOT, lic), 'utf8');
  const lines = text.split('\n').filter((l) => l.toLowerCase().includes(BANNED[4]));
  assert.deepEqual(lines, [`Last Updated: ${word} 19, 2025`]);
  assert.equal(EXCEPTIONS.size, 1);
});
