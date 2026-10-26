/**
 * "What's new" in PUSH. The newest entry first. When a server starts with an entry
 * that was not announced yet, every device that allowed notifications (customers
 * and the owner) gets one notification about it, and the app shows it once.
 * Add an entry here for each update customers should hear about.
 */
export interface Release {
  /** Stable and unique, e.g. "2026-10-26-telegram". */
  id: string;
  date: string;
  title: string;
  items: string[];
}

export const RELEASES: Release[] = [
  {
    id: '2026-10-26-telegram',
    date: '2026-10-26',
    title: 'חדש ב‑PUSH: טלגרם, תזמון ועוד',
    items: [
      'טלגרם: מחברים בוט במסך "חיבור", וכל הודעה מקבוצת השליטה יוצאת גם לערוצים שלכם',
      'תזמון: כותבים בשורה הראשונה "תזמון (12:20)" וההודעה יוצאת בשעה הזו',
      'שליחה מהירה פי שניים ב‑WhatsApp',
      'התראות לטלפון כשהמספר מתנתק או כשיש עדכון',
      'האפליקציה בטלפון ו"זכור אותי" בכניסה',
    ],
  },
];

export const latestRelease = (): Release | undefined => RELEASES[0];
