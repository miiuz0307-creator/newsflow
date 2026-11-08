/**
 * IndexNow: tells Bing (and the other engines that share IndexNow: Yandex, Seznam, Naver)
 * which public pages exist, without any account. Google does not take part in IndexNow; for
 * Google the site is submitted in Search Console (see GOOGLE_SITE_VERIFICATION).
 *
 * The key (INDEXNOW_KEY, 8-128 letters/digits/dashes) is served at /<key>.txt to prove the
 * site is ours. Pages are submitted once per distinct page list: a deploy that changes no
 * page sends nothing.
 */
import { createHash } from 'node:crypto';
import type { ApiServer } from './server.js';

export const INDEXNOW_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

/** GET /<key>.txt answers with the key (only that exact path). */
export function indexNowKeyModule(key: string | undefined) {
  return (api: ApiServer) => {
    if (!key || !INDEXNOW_KEY_RE.test(key)) return;
    api.on('GET', `/${key}.txt`, false, async ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      res.end(key);
      return undefined;
    });
  };
}

export interface IndexNowStore { get(): Promise<string | null>; set(v: string): Promise<void> }

/** Submits the pages if the list changed since the last successful submission. Returns what happened. */
export async function submitIndexNow(o: {
  origin: string; key: string; paths: string[]; store: IndexNowStore;
  fetchImpl?: typeof fetch; endpoint?: string;
}): Promise<'sent' | 'unchanged' | 'skipped' | `failed:${string}`> {
  if (!INDEXNOW_KEY_RE.test(o.key) || !/^https:\/\/[a-z0-9.-]+$/i.test(o.origin)) return 'skipped';
  const urls = o.paths.map((p) => `${o.origin}${p}`);
  const digest = createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 32);
  if ((await o.store.get()) === digest) return 'unchanged';
  const host = new URL(o.origin).host;
  const r = await (o.fetchImpl ?? fetch)(o.endpoint ?? 'https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key: o.key, keyLocation: `${o.origin}/${o.key}.txt`, urlList: urls }),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200 && r.status !== 202) return `failed:${r.status}`;
  await o.store.set(digest);
  return 'sent';
}
