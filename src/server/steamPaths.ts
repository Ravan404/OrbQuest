/**
 * Finds the Steam library a Steam-manifest quest is written to: the
 * `steamapps` folder of the Steam installation (from the registry, then the
 * usual install folders), and the other libraries its libraryfolders.vdf
 * lists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegistryValue } from './windowsRegistry.ts';

export interface SteamPathEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Steam's install folder from the registry; read from Windows when not given. */
  registrySteamPath?: string | null;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `SteamPath` under HKCU\Software\Valve\Steam, or null. */
function readRegistrySteamPath(): string | null {
  const value = readRegistryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  return value ? path.normalize(value) : null;
}

function readLibraryRoots(steamAppsPath: string): string[] {
  const file = path.join(steamAppsPath, 'libraryfolders.vdf');
  if (!fs.existsSync(file)) return [];

  try {
    const content = fs.readFileSync(file, 'utf8');
    return [...content.matchAll(/"path"\s+"((?:\\.|[^"])*)"/gi)]
      .map((match) => match[1].replace(/\\\\/g, '\\'))
      .map((libraryPath) => path.join(libraryPath, 'steamapps'))
      .filter((libraryPath) => fs.existsSync(libraryPath));
  } catch (error) {
    console.warn('Could not read Steam library folders:', error);
    return [];
  }
}

/** Every Steam `steamapps` folder on this computer, the main installation first. */
export function findSteamAppsPaths(options: SteamPathEnvironment = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates: string[] = [];

  if (platform === 'win32') {
    const registry = options.registrySteamPath === undefined ? readRegistrySteamPath() : options.registrySteamPath;
    if (registry) candidates.push(path.join(registry, 'steamapps'));
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    candidates.push(path.join(programFilesX86, 'Steam', 'steamapps'), path.join(programFiles, 'Steam', 'steamapps'));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Steam', 'steamapps'));
  }

  candidates.push(path.join(homeDir, '.steam', 'steam', 'steamapps'));
  candidates.push(path.join(homeDir, '.local', 'share', 'Steam', 'steamapps'));

  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  return uniquePaths(existing.flatMap((candidate) => [candidate, ...readLibraryRoots(candidate)]));
}

/**
 * The library Steam-manifest quests go to: the main installation's
 * `steamapps`, where Steam always looks. DQR_STEAMAPPS overrides it.
 */
export function findSteamAppsPath(options: SteamPathEnvironment = {}): string | undefined {
  const override = (options.env ?? process.env).DQR_STEAMAPPS?.trim();
  if (override) return fs.existsSync(override) ? path.resolve(override) : undefined;
  return findSteamAppsPaths(options)[0];
}
