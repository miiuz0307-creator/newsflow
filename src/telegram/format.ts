/**
 * WhatsApp formatting → Telegram (HTML parse mode).
 *
 * WhatsApp marks text with *bold*, _italic_, ~strike~, `code`, ```block``` and "> " quotes.
 * Telegram shows those characters as they are unless the text is sent with formatting, so a
 * bold line in the WhatsApp control group reached Telegram with the stars showing. This turns
 * the WhatsApp marks into Telegram HTML; everything else is escaped and stays as typed.
 *
 * A mark counts the way WhatsApp counts it: it opens after a space, line start or punctuation,
 * closes before one, has no space just inside, and stays on one line. Links are left alone
 * (so an underscore in a URL is not italic). If Telegram still refuses the result, the
 * sender falls back to the plain text, so a message is never lost over formatting.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string, mark: string, tag: string): string {
  const m = mark === '*' ? '\\*' : mark;
  const re = new RegExp(`(?<=^|[\\s\\p{P}\\p{S}])${m}(?!\\s)([^\\n${m}]*?[^\\s${m}])${m}(?=$|[\\s\\p{P}\\p{S}])`, 'gmu');
  return s.replace(re, (_all, body: string) => `<${tag}>${body}</${tag}>`);
}

/** True when the text has something worth sending as formatted text. */
export function hasWhatsAppFormatting(text: string): boolean {
  return /[*_~`]|^>\s/m.test(text);
}

export function waToTelegramHtml(text: string): string {
  const keep: string[] = [];
  const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = text.replace(/\u0000/g, '');
  s = s.replace(/```([\s\S]+?)```/g, (_a, c: string) => hold(`<pre>${esc(c.replace(/^\n|\n$/g, ''))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_a, c: string) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, (u) => hold(esc(u)));
  s = esc(s);
  s = inline(s, '*', 'b');
  s = inline(s, '_', 'i');
  s = inline(s, '~', 's');
  // "> " at the start of consecutive lines: one quote block.
  const lines = s.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^&gt; ?/.test(lines[i]!)) {
      const q: string[] = [];
      while (i < lines.length && /^&gt; ?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^&gt; ?/, ''));
      i--;
      out.push(`<blockquote>${q.join('\n')}</blockquote>`);
    } else out.push(lines[i]!);
  }
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_a, n: string) => keep[Number(n)] ?? '');
}
