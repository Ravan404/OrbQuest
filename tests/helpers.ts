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
export const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dqr-test-'));
export const assetRoot = path.join(sandboxRoot, 'assets');
export const gamesDir = path.join(sandboxRoot, 'Games');

fs.mkdirSync(assetRoot, { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'placeholder_runtime.exe'), path.join(assetRoot, 'placeholder_runtime.exe'));

process.env.DQR_ROOT = sandboxRoot;
process.env.DQR_ASSET_ROOT = assetRoot;
process.env.DQR_OFFLINE = '1';
process.env.DQR_REDDIT_CACHE_REFRESH = '0';
delete process.env.DQR_GAMES_DIR;

export const placeholderPath = path.join(assetRoot, 'placeholder_runtime.exe');

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
