/**
 * Text helpers shared by filters, templates and duplicate detection.
 */
import { createHash } from 'node:crypto';

/** Hebrew points and cantillation marks (niqqud), U+0591–U+05C7. */
const NIQQUD = /[֑-ׇ]/g;
/** Invisible direction marks often pasted into Hebrew text. */
const BIDI = /[‎‏‪-‮⁦-⁩]/g;

/** Lowercases, strips niqqud, direction marks and extra whitespace — for matching, never for display. */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').replace(NIQQUD, '').replace(BIDI, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const INVITE_LINK = /(?:https?:\/\/)?(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|whatsapp\.com\/channel\/[A-Za-z0-9]+|wa\.me\/[0-9A-Za-z?=&]+|(?:t|telegram)\.me\/(?:joinchat\/|\+)?[A-Za-z0-9_\-]+)\S*/gi;

/** Removes group/channel invite links and tidies the leftover whitespace. */
export function removeInviteLinks(s: string): string {
  return s
    .replace(INVITE_LINK, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Stable fingerprint of a message's meaning, for duplicate detection across sources. */
export function contentFingerprint(text: string | undefined, media?: { mimeType: string; size?: number }): string {
  const t = normalizeForMatch(removeInviteLinks(text ?? ''));
  const m = media ? `${media.mimeType}:${media.size ?? '?'}` : '';
  return createHash('sha256').update(`${t}\u0000${m}`).digest('hex').slice(0, 32);
}

/** Cuts `s` to at most `max` characters (by code point), ending with an ellipsis. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  if (max <= 1) return chars.slice(0, max).join('');
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

export function codePointLength(s: string): number {
  return [...s].length;
}
