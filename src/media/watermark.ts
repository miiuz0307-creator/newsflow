/**
 * Burns a customer's logo into a video or photo with ffmpeg, once per message,
 * before the copies are sent. The original is used if anything goes wrong, so
 * a logo problem never stops a distribution.
 *
 * ffmpeg runs with an argument list (no shell) on files in a private temp dir.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type LogoPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';
export const LOGO_POSITIONS: LogoPosition[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];

export interface LogoSettings {
  logo: Buffer;
  logoMime: string;
  position: LogoPosition;
  /** Logo width as a percentage of the video's width (5–40). */
  sizePct: number;
  /** 20–100; 100 = fully opaque. */
  opacityPct: number;
}

const MARGIN = 0.03; // of the video's width, from the edges

function overlayXY(p: LogoPosition): [string, string] {
  const m = `W*${MARGIN}`;
  switch (p) {
    case 'top-left': return [m, m];
    case 'top-right': return [`W-w-${m}`, m];
    case 'bottom-left': return [m, `H-h-${m}`];
    case 'bottom-right': return [`W-w-${m}`, `H-h-${m}`];
    case 'center': return ['(W-w)/2', '(H-h)/2'];
  }
}

/** The ffmpeg filter graph: scale the logo to a share of the video's width, fade it, place it. */
export function logoFilter(s: Pick<LogoSettings, 'position' | 'sizePct' | 'opacityPct'>, kind: 'video' | 'image'): string {
  const size = Math.min(40, Math.max(5, Math.round(s.sizePct))) / 100;
  const alpha = Math.min(100, Math.max(20, Math.round(s.opacityPct))) / 100;
  const [x, y] = overlayXY(s.position);
  // scale2ref: iw/ih are the reference (the video), mdar is the logo's own aspect ratio.
  return `[1:v][0:v]scale2ref=w=iw*${size}:h=ow/mdar[lg][base];[lg]format=rgba,colorchannelmixer=aa=${alpha}[lg2];` +
    `[base][lg2]overlay=x=${x}:y=${y}${kind === 'video' ? ',format=yuv420p' : ''}[out]`;
}

function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

let available: Promise<boolean> | undefined;
/** Whether ffmpeg is installed on this server. */
export function ffmpegAvailable(): Promise<boolean> {
  available ??= new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  return available;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Returns the media with the logo on it. Videos come back as H.264 MP4 (sound
 * copied unchanged), photos as JPEG.
 */
export async function applyLogo(media: Buffer, kind: 'video' | 'image', s: LogoSettings, timeoutMs = 240_000): Promise<{ data: Buffer; mimeType: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'push-logo-'));
  try {
    const input = path.join(dir, kind === 'video' ? 'in.mp4' : 'in.jpg');
    const logo = path.join(dir, `logo.${EXT[s.logoMime] ?? 'png'}`);
    const output = path.join(dir, kind === 'video' ? 'out.mp4' : 'out.jpg');
    await writeFile(input, media);
    await writeFile(logo, s.logo);
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-i', logo, '-filter_complex', logoFilter(s, kind), '-map', '[out]'];
    const args = kind === 'video'
      ? [...common, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', output]
      : [...common, '-frames:v', '1', '-q:v', '2', output];
    await run(args, timeoutMs);
    return { data: await readFile(output), mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
