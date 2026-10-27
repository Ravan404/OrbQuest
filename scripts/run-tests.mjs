#!/usr/bin/env node
/**
 * scripts/run-tests.mjs
 *
 *   npm test
 *
 * Runs every tests/*.test.ts file with Node's built-in test runner and tsx.
 * The file list is built here because Node 20 does not expand globs itself
 * and cmd.exe (npm's shell on Windows) does not either.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'tests');
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join('tests', name));

if (files.length === 0) {
  console.error('No test files found in tests/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
