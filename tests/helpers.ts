/**
 * Test sandbox. Import this module (dynamically, first) before any server
 * module: config.ts reads the environment once, at import time.
 *
 * Every test file runs in its own process (node --test), so each file gets a
 * fresh temporary data folder, an offline server and its own module state.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbquest-test-'));
export const assetRoot = path.join(sandboxRoot, 'assets');
export const gamesDir = path.join(sandboxRoot, 'Games');

fs.mkdirSync(path.join(assetRoot, 'placeholder'), { recursive: true });
export const placeholderPath = path.join(assetRoot, 'placeholder', 'placeholder_runtime.exe');
fs.copyFileSync(path.join(repoRoot, 'placeholder', 'placeholder_runtime.exe'), placeholderPath);

process.env.ORBQUEST_ROOT = sandboxRoot;
process.env.ORBQUEST_ASSET_ROOT = assetRoot;
process.env.ORBQUEST_OFFLINE = '1';
process.env.ORBQUEST_DATABASE_REFRESH = '0';
delete process.env.ORBQUEST_GAMES_DIR;

export function removeSandbox(): void {
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leftover temp folder is harmless.
  }
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
