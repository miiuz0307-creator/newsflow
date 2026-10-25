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
  /** The customer's choice (a corner or the center); smart placement may also pass an edge middle. */
  position: Placement;
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

/**
 * Where the logo can go. The customer picks a corner or the center; smart placement may
 * also use the middle of an edge when every corner would cover something.
 */
export type Placement = LogoPosition | 'top-center' | 'bottom-center' | 'middle-right' | 'middle-left';

function overlayXY(p: Placement): [string, string] {
  const m = `W*${MARGIN}`;
  switch (p) {
    case 'top-left': return [m, m];
    case 'top-right': return [`W-w-${m}`, m];
    case 'bottom-left': return [m, `H-h-${m}`];
    case 'bottom-right': return [`W-w-${m}`, `H-h-${m}`];
    case 'center': return ['(W-w)/2', '(H-h)/2'];
    case 'top-center': return ['(W-w)/2', m];
    case 'bottom-center': return ['(W-w)/2', `H-h-${m}`];
    case 'middle-right': return [`W-w-${m}`, '(H-h)/2'];
    case 'middle-left': return [m, '(H-h)/2'];
  }
}

/** The ffmpeg filter graph: scale the logo to a share of the video's width, fade it, place it. */
export function logoFilter(s: { position: Placement; sizePct: number; opacityPct: number }, kind: 'video' | 'image'): string {
  const size = Math.min(40, Math.max(3, Math.round(s.sizePct * 10) / 10)) / 100;
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

type Frame = { w: number; h: number; px: Uint8Array };
const CORNERS: Placement[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES: Placement[] = ['top-center', 'bottom-center', 'middle-left', 'middle-right'];
/** Analysis width: big enough that ordinary caption text still shows as text. */
export const ANALYSIS_WIDTH = 480;
/** A pixel is "detail" (text edge, face, texture) above this local contrast (0–510). */
const EDGE_T = 40;

/** Per frame: a summed-area table of "detail" pixels, so any box is counted in O(1). */
function detailTables(frames: Frame[]) {
  return frames.map((f) => {
    const t = new Uint32Array((f.w + 1) * (f.h + 1));
    for (let y = 0; y < f.h; y++) {
      let row = 0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x, v = f.px[i]!;
        const g = (x + 1 < f.w ? Math.abs(f.px[i + 1]! - v) : 0) + (y + 1 < f.h ? Math.abs(f.px[i + f.w]! - v) : 0);
        row += g > EDGE_T ? 1 : 0;
        t[(y + 1) * (f.w + 1) + x + 1] = t[y * (f.w + 1) + x + 1]! + row;
      }
    }
    return { f, t };
  });
}

function boxOf(p: Placement, fw: number, fh: number, bw: number, bh: number): [number, number] {
  const m = Math.round(fw * MARGIN), cx = Math.round((fw - bw) / 2), cy = Math.round((fh - bh) / 2);
  switch (p) {
    case 'top-left': return [m, m];
    case 'top-right': return [fw - bw - m, m];
    case 'bottom-left': return [m, fh - bh - m];
    case 'bottom-right': return [fw - bw - m, fh - bh - m];
    case 'center': return [cx, cy];
    case 'top-center': return [cx, m];
    case 'bottom-center': return [cx, fh - bh - m];
    case 'middle-left': return [m, cy];
    case 'middle-right': return [fw - bw - m, cy];
  }
}

/**
 * Share of "detail" pixels under (and just around) the logo at a placement, 0–1. The worst
 * frame counts most: a caption shown for a few seconds must not end up under the logo.
 */
export function placementScore(tables: ReturnType<typeof detailTables>, p: Placement, sizePct: number, logoAspect: number): number {
  let max = 0, sum = 0;
  for (const { f, t } of tables) {
    const bw = Math.max(2, Math.round(f.w * sizePct / 100));
    const bh = Math.max(2, Math.min(f.h - 2, Math.round(bw / Math.max(0.1, logoAspect))));
    const [bx, by] = boxOf(p, f.w, f.h, bw, bh);
    const pad = Math.round(f.w * 0.015);
    const x0 = Math.max(0, bx - pad), y0 = Math.max(0, by - pad), x1 = Math.min(f.w, bx + bw + pad), y1 = Math.min(f.h, by + bh + pad);
    const W = f.w + 1;
    const n = t[y1 * W + x1]! - t[y0 * W + x1]! - t[y1 * W + x0]! + t[y0 * W + x0]!;
    const share = n / Math.max(1, (x1 - x0) * (y1 - y0));
    max = Math.max(max, share);
    sum += share;
  }
  return tables.length ? 0.6 * max + 0.4 * (sum / tables.length) : 0;
}

export interface SmartChoice { position: Placement; sizePct: number; score: number; preferredScore: number }

/**
 * Picks where (and, if needed, how small) the logo should be so it covers the least.
 * The customer's corner is kept when it covers (almost) nothing; otherwise the other
 * corners, then the middles of the edges, are tried; when everything is busy the logo
 * may shrink to 80% or 65% of its size rather than sit on text.
 */
export function choosePlacement(frames: Frame[], preferred: LogoPosition, sizePct: number, logoAspect: number): SmartChoice {
  const tables = detailTables(frames);
  const pref: Placement = preferred === 'center' ? 'bottom-left' : preferred;
  const prefScore = placementScore(tables, pref, sizePct, logoAspect);
  if (prefScore <= 0.015) return { position: pref, sizePct, score: prefScore, preferredScore: prefScore };
  let best: SmartChoice = { position: pref, sizePct, score: prefScore, preferredScore: prefScore };
  let bestCost = prefScore * 0.9;
  for (const [scale, penalty] of [[1, 0], [0.8, 0.012], [0.65, 0.03]] as const) {
    for (const p of [...CORNERS, ...EDGES]) {
      const size = sizePct * scale;
      const sc = placementScore(tables, p, size, logoAspect);
      const cost = sc * (p === pref ? 0.9 : EDGES.includes(p) ? 1.2 : 1) + penalty;
      if (cost < bestCost - 1e-9) { bestCost = cost; best = { position: p, sizePct: Math.round(size * 10) / 10, score: sc, preferredScore: prefScore }; }
    }
  }
  return best;
}

/** Looks at the photo, or a few frames across the video, and decides where the logo goes. */
export async function smartPlacement(file: string, logoFile: string, kind: 'video' | 'image', s: { position: LogoPosition; sizePct: number }): Promise<SmartChoice> {
  let duration = 0;
  if (kind === 'video') {
    const d = await runOut('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 20_000).catch(() => Buffer.from('0'));
    duration = Number(d.toString().trim()) || 0;
  }
  const dims = await runOut('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', logoFile], 20_000);
  const [lw, lh] = dims.toString().trim().split('x').map(Number);
  const aspect = lw && lh ? lw / lh : 2;
  const fps = kind === 'video' && duration > 0 ? Math.max(0.2, Math.min(4, 10 / duration)) : 1;
  const frames = parsePgmFrames(await runOut('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `${kind === 'video' ? `fps=${fps.toFixed(3)},` : ''}scale=${ANALYSIS_WIDTH}:-2,format=gray`, '-frames:v', kind === 'video' ? '10' : '1',
    '-f', 'image2pipe', '-vcodec', 'pgm', 'pipe:1'], 60_000));
  if (!frames.length) return { position: s.position, sizePct: s.sizePct, score: 0, preferredScore: 0 };
  return choosePlacement(frames, s.position, s.sizePct, aspect);
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
 * For the preview: decides the placement over the whole video (as when sending) and
 * returns one frame (at 1 s, or the middle of a shorter clip) with the logo on it.
 */
export async function previewVideo(video: Buffer, s: LogoSettings): Promise<{ data: Buffer; position: Placement; sizePct: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'push-prev-'));
  try {
    const input = path.join(dir, 'in.mp4'), frame = path.join(dir, 'frame.jpg'), logo = path.join(dir, `logo.${EXT[s.logoMime] ?? 'png'}`);
    await writeFile(input, video);
    await writeFile(logo, s.logo);
    const d = await runOut('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], 20_000).catch(() => Buffer.from('2'));
    const at = Math.min(1, (Number(d.toString().trim()) || 2) / 2);
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-q:v', '2', frame], 60_000);
    // A very short clip may have no frame at that point: take the first one.
    if (!(await readFile(frame).then((b) => b.length > 0, () => false))) {
      await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-q:v', '2', frame], 60_000);
    }
    const choice = s.smart ? await smartPlacement(input, logo, 'video', { position: s.position as LogoPosition, sizePct: s.sizePct }).catch(() => undefined) : undefined;
    const out = await applyLogo(await readFile(frame), 'image', { ...s, smart: false, position: choice?.position ?? s.position, sizePct: choice?.sizePct ?? s.sizePct }, 60_000);
    return { data: out.data, position: out.position, sizePct: out.sizePct };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Returns the media with the logo on it. Videos come back as H.264 MP4 (sound
 * copied unchanged), photos as JPEG.
 */
export async function applyLogo(media: Buffer, kind: 'video' | 'image', s: LogoSettings, timeoutMs = 240_000): Promise<{ data: Buffer; mimeType: string; position: Placement; sizePct: number; smart?: SmartChoice }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'push-logo-'));
  try {
    const input = path.join(dir, kind === 'video' ? 'in.mp4' : 'in.jpg');
    const logo = path.join(dir, `logo.${EXT[s.logoMime] ?? 'png'}`);
    const output = path.join(dir, kind === 'video' ? 'out.mp4' : 'out.jpg');
    await writeFile(input, media);
    await writeFile(logo, s.logo);
    // Smart position: decided per video; if the look fails, the chosen corner is used.
    const smart = s.smart ? await smartPlacement(input, logo, kind, { position: s.position as LogoPosition, sizePct: s.sizePct }).catch(() => undefined) : undefined;
    const position: Placement = smart?.position ?? s.position;
    const sizePct = smart?.sizePct ?? s.sizePct;
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-i', logo, '-filter_complex', logoFilter({ position, sizePct, opacityPct: s.opacityPct }, kind), '-map', '[out]'];
    const args = kind === 'video'
      ? [...common, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', output]
      : [...common, '-frames:v', '1', '-q:v', '2', output];
    await run(args, timeoutMs);
    return { data: await readFile(output), mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg', position, sizePct, ...(smart ? { smart } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
