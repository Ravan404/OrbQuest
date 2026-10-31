import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLACEHOLDER_EXE } from './config.ts';

// Only the exact formerly bundled runtimes may be replaced. Never overwrite
// unknown/custom executables or anything outside the managed game directory.
const LEGACY_SHA256_HASHES = new Set([
  '59c83ecf81741d5606ff9ec64bd60c4a4cdaf3f3c89084058e08b6af46328afd',
  '41d7528b153d6dbc51c948ea8a61a57c04f32bf6d71962dec85a660c2c5c4ea2',
  'd25c7762da88694a6a48b7c8875d6c365c5108eb8221fdacf2d07af5c4465044',
  'c97b65660c32bf315baf63ecac8b7476ed35c477c00a31087ffb6838e2bb4f5e',
  '0e742a47f93000998804cfec1288be1e5da4d3e2e131a314bb89e3054545426e',
  'c02682bad0f0e51193760d3740fe33a4c69ef69abd3a9d29d22f9df1af4567ae',
  // Earlier builds committed to the repository (PyInstaller era, October 2026).
  'f8bbd25d03667dc91a36472b33136b7673352c184c601be8fd7c0db8161aa6b9',
  'de2d8d3c062792bad31f01001dd03efd91bc8eb3c110294b285e974f81b1e6ea',
  'e90094e42138e3a3a7e1babf42e75f69c2a4f77995f5700709b08fa7326aae34',
  '2c5a0cd73fd5fa5b7eb8e6cb72afb5bc62ed9f78034733e03989e655a4eee5f2',
  'e7d27966f385b0eb5d84b1487a95dac3db1f2db3f96d3f22c214ed9bc45c6407',
  // 1.2.26, before the rename to OrbQuest.
  '92124328d85a53c07fd589011d9111f81faaaacd201765ab4e54a32a7dc8b528',
]);

/**
 * The largest placeholder ever shipped was the ~12.4 MB PyInstaller build.
 * Anything bigger is a real game executable and is never read or hashed, so a
 * library entry linked to a 300 MB game binary does not stall the server.
 */
const MAX_PLACEHOLDER_BYTES = 20 * 1024 * 1024;

/** Digest per file, valid while size and mtime stay the same. */
const digestCache = new Map<string, { size: number; mtimeMs: number; digest: string }>();
const MAX_DIGEST_CACHE_ENTRIES = 500;

/** SHA-256 of a small regular file, or undefined for anything else. */
function fileDigest(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PLACEHOLDER_BYTES) return undefined;
    const key = path.resolve(filePath).toLowerCase();
    const cached = digestCache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.digest;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (digestCache.size >= MAX_DIGEST_CACHE_ENTRIES) {
      const oldest = digestCache.keys().next().value;
      if (oldest !== undefined) digestCache.delete(oldest);
    }
    digestCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, digest });
    return digest;
  } catch {
    return undefined;
  }
}

export function upgradeLegacyPlaceholder(managedPath: string, bundledPath: string): void {
  try {
    if (!fs.existsSync(bundledPath) || !fs.existsSync(managedPath)) return;
    if (fs.lstatSync(managedPath).isSymbolicLink()) return;
    const existingHash = fileDigest(managedPath);
    if (!existingHash || !LEGACY_SHA256_HASHES.has(existingHash)) return;
    if (existingHash === fileDigest(bundledPath)) return;
    fs.copyFileSync(bundledPath, managedPath);
  } catch (error) {
    console.warn('Could not upgrade the managed placeholder:', error);
  }
}

export function ensureManagedPlaceholderExecutable(managedPath: string, bundledPath = PLACEHOLDER_EXE): boolean {
  try {
    if (!fs.existsSync(bundledPath)) return false;
    if (fs.existsSync(managedPath)) {
      upgradeLegacyPlaceholder(managedPath, bundledPath);
      return true;
    }
    fs.mkdirSync(path.dirname(managedPath), { recursive: true });
    fs.copyFileSync(bundledPath, managedPath);
    return true;
  } catch (error) {
    console.warn('Could not restore managed placeholder executable:', error);
    return false;
  }
}

export function hasPlaceholderRuntimeSignature(executablePath: string): boolean {
  const candidateHash = fileDigest(executablePath);
  if (!candidateHash) return false;
  if (LEGACY_SHA256_HASHES.has(candidateHash)) return true;
  return candidateHash === fileDigest(PLACEHOLDER_EXE);
}
