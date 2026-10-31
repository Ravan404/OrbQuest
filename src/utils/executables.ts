import type { CatalogGame } from '../types';

/** Helper programs a game ships next to the game itself. */
const HELPER = /(?:^|[-_ ./])(test|crash|crashreport|report|setup|install|uninstall|unins\d*|updater?|patcher|launcher|benchmark|server|editor|config|settings)(?:[-_ ./]|\.exe$)/i;
/** Other builds of the game: a demo, a beta or test realm, an event build, an anti-cheat wrapper. */
const VARIANT = /demo|beta|ptr|event|(?:^|[-_ ./])(be|eac|easyanticheat|egs)(?:[-_ ./]|\.exe$)/i;

/**
 * The executable to add by default when Discord lists several for a game.
 * Discord recognises the game by any of them, so this is only a convenience,
 * but its order is not a preference (Marvel Rivals lists its test build
 * first). The game binary is guessed: no helper programs or other builds
 * (demo, beta, event, anti-cheat wrapper), an Unreal `-shipping` build or a
 * file named after the game first.
 */
export function preferredExecutable(game: Pick<CatalogGame, 'name' | 'executables'>): string {
  const nameKey = game.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (exe: string): number => {
    const file = exe.split('/').pop() ?? exe;
    const fileKey = file.replace(/\.exe$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let value = 0;
    if (HELPER.test(file)) value -= 10;
    if (VARIANT.test(exe)) value -= 5;
    if (/shipping/i.test(file)) value += 3;
    if (nameKey && (fileKey.includes(nameKey) || nameKey.includes(fileKey))) value += 2;
    return value;
  };
  return [...game.executables].sort((a, b) => score(b) - score(a))[0] ?? '';
}
