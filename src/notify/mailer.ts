/**
 * Sending email (only short service mails, such as the password reset code).
 *
 * Works with one of two providers, chosen by which key the server has:
 *   RESEND_API_KEY  (resend.com; the sender must be on a domain verified there)
 *   BREVO_API_KEY   (brevo.com; the sender can be a single verified address)
 * MAIL_FROM is the sender, e.g. "Groupush <hello@groupush.co.il>".
 * Without a key, email is off and the app says so instead of pretending to send.
 */
export interface Mail { to: string; subject: string; text: string; html: string }
export type Mailer = (m: Mail) => Promise<void>;

function parseFrom(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { ...(m[1] ? { name: m[1] } : {}), email: m[2]!.trim() } : { email: from.trim() };
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Mailer | undefined {
  const from = (env.MAIL_FROM ?? '').trim();
  if (!from || !/@/.test(from)) return undefined;
  if (env.RESEND_API_KEY) {
    return async (m) => {
      const r = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`resend ${r.status}`);
    };
  }
  if (env.BREVO_API_KEY) {
    return async (m) => {
      const r = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: parseFrom(from), to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`brevo ${r.status}`);
    };
  }
  return undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The reset-code email (Hebrew, right to left). */
export function resetCodeMail(to: string, code: string): Mail {
  const text = `קוד השחזור שלכם ב‑Groupush: ${code}\n\nהקוד תקף ל‑15 דקות. אם לא ביקשתם לשחזר סיסמה, אפשר להתעלם מההודעה הזאת.`;
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;color:#0A1B33;line-height:1.6">
<p style="font-size:20px;font-weight:bold;margin:0 0 12px">Groupush</p>
<p>קוד השחזור שלכם:</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:bold;margin:8px 0 16px">${esc(code)}</p>
<p>הקוד תקף ל‑15 דקות. אם לא ביקשתם לשחזר סיסמה, אפשר להתעלם מההודעה הזאת.</p>
</div>`;
  return { to, subject: `קוד שחזור סיסמה: ${code}`, text, html };
}
