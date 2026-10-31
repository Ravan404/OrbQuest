/**
 * placeholderIcon.ts
 *
 * Gives the placeholder window the game's icon. Before a launch the game's
 * local PNG icon is written next to the placeholder as `.game-icon.ico`; the
 * placeholder loads it at start and uses it for its title bar and taskbar
 * button. The placeholder executable itself is never changed, so its hash
 * still identifies it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CACHED_ICON_URL_PREFIX, ICON_CACHE_DIR } from './iconStore.ts';

export const GAME_ICON_FILE = '.game-icon.ico';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG on disk behind a `/game-icons-cache/...` URL, if there is one. */
export function localIconFile(logoUrl: string | undefined): string | null {
  if (!logoUrl?.startsWith(CACHED_ICON_URL_PREFIX)) return null;
  const name = decodeURIComponent(logoUrl.slice(CACHED_ICON_URL_PREFIX.length).split('?')[0]);
  if (!/^[\w.-]+\.png$/i.test(name)) return null;
  const file = path.join(ICON_CACHE_DIR, name);
  return fs.existsSync(file) ? file : null;
}

/**
 * Wraps a PNG in a one-image .ico file. Windows (Vista and later) reads
 * PNG-compressed icon images directly. Returns null for anything that is not a PNG.
 */
export function pngToIco(png: Buffer): Buffer | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height) return null;

  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(width >= 256 ? 0 : width, 6); // 0 means 256 or more
  header.writeUInt8(height >= 256 ? 0 : height, 7);
  header.writeUInt8(0, 8); // no palette
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // image data offset
  return Buffer.concat([header, png]);
}

/**
 * Writes (or refreshes) `.game-icon.ico` in `folder` from the game's icon.
 * Does nothing when the game has no local PNG icon. Never throws.
 */
export function writePlaceholderIcon(folder: string, logoUrl: string | undefined): void {
  try {
    const source = localIconFile(logoUrl);
    if (!source) return;
    const ico = pngToIco(fs.readFileSync(source));
    if (!ico) return;
    const target = path.join(folder, GAME_ICON_FILE);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(ico)) return;
    fs.writeFileSync(target, ico);
  } catch (error) {
    console.warn('Could not write the placeholder icon:', error);
  }
}
