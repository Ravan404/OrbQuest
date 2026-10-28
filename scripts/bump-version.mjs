#!/usr/bin/env node
/**
 * scripts/bump-version.mjs
 *
 *   npm run bump-version -- 1.2.24
 *
 * Writes one version number into every file that carries it:
 *   package.json, package-lock.json (two fields), src/version.ts,
 *   desktop_app.py (APP_VERSION), build_windows_exe.bat (the "Version:" banner),
 *   placeholder_runtime.rc (version resource of the placeholder exe),
 *   src/server/redditCache.json (the stamp the app writes on refresh).
 * The CHANGELOG [Unreleased] heading becomes the new version (an empty section
 * is added when there is none).
 *
 * Nothing is written unless every file has the expected old value, so a
 * half-edited checkout is reported instead of silently patched.
 * scripts/verify-dist.mjs checks the same files, so build_windows_exe.bat
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
const cache = JSON.parse(read('src/server/redditCache.json'));

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
    file: 'desktop_app.py',
    check: new RegExp(`^APP_VERSION = "${current.replaceAll('.', '\\.')}"`, 'm').test(read('desktop_app.py')),
    apply: (text) => text.replace(`APP_VERSION = "${current}"`, `APP_VERSION = "${next}"`),
  },
  {
    file: 'build_windows_exe.bat',
    check: read('build_windows_exe.bat').includes(`Version: ${current}`),
    apply: (text) => text.replace(`Version: ${current}`, `Version: ${next}`),
  },
  {
    // Version resource of placeholder_runtime.exe. The exe itself only changes
    // when it is rebuilt (scripts/build-placeholder.bat).
    file: 'placeholder_runtime.rc',
    check: read('placeholder_runtime.rc').includes(`"${current}.0\\0"`),
    apply: (text) => {
      const [major, minor, patch] = next.split('.');
      return text
        .replace(/(FILEVERSION|PRODUCTVERSION)(\s+)\d+,\d+,\d+,0/g, `$1$2${major},${minor},${patch},0`)
        .replaceAll(`"${current}.0\\0"`, `"${next}.0\\0"`);
    },
  },
  {
    file: 'src/server/redditCache.json',
    check: cache.version === current,
    apply: (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`),
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
const changelog = fs.readFileSync(changelogPath, 'utf8');
const heading = `## [${next}]`;
const today = new Date().toISOString().slice(0, 10);
if (changelog.includes('## [Unreleased]') && !changelog.includes(heading)) {
  // The notes collected under [Unreleased] become the new version's notes.
  fs.writeFileSync(changelogPath, changelog.replace('## [Unreleased]', `${heading} — ${today}`), 'utf8');
  console.log(`  CHANGELOG: [Unreleased] is now ${heading} — ${today}`);
} else if (!changelog.includes(heading)) {
  const section = `${heading} — ${today}\n\n- (describe the changes)\n\n`;
  const marker = changelog.indexOf('## [');
  const updated = marker === -1 ? `${changelog}\n${section}` : `${changelog.slice(0, marker)}${section}${changelog.slice(marker)}`;
  fs.writeFileSync(changelogPath, updated, 'utf8');
  console.log(`  added a CHANGELOG section for ${next} - replace the placeholder text before release`);
}

console.log(`\nVersion ${current} -> ${next}. Run "npm run build" and "npm run verify:dist" to check.`);
