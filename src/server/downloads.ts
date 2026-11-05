/**
 * The user's Downloads folder, where start scripts are saved. Windows keeps
 * its real location in the registry, because it can be moved to another
 * drive. ORBQUEST_DOWNLOADS_DIR overrides it.
 */

import os from 'node:os';
import path from 'node:path';
import { readRegistryValue } from './windowsRegistry.ts';

const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
/** Known folder id of Downloads. */
const DOWNLOADS_ID = '{374DE290-123F-4565-9164-39C4925E467B}';

export function downloadsFolder(): string {
  const override = process.env.ORBQUEST_DOWNLOADS_DIR?.trim();
  if (override) return path.resolve(override);
  const fromRegistry = readRegistryValue(SHELL_FOLDERS, DOWNLOADS_ID);
  if (fromRegistry && path.isAbsolute(fromRegistry) && !fromRegistry.includes('%')) return fromRegistry;
  return path.join(os.homedir(), 'Downloads');
}
