import fs from 'node:fs';

export interface SimulatedSteamManifest {
  appId: number;
  name: string;
  stateFlags?: number;
  installDir: string;
}

function readField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`"${field}"\\s+"([^"]*)"`, 'i'));
  return match?.[1]?.trim() || undefined;
}

export function parseSimulatedSteamManifest(content: string): SimulatedSteamManifest {
  if (typeof content !== 'string' || content.length > 32_000) {
    throw new Error('Manifest is empty or too large.');
  }

  const appId = Number(readField(content, 'appid'));
  const name = readField(content, 'name');
  const installDir = readField(content, 'installdir');
  const stateFlagsRaw = readField(content, 'StateFlags');
  const stateFlags = stateFlagsRaw === undefined ? undefined : Number(stateFlagsRaw);

  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('Manifest appid is invalid.');
  if (!name || name.length > 120) throw new Error('Manifest name is invalid.');
  if (!installDir || installDir.length > 120 || /[\\/:*?"<>|]/.test(installDir) || installDir.includes('..')) {
    throw new Error('Manifest installdir is invalid.');
  }
  if (stateFlagsRaw !== undefined && (!Number.isInteger(stateFlags) || stateFlags! < 0)) {
    throw new Error('Manifest StateFlags is invalid.');
  }

  return { appId, name, installDir, stateFlags };
}

export function readSimulatedSteamManifest(filePath: string): SimulatedSteamManifest {
  return parseSimulatedSteamManifest(fs.readFileSync(filePath, 'utf8'));
}

