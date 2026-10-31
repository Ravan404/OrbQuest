import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { placeholderPath, removeSandbox, sandboxRoot } = await import('./helpers.ts');
const { hasPlaceholderRuntimeSignature, ensureManagedPlaceholderExecutable } = await import(
  '../src/server/placeholderUpgrade.ts'
);

after(removeSandbox);

test('a copy of the bundled placeholder is recognised', () => {
  const copy = path.join(sandboxRoot, 'copy', 'game.exe');
  assert.equal(ensureManagedPlaceholderExecutable(copy, placeholderPath), true);
  assert.equal(hasPlaceholderRuntimeSignature(copy), true);
});

test('any other file is not a placeholder, and a changed file is re-checked', () => {
  const file = path.join(sandboxRoot, 'other.exe');
  fs.writeFileSync(file, 'not a placeholder');
  assert.equal(hasPlaceholderRuntimeSignature(file), false);

  fs.copyFileSync(placeholderPath, file);
  // Push the mtime forward so the digest cache cannot hide the change.
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(file, later, later);
  assert.equal(hasPlaceholderRuntimeSignature(file), true);
});

test('a large real game executable is not read at all', () => {
  const big = path.join(sandboxRoot, 'big.exe');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 64 * 1024 * 1024);
  const started = performance.now();
  assert.equal(hasPlaceholderRuntimeSignature(big), false);
  assert.ok(performance.now() - started < 200, 'the check returns without hashing 64 MB');
});

test('a missing file is not a placeholder', () => {
  assert.equal(hasPlaceholderRuntimeSignature(path.join(sandboxRoot, 'missing.exe')), false);
});
