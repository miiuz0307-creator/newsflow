/**
 * "!סטטוס" at the start of a control-group message: the copies go up as the status of every
 * WhatsApp target group (WhatsApp's group status), not as chat messages. The command itself is
 * an instruction to Groupush and is never part of the copy.
 *
 * Accepted: "!סטטוס", "! סטטוס", "!status" (any case), alone on the first line or followed by
 * the text on the same line. It may come right after a "תזמון (12:20)" line.
 */
const COMMAND = /^[\s\u200e\u200f\u202a-\u202e]*[!！]\s*(?:סטטוס|status)(?=$|[\s:：\-–—])[\s:：\-–—]*/i;

export function parseStatusCommand(text: string | undefined): { status: boolean; rest: string } {
  const t = text ?? '';
  const m = COMMAND.exec(t);
  if (!m) return { status: false, rest: t };
  return { status: true, rest: t.slice(m[0].length) };
}
