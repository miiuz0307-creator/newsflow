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
  /**
   * Move the logo, per video, to the corner with the least going on (text, faces,
   * detail), so it does not cover anything. `position` is the preferred corner.
   */
  smart?: boolean;
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

function runOut(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited with ${code}: ${err.trim().slice(-300)}`)); });
  });
}

/** Grey frames as written by ffmpeg's PGM encoder ("P5\n<w> <h>\n255\n" + pixels), one after another. */
export function parsePgmFrames(buf: Buffer): { w: number; h: number; px: Uint8Array }[] {
  const frames: { w: number; h: number; px: Uint8Array }[] = [];
  let i = 0;
  const token = () => {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]!))) i++;
    const start = i;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]!))) i++;
    return buf.subarray(start, i).toString('latin1');
  };
  while (i < buf.length) {
    if (token() !== 'P5') break;
    const w = Number(token()), h = Number(token()); token(); // maxval
    i++; // the single whitespace before the pixels
    if (!w || !h || i + w * h > buf.length) break;
    frames.push({ w, h, px: buf.subarray(i, i + w * h) });
    i += w * h;
  }
  return frames;
}

/**
 * How busy each corner is where the logo would go: the average edge strength
 * (text and detail have strong edges, a plain sky or wall has almost none).
 */
export function cornerScores(frames: { w: number; h: number; px: Uint8Array }[], sizePct: number, logoAspect: number): Record<Exclude<LogoPosition, 'center'>, number> {
  const out = { 'top-right': 0, 'top-left': 0, 'bottom-right': 0, 'bottom-left': 0 };
  for (const f of frames) {
    const bw = Math.max(2, Math.round(f.w * sizePct / 100));
    const bh = Math.max(2, Math.min(f.h - 1, Math.round(bw / Math.max(0.1, logoAspect))));
    const m = Math.round(f.w * MARGIN);
    const boxes: Record<keyof typeof out, [number, number]> = {
      'top-left': [m, m], 'top-right': [f.w - bw - m, m], 'bottom-left': [m, f.h - bh - m], 'bottom-right': [f.w - bw - m, f.h - bh - m],
    };
    for (const k of Object.keys(boxes) as (keyof typeof out)[]) {
      const [x0, y0] = boxes[k];
      let sum = 0, n = 0;
      for (let y = Math.max(0, y0); y < Math.min(f.h - 1, y0 + bh); y++) {
        for (let x = Math.max(0, x0); x < Math.min(f.w - 1, x0 + bw); x++) {
          const v = f.px[y * f.w + x]!;
          sum += Math.abs(f.px[y * f.w + x + 1]! - v) + Math.abs(f.px[(y + 1) * f.w + x]! - v);
          n++;
        }
      }
      out[k] += n ? sum / n / frames.length : 0;
    }
  }
  return out;
}

/** Picks the corner that hides the least. The preferred corner wins unless another is clearly quieter. */
export function pickCorner(scores: Record<Exclude<LogoPosition, 'center'>, number>, preferred: LogoPosition): Exclude<LogoPosition, 'center'> {
  const pref = preferred === 'center' ? 'bottom-left' : preferred;
  if (scores[pref] < 4) return pref; // quiet enough: keep the customer's choice
  let best = pref;
  for (const k of Object.keys(scores) as (keyof typeof scores)[]) {
    if (scores[k] < scores[best] * 0.8) best = k;
  }
  return best;
}

/** Looks at a few frames of the video (or the photo) and returns the quietest corner. */
export async function chooseCorner(file: string, logoFile: string, kind: 'video' | 'image', s: Pick<LogoSettings, 'position' | 'sizePct'>): Promise<LogoPosition> {
  let duration = 0;
  if (kind === 'video') {
    const d = await runOut('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 20_000).catch(() => Buffer.from('0'));
    duration = Number(d.toString().trim()) || 0;
  }
  const dims = await runOut('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', logoFile], 20_000);
  const [lw, lh] = dims.toString().trim().split('x').map(Number);
  const aspect = lw && lh ? lw / lh : 2;
  const fps = kind === 'video' && duration > 0 ? Math.max(0.2, Math.min(4, 8 / duration)) : 1;
  const frames = parsePgmFrames(await runOut('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `${kind === 'video' ? `fps=${fps.toFixed(3)},` : ''}scale=160:-2,format=gray`, '-frames:v', kind === 'video' ? '8' : '1',
    '-f', 'image2pipe', '-vcodec', 'pgm', 'pipe:1'], 60_000));
  if (!frames.length) return s.position;
  return pickCorner(cornerScores(frames, s.sizePct, aspect), s.position);
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
export async function applyLogo(media: Buffer, kind: 'video' | 'image', s: LogoSettings, timeoutMs = 240_000): Promise<{ data: Buffer; mimeType: string; position: LogoPosition }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'push-logo-'));
  try {
    const input = path.join(dir, kind === 'video' ? 'in.mp4' : 'in.jpg');
    const logo = path.join(dir, `logo.${EXT[s.logoMime] ?? 'png'}`);
    const output = path.join(dir, kind === 'video' ? 'out.mp4' : 'out.jpg');
    await writeFile(input, media);
    await writeFile(logo, s.logo);
    // Smart position: decided per video; if the look fails, the chosen corner is used.
    const position = s.smart ? await chooseCorner(input, logo, kind, s).catch(() => s.position) : s.position;
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-i', logo, '-filter_complex', logoFilter({ ...s, position }, kind), '-map', '[out]'];
    const args = kind === 'video'
      ? [...common, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', output]
      : [...common, '-frames:v', '1', '-q:v', '2', output];
    await run(args, timeoutMs);
    return { data: await readFile(output), mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg', position };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
