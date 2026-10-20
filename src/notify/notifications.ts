/**
 * Customer notifications: turns connection and safety events into short
 * Hebrew messages stored for the app (and, once the app exists, pushed via
 * Firebase Cloud Messaging through the PushSender hook).
 */
import type { Sql } from '../db/pg.js';
import type { SafetyEvent } from '../delivery/safety.js';
import type { StatusEvent } from '../wa/connectionManager.js';

export interface Notice {
  tenantId: string;
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Delivery channel for push messages (FCM in production; a fake in tests). */
export interface PushSender {
  send(tenantId: string, n: Notice): Promise<void>;
}

/** Hebrew texts for each event. Kept here so the app and the server say the same thing. */
export function noticeForSafety(e: SafetyEvent): Notice | null {
  const base = { tenantId: e.tenantId, data: { accountId: e.accountId, ...e.detail } };
  switch (e.kind) {
    case 'account_blocked':
      return { ...base, kind: e.kind, title: 'המספר נחסם על ידי WhatsApp', body: 'השליחה מהמספר נעצרה. אין ניסיון חיבור אוטומטי. מומלץ לפנות לתמיכה לפני שמחברים מספר אחר.' };
    case 'logged_out':
      return { ...base, kind: e.kind, title: 'המספר נותק מהטלפון', body: 'המכשיר הוסר מרשימת המכשירים המקושרים. כדי להמשיך, יש לחבר את המספר מחדש.' };
    case 'replaced':
      return { ...base, kind: e.kind, title: 'החיבור הועבר למקום אחר', body: 'המספר חובר במקום אחר ולכן החיבור כאן נסגר. אפשר לחבר מחדש מהאפליקציה.' };
    case 'reconnect_exhausted':
      return { ...base, kind: e.kind, title: 'לא הצלחנו לחבר מחדש את המספר', body: 'אחרי כמה ניסיונות החיבור עדיין לא חזר. בדוק שהטלפון מחובר לאינטרנט, ונסה לחבר מחדש.' };
    case 'rate_limited':
      return { ...base, kind: e.kind, title: 'השליחה הואטה', body: 'WhatsApp ביקש להאט. השליחה מהמספר הושהתה ל־15 דקות כדי להגן עליו.' };
    case 'repeated_rate_limit':
      return { ...base, kind: e.kind, title: 'השליחה נעצרה להגנה על המספר', body: 'WhatsApp ביקש להאט פעמיים בשעה. השליחה נעצרה עד שנבדוק את המצב יחד. פנה לתמיכה.' };
    case 'consecutive_failures':
      return { ...base, kind: e.kind, title: 'השליחה נעצרה בגלל כשלים חוזרים', body: 'כמה שליחות ברצף נכשלו, ולכן השליחה מהמספר נעצרה. פנה לתמיכה.' };
    case 'target_forbidden':
      return { ...base, kind: e.kind, title: 'אין הרשאה לשלוח לאחת הקבוצות', body: 'ייתכן שהוסרת מהקבוצה או שרק מנהלים יכולים לשלוח בה. כדאי לעדכן את המסלול.' };
    default:
      return null;
  }
}

export function noticeForStatus(e: StatusEvent): Notice | null {
  const s = e.state;
  if (s.status === 'connected' && e.previous && e.previous !== 'connected' && e.previous !== 'connecting' && e.previous !== 'reconnecting') {
    return { tenantId: s.tenantId, kind: 'connected', title: 'המספר מחובר', body: 'החיבור הצליח. אפשר להגדיר מסלולי הפצה.', data: { accountId: s.accountId } };
  }
  return null;
}

export class NotificationService {
  constructor(private readonly sql: Sql, private readonly push?: PushSender) {}

  async notify(n: Notice | null): Promise<void> {
    if (!n) return;
    await this.sql.query('INSERT INTO notifications (tenant_id, kind, title, body, data) VALUES ($1, $2, $3, $4, $5)', [n.tenantId, n.kind, n.title, n.body, n.data ?? {}]);
    await this.push?.send(n.tenantId, n).catch(() => {});
  }
}
