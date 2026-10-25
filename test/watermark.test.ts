/** Burns a red logo into a black test video/photo with the real ffmpeg and checks the pixels. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLogo, ffmpegAvailable, logoFilter, parsePgmFrames, pickCorner } from '../src/media/watermark.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function ff(args: string[]) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r;
}
/** A 320x240 black clip (with sound) and a 40x20 red PNG. */
function fixtures() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
  const video = path.join(dir, 'v.mp4'); const logo = path.join(dir, 'l.png'); const photo = path.join(dir, 'p.jpg');
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1:r=10', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=40x20:d=1', '-frames:v', '1', logo]);
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1', '-frames:v', '1', photo]);
  return { dir, video: readFileSync(video), logo: readFileSync(logo), photo: readFileSync(photo) };
}
/** RGB of one pixel of the first frame. */
function pixel(media: Buffer, ext: string, x: number, y: number): [number, number, number] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wm-px-'));
  const f = path.join(dir, `m.${ext}`); writeFileSync(f, media);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  rmSync(dir, { recursive: true, force: true });
  const w = 320; const i = (y * w + x) * 3; const b = r.stdout as Buffer;
  return [b[i]!, b[i + 1]!, b[i + 2]!];
}

describe('logo on videos and photos', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  test('the logo lands where chosen, at the chosen size, and the sound is kept', async () => {
    assert.equal(await ffmpegAvailable(), true);
    const f = fixtures();
    try {
      // bottom-left, 25% of 320 = 80px wide → 80x40 logo, 3% margin ≈ 10px.
      const out = await applyLogo(f.video, 'video', { logo: f.logo, logoMime: 'image/png', position: 'bottom-left', sizePct: 25, opacityPct: 100 });
      assert.equal(out.mimeType, 'video/mp4');
      const inLogo = pixel(out.data, 'mp4', 40, 240 - 10 - 20);
      assert.ok(inLogo[0] > 180 && inLogo[1] < 80, `red logo expected, got ${inLogo}`);
      const outside = pixel(out.data, 'mp4', 300, 20);
      assert.ok(outside[0] < 40, `video untouched elsewhere, got ${outside}`);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: out.data });
      assert.match(String(probe.stdout), /audio/, 'sound copied');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('photos get the logo too, and opacity blends it', async () => {
    const f = fixtures();
    try {
      const out = await applyLogo(f.photo, 'image', { logo: f.logo, logoMime: 'image/png', position: 'top-right', sizePct: 25, opacityPct: 50 });
      assert.equal(out.mimeType, 'image/jpeg');
      const px = pixel(out.data, 'jpg', 320 - 10 - 40, 10 + 20);
      assert.ok(px[0] > 90 && px[0] < 170, `half-transparent red over black, got ${px}`);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('smart position: the logo moves away from a busy corner, and stays put when all are quiet', async () => {
    const f = fixtures();
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'wm-busy-'));
      const busy = path.join(dir, 'busy.mp4');
      // Black clip with a detailed test pattern (like a caption) over the bottom-left corner.
      ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1:r=10', '-f', 'lavfi', '-i', 'testsrc=s=140x90:d=1:r=10',
        '-filter_complex', '[0][1]overlay=0:150', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', busy]);
      const settings = { logo: f.logo, logoMime: 'image/png', position: 'bottom-left' as const, sizePct: 25, opacityPct: 100, smart: true };
      const moved = await applyLogo(readFileSync(busy), 'video', settings);
      assert.notEqual(moved.position, 'bottom-left', 'avoids the busy corner');
      const [x, y] = ({ 'top-left': [40, 20], 'top-right': [270, 20], 'bottom-right': [270, 210] } as Record<string, [number, number]>)[moved.position]!;
      assert.ok(pixel(moved.data, 'mp4', x, y)[0] > 180, `logo drawn in ${moved.position}`);
      const calm = await applyLogo(f.video, 'video', settings);
      assert.equal(calm.position, 'bottom-left', 'keeps the chosen corner when nothing is covered');
      rmSync(dir, { recursive: true, force: true });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('a broken file is reported, not silently passed on', async () => {
    const f = fixtures();
    try {
      await assert.rejects(applyLogo(Buffer.from('not a video'), 'video', { logo: f.logo, logoMime: 'image/png', position: 'center', sizePct: 20, opacityPct: 80 }));
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

test('size and opacity are kept within limits in the filter', () => {
  const g = logoFilter({ position: 'center', sizePct: 99, opacityPct: 1 }, 'video');
  assert.match(g, /iw\*0\.4:/);
  assert.match(g, /aa=0\.2\[/);
});

test('PGM frames are read, and the preferred corner wins unless another is clearly quieter', () => {
  const frame = (w: number, h: number, v: number) => Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.alloc(w * h, v)]);
  const fr = parsePgmFrames(Buffer.concat([frame(4, 3, 7), frame(2, 2, 9)]));
  assert.deepEqual(fr.map((x) => [x.w, x.h, x.px[0]]), [[4, 3, 7], [2, 2, 9]]);
  assert.equal(pickCorner({ 'top-left': 30, 'top-right': 28, 'bottom-left': 32, 'bottom-right': 31 }, 'bottom-left'), 'bottom-left');
  assert.equal(pickCorner({ 'top-left': 30, 'top-right': 5, 'bottom-left': 32, 'bottom-right': 31 }, 'bottom-left'), 'top-right');
  assert.equal(pickCorner({ 'top-left': 1, 'top-right': 0, 'bottom-left': 2, 'bottom-right': 1 }, 'bottom-left'), 'bottom-left');
});

