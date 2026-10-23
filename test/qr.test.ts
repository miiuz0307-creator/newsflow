import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQRModule from 'jsqr';

// jsqr is CommonJS; under ESM its function may sit on .default.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
import { qrMatrix, qrRows } from '../src/api/qr.js';

/** Renders the matrix like the app does (4-module quiet zone) and reads it back with an independent decoder. */
function decode(text: string) {
  const m = qrMatrix(text);
  const q = 4, s = 4, n = (m.length + 2 * q) * s;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const i = (((y + q) * s + dy) * n + (x + q) * s + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }));
  return { version: (m.length - 17) / 4, data: jsQR(px, n, n)?.data };
}

// The shape of a WhatsApp linking code: ref,noiseKey,identityKey,advSecret (about 240 characters).
const WA_LIKE = '2@' + 'aB3/'.repeat(25) + ',' + 'Qx9+'.repeat(11) + 'w=,' + 'Lk7/'.repeat(11) + 'e=,' + 'Zr5+'.repeat(11) + 'u=';

test('QR codes decode back to the exact text, across sizes', () => {
  for (const t of ['a', 'HELLO WORLD', 'שלום עולם', WA_LIKE, 'y'.repeat(500), 'z'.repeat(1500)]) {
    const r = decode(t);
    assert.equal(r.data, t, `version ${r.version}`);
  }
});

test('a WhatsApp-sized code uses a moderate version and compact rows', () => {
  const rows = qrRows(WA_LIKE);
  assert.ok(rows.length >= 45 && rows.length <= 77, `size ${rows.length}`);
  assert.ok(rows.every((r) => r.length === rows.length && /^[01]+$/.test(r)));
  assert.equal(rows[0]!.slice(0, 7), '1111111', 'finder pattern in the corner');
});

test('text that cannot fit is refused', () => {
  assert.throws(() => qrMatrix('x'.repeat(3000)));
});
