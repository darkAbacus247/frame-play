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

function hits(text) {
  const low = text.toLowerCase();
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
      for (const w of hits(line)) found.push(`${rel}:${i + 1}: "${w}"`);
    });
  }
  assert.deepEqual(found, []);
});
