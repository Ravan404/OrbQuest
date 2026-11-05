import { isSafeExecutablePath } from '../security.ts';

/** Checks of the values a game request sends. */

export const MAX_NAME_LENGTH = 120;

/** Route params of the `/:id` routes (Express 5 types allow arrays by default). */
export type IdParams = { id: string };

/**
 * Validates an executable from a request: a file name (`game.exe`) or a path
 * inside the game folder as Discord expects it (`win64/game.exe`).
 */
export function parseExecutableName(value: unknown): { value: string } | { error: string } {
  const requested = typeof value === 'string' ? value.trim().replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!requested) return { error: 'Executable name is required' };
  if (!requested.toLowerCase().endsWith('.exe')) return { error: 'Executable must end with .exe' };
  if (!isSafeExecutablePath(requested))
    return { error: 'Executable must be a safe file name or path inside the game folder.' };
  return { value: requested };
}

/** Validates a display name from a request. Returns the name or an error. */
export function parseDisplayName(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) return { error: 'Name is required' };
  if (value.trim().length > MAX_NAME_LENGTH) return { error: `Name is too long (${MAX_NAME_LENGTH} characters max).` };
  return { value: value.trim() };
}
