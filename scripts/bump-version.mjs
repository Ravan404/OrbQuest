#!/usr/bin/env node
/**
 *   npm run bump-version -- 1.7.0
 *
 * Writes one version number into every file that carries it:
 *   package.json, package-lock.json (two fields), src/version.ts,
 *   desktop/desktop_app.py (APP_VERSION), scripts/build-windows.bat (the "Version:" banner).
 * placeholder/placeholder_runtime.rc keeps its own version: the placeholder exe only
 * changes when placeholder_runtime.c does (scripts/build-placeholder.bat).
 * The notes under the CHANGELOG [Unreleased] heading become the new version's,
 * and the links at the end of the file follow.
 *
 * Nothing is written unless every file has the expected old value, so a
 * half-edited checkout is reported instead of silently patched.
 * scripts/verify-dist.mjs checks the same files, so scripts/build-windows.bat
 * refuses to package a mismatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: npm run bump-version -- <major.minor.patch>   (for example 1.2.24)');
  process.exit(1);
}

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const current = packageJson.version;

if (current === next) {
  console.error(`The version is already ${next}.`);
  process.exit(1);
}

const lock = JSON.parse(read('package-lock.json'));

// Each entry: file, how to find the old text, how to replace it.
const edits = [
  {
    file: 'package.json',
    check: packageJson.version === current,
    apply: (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`),
  },
  {
    file: 'package-lock.json',
    check: lock.version === current && lock.packages?.['']?.version === current,
    apply: (text) => {
      // Only the two top-level version fields: the root entry and packages[""].
      let count = 0;
      return text.replace(/("version":\s*")[^"]+(")/g, (match, a, b) => {
        count += 1;
        return count <= 2 ? `${a}${next}${b}` : match;
      });
    },
  },
  {
    file: 'src/version.ts',
    check: read('src/version.ts').includes(`APP_VERSION = '${current}'`),
    apply: (text) => text.replace(`APP_VERSION = '${current}'`, `APP_VERSION = '${next}'`),
  },
  {
    file: 'desktop/desktop_app.py',
    check: new RegExp(`^APP_VERSION = "${current.replaceAll('.', '\\.')}"`, 'm').test(read('desktop/desktop_app.py')),
    apply: (text) => text.replace(`APP_VERSION = "${current}"`, `APP_VERSION = "${next}"`),
  },
  {
    file: 'scripts/build-windows.bat',
    check: read('scripts/build-windows.bat').includes(`Version: ${current}`),
    apply: (text) => text.replace(`Version: ${current}`, `Version: ${next}`),
  },
];

const problems = edits.filter((edit) => !edit.check).map((edit) => edit.file);
if (problems.length > 0) {
  console.error(`These files do not contain ${current}, nothing was changed: ${problems.join(', ')}`);
  process.exit(1);
}

for (const edit of edits) {
  const before = read(edit.file);
  const after = edit.apply(before);
  if (after === before) {
    console.error(`Could not update ${edit.file}; nothing was changed.`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(root, edit.file), after, 'utf8');
  console.log(`  updated ${edit.file}`);
}

const changelogPath = path.join(root, 'CHANGELOG.md');
let changelog = fs.readFileSync(changelogPath, 'utf8');
const heading = `## [${next}]`;
const today = new Date().toISOString().slice(0, 10);
if (changelog.includes(heading)) {
  console.log(`  CHANGELOG already has ${heading}`);
} else {
  // The notes collected under [Unreleased] become the new version's notes.
  changelog = changelog.replace('## [Unreleased]', `## [Unreleased]\n\n${heading} - ${today}`);
  const repository = 'https://github.com/Ravan404/OrbQuest';
  changelog = changelog.replace(
    /^\[Unreleased\]: .*$/m,
    `[Unreleased]: ${repository}/compare/v${next}...HEAD\n[${next}]: ${repository}/compare/v${current}...v${next}`
  );
  fs.writeFileSync(changelogPath, changelog, 'utf8');
  console.log(`  CHANGELOG: [Unreleased] is now ${heading} - ${today}`);
}

console.log(`\nVersion ${current} -> ${next}. Run "npm run build" and "npm run verify:dist" to check.`);
