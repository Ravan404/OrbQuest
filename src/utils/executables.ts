import type { CatalogGame } from '../types';

/** Helper programs a game ships next to the game itself. */
const HELPER = /(?:^|[-_ ./])(test|crash|crashreport|report|setup|install|uninstall|unins\d*|updater?|patcher|launcher|eac|easyanticheat|benchmark|server|editor|config|settings)(?:[-_ ./]|\.exe$)/i;

/**
 * The executable to add by default when Discord lists several for a game.
 * Discord's order is not a preference (Marvel Rivals lists its test build
 * first), so the game binary is guessed: no helper programs, an Unreal
 * `-shipping` build or a file named after the game first.
 */
export function preferredExecutable(game: Pick<CatalogGame, 'name' | 'executables'>): string {
  const nameKey = game.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (exe: string): number => {
    const file = exe.split('/').pop() ?? exe;
    const fileKey = file.replace(/\.exe$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let value = 0;
    if (HELPER.test(file)) value -= 10;
    if (/shipping/i.test(file)) value += 3;
    if (nameKey && (fileKey.includes(nameKey) || nameKey.includes(fileKey))) value += 2;
    return value;
  };
  return [...game.executables].sort((a, b) => score(b) - score(a))[0] ?? '';
}
