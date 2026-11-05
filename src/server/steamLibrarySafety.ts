/**
 * A Steam-manifest quest is written into the real Steam `steamapps` folder,
 * which also holds the user's actual games. These checks make sure the app
 * never overwrites or deletes anything it did not create there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hasPlaceholderRuntimeSignature } from './placeholderUpgrade.ts';

/** Written next to a placeholder so a later delete can recognise our install. The name is from before the rename; existing installs carry it. */
export const MANAGED_INSTALL_MARKER = '.dqr-managed.json';

const METADATA_FILES = new Set(['.game-name.txt', '.game-meta.json', '.game-icon.ico', MANAGED_INSTALL_MARKER]);

/** A placeholder install is a handful of files. Stop walking long before a real library. */
const MAX_INSPECTED_FILES = 200;

const MANAGED_MANIFEST_KEYS = new Set(['appid', 'name', 'stateflags', 'installdir']);

/** The manifest this app writes. Steam's own manifests contain many more keys. */
export function buildSimulatedManifest(appId: number, name: string, installDir: string): string {
  const safe = (value: string) =>
    value
      .replace(/[\r\n"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return `"AppState"
{
\t"appid"\t\t"${appId}"
\t"name"\t\t"${safe(name)}"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"${safe(installDir)}"
}
`;
}

/**
 * True only for the minimal manifest this app writes.
 * A real Steam manifest (buildid, SizeOnDisk, LastUpdated, ...) is never "managed".
 */
export function manifestLooksManaged(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0 || content.length > 4_000) return false;
  const keys = [...content.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s+"/g)].map((match) => match[1].toLowerCase());
  if (keys.length === 0) return false;
  return keys.every((key) => MANAGED_MANIFEST_KEYS.has(key));
}

/** True when no manifest is there yet, or it is one this app wrote. */
export function canReplaceManifest(manifestPath: string): boolean {
  if (!fs.existsSync(manifestPath)) return true;
  try {
    return manifestLooksManaged(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }
}

export function writeManagedMarker(dir: string, info: { appId: number; executable: string }): void {
  const marker = {
    managedBy: 'OrbQuest',
    executable: info.executable,
    appId: info.appId,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, MANAGED_INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

function isOurPlaceholder(filePath: string): boolean {
  try {
    const candidate = fs.statSync(filePath);
    if (!candidate.isFile() || candidate.size > 20 * 1024 * 1024) return false;
    return hasPlaceholderRuntimeSignature(filePath);
  } catch {
    return false;
  }
}

/**
 * True when `dir` contains anything other than this app's placeholder and metadata.
 * Missing directories are not foreign. Unreadable or unexpectedly large trees are
 * treated as foreign so a delete cannot walk a real Steam library.
 */
export function installDirectoryIsForeign(dir: string, expectedExecutable: string): boolean {
  if (!fs.existsSync(dir)) return false;
  // The executable can sit in subfolders (`client_pc/root/bin/pc/game.exe`).
  const expected = path.basename(expectedExecutable.trim().replace(/\\/g, '/')).toLowerCase();
  const stack = [dir];
  let inspected = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_INSPECTED_FILES) return true;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) return true;
      if (METADATA_FILES.has(entry.name)) continue;
      if (entry.name.toLowerCase() === expected && isOurPlaceholder(full)) continue;
      return true;
    }
  }
  return false;
}

export interface SteamRemovalDecision {
  deleteFolder: boolean;
  deleteManifest: boolean;
  /** Real Steam files were left in place. */
  preserved: boolean;
}

/**
 * Decide what a library removal may touch.
 * A real game folder or a real Steam manifest is never deleted.
 */
export function planSteamRemoval(
  folderPath: string,
  manifestPath: string | undefined,
  executableName: string
): SteamRemovalDecision {
  const folderExists = fs.existsSync(folderPath);
  const folderForeign = folderExists && installDirectoryIsForeign(folderPath, executableName);
  let manifestReal = false;
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      manifestReal = !manifestLooksManaged(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      manifestReal = true;
    }
  }
  return {
    deleteFolder: folderExists && !folderForeign,
    deleteManifest: Boolean(manifestPath) && !manifestReal,
    preserved: folderForeign || manifestReal,
  };
}
