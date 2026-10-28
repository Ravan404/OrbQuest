import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SteamPathEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
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

export function findSteamAppsPaths(options: SteamPathEnvironment = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(programFilesX86, 'Steam', 'steamapps'),
      path.join(programFiles, 'Steam', 'steamapps'),
    );
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Steam', 'steamapps'));
  }

  candidates.push(path.join(homeDir, '.steam', 'steam', 'steamapps'));
  candidates.push(path.join(homeDir, '.local', 'share', 'Steam', 'steamapps'));

  return uniquePaths(candidates.flatMap((candidate) => [candidate, ...readLibraryRoots(candidate)]))
    .filter((candidate) => fs.existsSync(candidate));
}

export function findSteamAppsPath(options: SteamPathEnvironment = {}): string | undefined {
  return findSteamAppsPaths(options)[0];
}
