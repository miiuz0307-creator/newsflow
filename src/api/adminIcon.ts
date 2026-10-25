/**
 * The management panel's app icon (home screen / notifications), drawn in code as
 * a PNG: the PUSH dot (teal, with its halo) on navy. No image files to ship.
 */
import { crc32, deflateSync } from 'node:zlib';

const NAVY = [0x0a, 0x1b, 0x33];
const TEAL = [0x19, 0xc6, 0xb4];

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Square icon, `size` pixels. Full-bleed navy (works as "maskable"), dot in the middle. */
export function adminIconPng(size: number): Buffer {
  const c = size / 2;
  const dotR = size * 0.17;
  const haloR = size * 0.29;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const dot = Math.min(1, Math.max(0, dotR - d + 0.5));
      const halo = Math.min(1, Math.max(0, haloR - d + 0.5)) * 0.24;
      const px = [0, 1, 2].map((i) => {
        const withHalo = NAVY[i]! + (TEAL[i]! - NAVY[i]!) * halo;
        return Math.round(withHalo + (TEAL[i]! - withHalo) * dot);
      });
      const o = row + 1 + x * 4;
      raw[o] = px[0]!; raw[o + 1] = px[1]!; raw[o + 2] = px[2]!; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cache = new Map<number, Buffer>();
export function adminIcon(size: 180 | 192 | 512): Buffer {
  let b = cache.get(size);
  if (!b) { b = adminIconPng(size); cache.set(size, b); }
  return b;
}
