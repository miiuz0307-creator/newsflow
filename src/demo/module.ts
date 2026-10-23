/**
 * Demo-only API: lets the dashboard act as the customer in the SIMULATED
 * control group (post, edit, "delete for everyone"), and shows what each
 * simulated group looks like. Registered only by the demo server, and only
 * for the demo customer's own tenant.
 */
import type { FakeWaNetwork } from '../wa/fakeNetwork.js';
import { HttpError, type ApiServer } from '../api/server.js';

export const DEMO = {
  linked: '972500009001', // the simulated number connected to PUSH
  customer: '972500009002', // the simulated customer's phone
  controlJid: '120300000000000001@g.us',
  // Simulated group sizes; simulated members read new messages over the following minute.
  targets: [
    { title: 'חדשות חיפה', jid: '120300000000000011@g.us', members: 214 },
    { title: 'חדשות הקריות', jid: '120300000000000012@g.us', members: 168 },
    { title: 'חדשות נהריה', jid: '120300000000000013@g.us', members: 97 },
    { title: 'עדכוני כבישים צפון', jid: '120300000000000014@g.us', members: 256 },
    { title: 'מבזקים גליל', jid: '120300000000000015@g.us', members: 131 },
  ],
};

export function demoModule(o: { net: FakeWaNetwork; tenantId: string }) {
  return (api: ApiServer) => {
    const mine = (tenantId: string) => {
      if (tenantId !== o.tenantId) throw new HttpError(403, 'forbidden', 'הדמו זמין לחשבון הדמו בלבד');
    };
    const text = (v: unknown) => {
      const t = String(v ?? '').trim();
      if (!t) throw new HttpError(400, 'empty', 'יש לכתוב טקסט');
      return t.slice(0, 2000);
    };
    const HE: Record<string, string> = {
      window_closed: 'עברו יותר מ-15 דקות: WhatsApp כבר לא מאפשר לערוך את ההודעה הזו',
      not_found: 'ההודעה לא נמצאה (אולי כבר נמחקה)',
      forbidden: 'אין הרשאה לפעולה הזו',
    };
    const run = (fn: () => unknown) => {
      try {
        return fn();
      } catch (e) {
        const kind = (e as { kind?: string }).kind;
        throw new HttpError(409, 'not_allowed', (kind && HE[kind]) || (e as Error).message);
      }
    };

    api.on('GET', '/v1/demo/state', true, async ({ auth }) => {
      mine(auth!.tenantId);
      const view = (jid: string) => o.net.groupLog(jid).slice(-30).map((e) => ({
        id: e.id,
        text: e.content.text ?? '',
        fromPush: e.from === DEMO.linked,
        at: e.at,
        edited: !!e.editedAt,
        deleted: !!e.deleted,
      }));
      return {
        control: { title: 'קבוצת שליטה — PUSH', messages: view(DEMO.controlJid) },
        groups: DEMO.targets.map((g) => ({ title: g.title, messages: view(g.jid) })),
      };
    });

    api.on('POST', '/v1/demo/post', true, async ({ auth, body }) => {
      mine(auth!.tenantId);
      const t = text(body.text);
      return { id: run(() => o.net.humanPost(DEMO.customer, DEMO.controlJid, { kind: 'text', text: t })) };
    });

    api.on('POST', '/v1/demo/edit', true, async ({ auth, body }) => {
      mine(auth!.tenantId);
      const t = text(body.text);
      run(() => o.net.humanEdit(DEMO.customer, DEMO.controlJid, String(body.id ?? ''), { kind: 'text', text: t }));
      return { edited: true };
    });

    api.on('POST', '/v1/demo/delete', true, async ({ auth, body }) => {
      mine(auth!.tenantId);
      run(() => o.net.humanDeleteForEveryone(DEMO.customer, DEMO.controlJid, String(body.id ?? '')));
      return { deleted: true };
    });

    api.on('POST', '/v1/demo/lose-ack', true, async ({ auth }) => {
      mine(auth!.tenantId);
      o.net.loseNextAck(DEMO.linked);
      return { armed: true };
    });
  };
}
