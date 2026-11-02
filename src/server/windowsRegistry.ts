/** Reads single values from the Windows registry with `reg query`. */

import { execFileSync } from 'node:child_process';

/** `%USERPROFILE%\Downloads` -> `C:\Users\me\Downloads`. Unknown variables stay as they are. */
export function expandEnvironment(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? whole) : whole;
  });
}

/** The value `reg query` printed for `name`, or null. */
export function parseRegQuery(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/i.exec(line);
    if (match && match[1].toLowerCase() === name.toLowerCase()) {
      const value = match[3].trim();
      if (!value) return null;
      return match[2].toUpperCase() === 'REG_EXPAND_SZ' ? expandEnvironment(value) : value;
    }
  }
  return null;
}

/** A string value under a registry key, or null (also off Windows). */
export function readRegistryValue(key: string, name: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegQuery(output, name);
  } catch {
    return null;
  }
}
