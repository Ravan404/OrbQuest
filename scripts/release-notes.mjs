#!/usr/bin/env node
/**
 *   node scripts/release-notes.mjs 1.6.1 > notes.md
 *
 * The text of a GitHub release: what the files are, and what changed in this
 * version according to CHANGELOG.md. The Release workflow uses it.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
let end = start + 1;
while (end < lines.length && !lines[end].startsWith('## [') && !/^\[[^\]]+\]: /.test(lines[end])) end += 1;
const changes = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();

const repository = 'https://github.com/Ravan404/OrbQuest';
console.log(`## Download

| File | What it is |
|---|---|
| [\`OrbQuest-Setup-${version}.exe\`](${repository}/releases/download/v${version}/OrbQuest-Setup-${version}.exe) | **Recommended.** Installs for your Windows user, without administrator rights. |
| [\`OrbQuest-${version}.exe\`](${repository}/releases/download/v${version}/OrbQuest-${version}.exe) | Portable: one file that runs from any folder. |

Windows 10 or 11 (64-bit). The files are not code-signed yet, so Windows may say they are from an unknown publisher: More info → Run anyway. \`SHA256SUMS.txt\` lists the SHA-256 of both files. If you have OrbQuest 1.6.0 or newer, click Update at the top of its window instead.

## What changed

${changes}

[Code signing policy](${repository}#code-signing-policy) · [Privacy policy](${repository}/blob/v${version}/PRIVACY.md) · [Full changelog](${repository}/blob/v${version}/CHANGELOG.md)`);
