/**
 * Self-hosted fonts (SIL Open Font License, files in public/fonts):
 * Secular One for headlines, IBM Plex Sans Hebrew for text. Served by the
 * API itself, so pages don't depend on Google Fonts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiServer } from './server.js';

const HEBREW = 'U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F';
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

function face(family: string, file: string, weight: number, range: string) {
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(/fonts/${file}) format("woff2");unicode-range:${range}}`;
}

/** @font-face rules for both families. */
export function fontFaceCss(): string {
  const out = [face('Secular One', 'secular-one-hebrew-400-normal.woff2', 400, HEBREW), face('Secular One', 'secular-one-latin-400-normal.woff2', 400, LATIN)];
  for (const w of [400, 500, 600, 700]) {
    out.push(face('IBM Plex Sans Hebrew', `ibm-plex-sans-hebrew-hebrew-${w}-normal.woff2`, w, HEBREW));
    out.push(face('IBM Plex Sans Hebrew', `ibm-plex-sans-hebrew-latin-${w}-normal.woff2`, w, LATIN));
  }
  return out.join('\n');
}

const FILE = /^[a-z0-9-]+\.woff2$/;
const cache = new Map<string, Buffer>();

/** GET /fonts/<file>.woff2 — only files that exist in public/fonts, cached for a year. */
export function fontsModule(root = process.env.APP_ROOT ?? process.cwd()) {
  const dir = path.join(root, 'public', 'fonts');
  return (api: ApiServer) => {
    api.on('GET', '/fonts/:file', false, async ({ params, res }) => {
      const file = params.file ?? '';
      if (!FILE.test(file)) {
        res.writeHead(404).end();
        return undefined;
      }
      let data = cache.get(file);
      if (!data) {
        try {
          data = await readFile(path.join(dir, file));
        } catch {
          res.writeHead(404).end();
          return undefined;
        }
        cache.set(file, data);
      }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
      res.end(data);
      return undefined;
    });
  };
}
