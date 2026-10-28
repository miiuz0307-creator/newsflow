/**
 * PUSH customer API: distribution history with the status of every copy,
 * manual retry, platform capabilities, and the basic dashboard page.
 *
 * Everything runs inside the caller's tenant (RLS). A copy whose outcome is
 * unknown ("ממתין לאימות") is resent only when the customer confirms it is
 * not in the group — otherwise it could appear twice.
 */
import { randomBytes } from 'node:crypto';
import { CAPABILITIES } from '../../core/types.js';
import { parseControlSettings } from '../../routing/router.js';
import { stripSchedule } from '../../routing/schedule.js';
import { applyLogo, ffmpegAvailable, LOGO_POSITIONS, previewVideo, type LogoPosition } from '../../media/watermark.js';
import { HttpError, type ApiServer } from '../server.js';
import { dashboardHtml } from '../dashboard.js';
import { appManifest, appServiceWorker, installHtml } from '../installPage.js';
import { adminIcon } from '../adminIcon.js';
import { fontFaceCss } from '../fonts.js';
import { publicOrigin, siteHtml } from '../site.js';

interface DistRow {
  scheduled_at: Date | null;
  platform: string;
  account_id: string;
  chat_id: string;
  source_message_id: string;
  created_at: Date;
  source_title: string | null;
  text: string | null;
  kind: string | null;
  version: number | null;
  deleted: boolean | null;
  targets: number;
  sent: number;
  failed: number;
  unknown: number;
  pending: number;
  cancelled: number;
  skipped: number;
  edits_sent: number;
  edits_failed: number;
  deletes_sent: number;
  deletes_failed: number;
  reads: number;
}

interface CopyRow {
  scheduled_at: Date | null;
  id: string;
  target_platform: string;
  target_chat_id: string;
  title: string | null;
  status: string;
  error_kind: string | null;
  last_error: string | null;
  sent_at: Date | null;
  attempts: number;
  version: number;
  edit_status: string | null;
  edit_version: number | null;
  edit_error: string | null;
  edit_job_id: string | null;
  delete_status: string | null;
  delete_error: string | null;
  delete_job_id: string | null;
  read_count: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pushModule(opts: { onRoutesChanged?: () => void } = {}) {
  return (api: ApiServer) => {
    // Control-group settings shown in the app: the fixed signature and the report mode.
    api.on('GET', '/v1/push/settings', true, async ({ auth }) =>
      api.tenantTx(auth!, async (c) => {
        const r = await c.query<{ id: string; name: string; control: Record<string, unknown> }>(
          `SELECT id, name, control FROM routes WHERE control IS NOT NULL ORDER BY created_at`);
        const first = r.rows[0]?.control ?? {};
        const src = await c.query<{ route_id: string; platform: string; account_id: string; chat_id: string }>(
          `SELECT s.route_id, s.platform, s.account_id, s.chat_id FROM route_sources s JOIN routes r ON r.id = s.route_id WHERE r.control IS NOT NULL`);
        const tgt = await c.query<{ route_id: string; platform: string; account_id: string; chat_id: string; title: string | null }>(
          `SELECT t.route_id, t.platform, t.account_id, t.chat_id, t.title FROM route_targets t JOIN routes r ON r.id = t.route_id WHERE r.control IS NOT NULL ORDER BY t.title`);
        const ref = (x: { platform: string; account_id: string; chat_id: string }) => ({ platform: x.platform, accountId: x.account_id, chatId: x.chat_id });
        return {
          controlGroups: r.rows.map((x) => ({
            id: x.id, name: x.name, control: x.control,
            source: src.rows.filter((y) => y.route_id === x.id).map(ref)[0] ?? null,
            targets: tgt.rows.filter((y) => y.route_id === x.id).map((y) => ({ ...ref(y), title: y.title })),
          })),
          signature: (first.signature as string | undefined) ?? '',
          reportMode: (first.reportMode as string | undefined) ?? 'summary',
          reactions: first.reactions !== false,
        };
      }));

    api.on('PUT', '/v1/push/settings', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      const out = await api.tenantTx(auth!, async (c) => {
        const r = await c.query<{ id: string; control: Record<string, unknown> }>(`SELECT id, control FROM routes WHERE control IS NOT NULL`);
        if (!r.rowCount) throw new HttpError(404, 'no_control_group', 'עדיין אין קבוצת שליטה בחשבון');
        for (const row of r.rows) {
          let next;
          try {
            next = parseControlSettings({
              ...row.control,
              ...(body.signature !== undefined ? { signature: String(body.signature ?? '') } : {}),
              ...(body.reportMode !== undefined ? { reportMode: body.reportMode } : {}),
              ...(body.reactions !== undefined ? { reactions: body.reactions !== false } : {}),
            });
          } catch (e) {
            throw new HttpError(400, 'bad_settings', (e as Error).message);
          }
          await c.query('UPDATE routes SET control = $2, updated_at = now() WHERE id = $1', [row.id, next]);
        }
        await api.audit(c, auth!, 'push.settings_saved', String(r.rowCount));
        return { saved: r.rowCount };
      });
      opts.onRoutesChanged?.();
      return out;
    });


    // ---- Logo burned into videos (and optionally photos).
    const LOGO_MAX = 1024 * 1024;
    const sniff = (b: Buffer): string | null =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
        : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
          : b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
    type BrandRow = { logo_b64: string; logo_mime: string; position: string; size_pct: number; opacity_pct: number; apply_video: boolean; apply_image: boolean; smart_position: boolean; updated_at: Date };
    const brandView = (b: BrandRow | undefined, available: boolean) => ({
      logo: b ? `data:${b.logo_mime};base64,${b.logo_b64}` : null,
      position: b?.position ?? 'bottom-left',
      sizePct: b?.size_pct ?? 18,
      opacityPct: b?.opacity_pct ?? 85,
      applyVideo: b?.apply_video ?? true,
      applyImage: b?.apply_image ?? false,
      smartPosition: b?.smart_position ?? false,
      // Whether this server can burn logos in (ffmpeg installed).
      available,
    });

    api.on('GET', '/v1/push/logo', true, async ({ auth }) => {
      const r = await api.tenantTx(auth!, (c) => c.query<BrandRow>('SELECT * FROM tenant_branding'));
      return brandView(r.rows[0], await ffmpegAvailable());
    });

    api.on('PUT', '/v1/push/logo', true, async ({ auth, body }) => {
      api.requireRole(auth!, 'owner', 'admin');
      const position = String(body.position ?? 'bottom-left');
      if (!LOGO_POSITIONS.includes(position as LogoPosition)) throw new HttpError(400, 'bad_position', 'מיקום לא מוכר');
      const sizePct = Math.round(Number(body.sizePct ?? 18));
      const opacityPct = Math.round(Number(body.opacityPct ?? 85));
      if (!(sizePct >= 5 && sizePct <= 40)) throw new HttpError(400, 'bad_size', 'הגודל חייב להיות בין 5% ל‑40% מרוחב הסרטון');
      if (!(opacityPct >= 20 && opacityPct <= 100)) throw new HttpError(400, 'bad_opacity', 'השקיפות חייבת להיות בין 20% ל‑100%');
      let logo: { b64: string; mime: string } | undefined;
      if (body.logo !== undefined && body.logo !== null) {
        const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.logo));
        if (!m) throw new HttpError(400, 'bad_logo', 'הלוגו צריך להיות קובץ PNG, JPG או WEBP');
        const bytes = Buffer.from(m[2]!, 'base64');
        if (bytes.length > LOGO_MAX) throw new HttpError(400, 'logo_too_large', 'הלוגו גדול מדי (עד 1MB)');
        const mime = sniff(bytes);
        if (!mime) throw new HttpError(400, 'bad_logo', 'הקובץ אינו תמונה תקינה (PNG, JPG או WEBP)');
        logo = { b64: bytes.toString('base64'), mime };
      }
      const out = await api.tenantTx(auth!, async (c) => {
        const cur = await c.query<BrandRow>('SELECT * FROM tenant_branding');
        if (!cur.rowCount && !logo) throw new HttpError(400, 'no_logo', 'בחרו קובץ לוגו');
        const r = await c.query<BrandRow>(
          `INSERT INTO tenant_branding (tenant_id, logo_b64, logo_mime, position, size_pct, opacity_pct, apply_video, apply_image, smart_position, updated_at)
           VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (tenant_id) DO UPDATE SET logo_b64 = EXCLUDED.logo_b64, logo_mime = EXCLUDED.logo_mime, position = EXCLUDED.position,
             size_pct = EXCLUDED.size_pct, opacity_pct = EXCLUDED.opacity_pct, apply_video = EXCLUDED.apply_video,
             apply_image = EXCLUDED.apply_image, smart_position = EXCLUDED.smart_position, updated_at = now()
           RETURNING *`,
          [logo?.b64 ?? cur.rows[0]!.logo_b64, logo?.mime ?? cur.rows[0]!.logo_mime, position, sizePct, opacityPct, body.applyVideo !== false, body.applyImage === true, body.smartPosition === true]);
        await api.audit(c, auth!, 'push.logo_saved', position);
        return r.rows[0];
      });
      return brandView(out, await ffmpegAvailable());
    }, { bodyLimit: 2 * 1024 * 1024 });

    // Try the logo on the customer's own photo (or a frame of their video) without sending anything.
    api.on('POST', '/v1/push/logo/preview', true, async ({ auth, body }) => {
      const isVideo = /^data:video\//.test(String(body.media ?? ''));
      const m = (isVideo ? /^data:video\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/ : /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/).exec(String(body.media ?? ''));
      if (!m) throw new HttpError(400, 'bad_media', 'צריך תמונה (JPG, PNG או WEBP) או סרטון');
      const media = Buffer.from(m[1]!, 'base64');
      if (!isVideo && !sniff(media)) throw new HttpError(400, 'bad_media', 'הקובץ אינו תמונה תקינה');
      if (!(await ffmpegAvailable())) throw new HttpError(503, 'unavailable', 'בשרת הזה אי אפשר להוסיף לוגו');
      const cur = (await api.tenantTx(auth!, (c) => c.query<BrandRow>('SELECT * FROM tenant_branding'))).rows[0];
      let logo = cur ? { data: Buffer.from(cur.logo_b64, 'base64'), mime: cur.logo_mime } : undefined;
      if (body.logo) {
        const lm = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.logo));
        const bytes = lm ? Buffer.from(lm[2]!, 'base64') : undefined;
        const mime = bytes && bytes.length <= LOGO_MAX ? sniff(bytes) : null;
        if (!bytes || !mime) throw new HttpError(400, 'bad_logo', 'הלוגו צריך להיות קובץ PNG, JPG או WEBP');
        logo = { data: bytes, mime };
      }
      if (!logo) throw new HttpError(400, 'no_logo', 'בחרו קובץ לוגו');
      const position = LOGO_POSITIONS.includes(body.position as LogoPosition) ? body.position as LogoPosition : (cur?.position as LogoPosition) ?? 'bottom-left';
      const sizePct = Math.min(40, Math.max(5, Number(body.sizePct ?? cur?.size_pct ?? 18)));
      const opacityPct = Math.min(100, Math.max(20, Number(body.opacityPct ?? cur?.opacity_pct ?? 85)));
      const smart = body.smartPosition !== undefined ? body.smartPosition === true : !!cur?.smart_position;
      const settings = { logo: logo.data, logoMime: logo.mime, position, sizePct, opacityPct, smart };
      const out = isVideo
        ? await previewVideo(media, settings).catch(() => { throw new HttpError(400, 'bad_media', 'לא הצלחנו לקרוא את הסרטון'); })
        : await applyLogo(media, 'image', settings, 60_000);
      return { image: `data:image/jpeg;base64,${out.data.toString('base64')}`, position: out.position, sizePct: out.sizePct, moved: smart && out.position !== position };
    }, { bodyLimit: 14 * 1024 * 1024 });

    api.on('DELETE', '/v1/push/logo', true, async ({ auth }) => {
      api.requireRole(auth!, 'owner', 'admin');
      await api.tenantTx(auth!, async (c) => {
        await c.query('DELETE FROM tenant_branding');
        await api.audit(c, auth!, 'push.logo_removed', '');
      });
      return { removed: true };
    });

    api.on('GET', '/v1/capabilities', false, async () => CAPABILITIES);

    // Recent distributions (last 30 days), newest first.
    api.on('GET', '/v1/distributions', true, async ({ auth, req }) => {
      const limit = Math.min(Math.max(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? 50) || 50, 1), 200);
      return api.tenantTx(auth!, async (c) => {
        const r = await c.query<DistRow>(
          `WITH d AS (
             SELECT source->>'platform' AS platform, source->>'accountId' AS account_id, source->>'chatId' AS chat_id, source_message_id,
                    min(created_at) AS created_at,
                    (array_agg(content->>'text' ORDER BY id) FILTER (WHERE action = 'send'))[1] AS text,
                    (array_agg(content->>'kind' ORDER BY id) FILTER (WHERE action = 'send'))[1] AS kind,
                    count(*) FILTER (WHERE action = 'send')::int AS targets,
                    count(*) FILTER (WHERE action = 'send' AND status = 'sent')::int AS sent,
                    count(*) FILTER (WHERE action = 'send' AND status = 'failed')::int AS failed,
                    count(*) FILTER (WHERE action = 'send' AND status = 'unknown')::int AS unknown,
                    count(*) FILTER (WHERE action = 'send' AND status IN ('queued', 'sending', 'pending_approval'))::int AS pending,
                    count(*) FILTER (WHERE action = 'send' AND status = 'cancelled')::int AS cancelled,
                    count(*) FILTER (WHERE action = 'send' AND status = 'skipped')::int AS skipped,
                    count(*) FILTER (WHERE action = 'edit' AND status = 'sent')::int AS edits_sent,
                    count(*) FILTER (WHERE action = 'edit' AND status IN ('failed', 'unknown'))::int AS edits_failed,
                    count(*) FILTER (WHERE action = 'delete' AND status = 'sent')::int AS deletes_sent,
                    count(*) FILTER (WHERE action = 'delete' AND status IN ('failed', 'unknown'))::int AS deletes_failed,
                    COALESCE(sum(read_count) FILTER (WHERE action = 'send'), 0)::int AS reads,
                    max(scheduled_at) FILTER (WHERE action = 'send' AND status IN ('queued', 'pending_approval')) AS scheduled_at
               FROM outbound_jobs
              WHERE action IN ('send', 'edit', 'delete') AND created_at > now() - interval '30 days'
              GROUP BY 1, 2, 3, 4
              ORDER BY min(created_at) DESC
              LIMIT $1)
           SELECT d.platform, d.account_id, d.chat_id, d.source_message_id, d.created_at, d.kind,
                  d.targets, d.sent, d.failed, d.unknown, d.pending, d.cancelled, d.skipped,
                  d.edits_sent, d.edits_failed, d.deletes_sent, d.deletes_failed, d.reads, d.scheduled_at,
                  -- The customer's latest wording (from the control group), else the first copy's text.
                  COALESCE(mv.text, d.text) AS text,
                  sm.version, sm.deleted_at IS NOT NULL AS deleted, ch.title AS source_title
             FROM d
             LEFT JOIN source_messages sm ON sm.platform = d.platform AND sm.account_id::text = d.account_id
                                         AND sm.chat_id = d.chat_id AND sm.message_id = d.source_message_id
             LEFT JOIN chats ch ON ch.platform = d.platform AND ch.account_id::text = d.account_id AND ch.chat_id = d.chat_id
             LEFT JOIN LATERAL (SELECT text FROM message_versions v
                                 WHERE v.platform = d.platform AND v.account_id::text = d.account_id AND v.chat_id = d.chat_id
                                   AND v.message_id = d.source_message_id AND v.text IS NOT NULL
                                 ORDER BY v.version DESC LIMIT 1) mv ON true
            ORDER BY d.created_at DESC`,
          [limit]);
        return r.rows.map((x) => ({
          source: { platform: x.platform, accountId: x.account_id, chatId: x.chat_id, title: x.source_title },
          messageId: x.source_message_id,
          createdAt: x.created_at,
          preview: stripSchedule(x.text ?? '').slice(0, 280),
          scheduledAt: x.scheduled_at,
          kind: x.kind,
          version: x.version ?? 1,
          deleted: !!x.deleted,
          copies: { total: x.targets, sent: x.sent, failed: x.failed, unknown: x.unknown, pending: x.pending, cancelled: x.cancelled, skipped: x.skipped },
          edits: { sent: x.edits_sent, failed: x.edits_failed },
          deletes: { sent: x.deletes_sent, failed: x.deletes_failed },
          reads: x.reads,
        }));
      });
    });

    // One distribution: every copy, its latest edit and its delete.
    api.on('GET', '/v1/distributions/:plat/:acct/:chat/:msg', true, async ({ auth, params }) => {
      const { plat, acct, chat, msg } = params as Record<string, string>;
      if (plat !== 'wa' && plat !== 'tg') throw new HttpError(404, 'not_found', 'not found');
      if (!UUID.test(acct ?? '')) throw new HttpError(404, 'not_found', 'not found');
      return api.tenantTx(auth!, async (c) => {
        const copies = await c.query<CopyRow>(
          `SELECT s.id::text, s.target_platform, s.target_chat_id, COALESCE(s.target_title, ch.title) AS title, s.status, s.error_kind,
                  s.last_error, s.sent_at, s.attempts, s.version, s.read_count, s.scheduled_at,
                  e.status AS edit_status, e.version AS edit_version, e.error_kind AS edit_error, e.id::text AS edit_job_id,
                  d.status AS delete_status, d.error_kind AS delete_error, d.id::text AS delete_job_id
             FROM outbound_jobs s
             LEFT JOIN LATERAL (SELECT id, status, version, error_kind FROM outbound_jobs x
                                 WHERE x.parent_job_id = s.id AND x.action = 'edit' ORDER BY version DESC, id DESC LIMIT 1) e ON true
             LEFT JOIN LATERAL (SELECT id, status, error_kind FROM outbound_jobs x
                                 WHERE x.parent_job_id = s.id AND x.action = 'delete' ORDER BY id DESC LIMIT 1) d ON true
             LEFT JOIN chats ch ON ch.platform = s.target_platform AND ch.account_id = s.target_account_id AND ch.chat_id = s.target_chat_id
            WHERE s.action = 'send' AND s.source_message_id = $1
              AND s.source->>'platform' = $2 AND s.source->>'accountId' = $3 AND s.source->>'chatId' = $4
            ORDER BY s.id`,
          [msg, plat, acct, chat]);
        if (!copies.rowCount) throw new HttpError(404, 'not_found', 'distribution not found');
        const src = await c.query<{ deleted: boolean }>(
          `SELECT deleted_at IS NOT NULL AS deleted FROM source_messages WHERE platform = $1 AND account_id = $2 AND chat_id = $3 AND message_id = $4`,
          [plat, acct, chat, msg]);
        const versions = await c.query<{ version: number; text: string | null; created_at: Date }>(
          `SELECT version, text, created_at FROM message_versions
            WHERE platform = $1 AND account_id = $2 AND chat_id = $3 AND message_id = $4 ORDER BY version`,
          [plat, acct, chat, msg]);
        return {
          deleted: !!src.rows[0]?.deleted,
          versions: versions.rows.map((v) => ({ version: v.version, text: v.text, at: v.created_at })),
          copies: copies.rows.map((r) => ({
            jobId: r.id,
            target: { platform: r.target_platform, chatId: r.target_chat_id, title: r.title },
            status: r.status,
            error: r.error_kind,
            detail: r.last_error,
            sentAt: r.sent_at,
            attempts: r.attempts,
            version: r.version,
            reads: r.read_count,
            scheduledAt: r.status === 'queued' || r.status === 'pending_approval' ? r.scheduled_at : null,
            edit: r.edit_status ? { jobId: r.edit_job_id, status: r.edit_status, version: r.edit_version, error: r.edit_error } : null,
            delete: r.delete_status ? { jobId: r.delete_job_id, status: r.delete_status, error: r.delete_error } : null,
          })),
        };
      });
    });

    // Manual retry of one failed (or unknown, after confirmation) send, edit or delete.
    api.on('POST', '/v1/jobs/:id/retry', true, async ({ auth, params, body }) => {
      api.requireRole(auth!, 'owner', 'admin', 'editor');
      const job = await api.tenantTx(auth!, (c) =>
        c.query<{ status: string; action: string; deleted: boolean; purged: boolean }>(
          `SELECT j.status, j.action, (j.content IS NULL OR j.content ? 'purged') AS purged,
                  EXISTS (SELECT 1 FROM source_messages sm
                           WHERE sm.platform = j.source->>'platform' AND sm.account_id::text = j.source->>'accountId'
                             AND sm.chat_id = j.source->>'chatId' AND sm.message_id = j.source_message_id AND sm.deleted_at IS NOT NULL) AS deleted
             FROM outbound_jobs j WHERE j.id = $1`, [params.id]));
      const row = job.rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'job not found');
      if (row.action === 'report') throw new HttpError(400, 'not_retryable', 'דיווחים אינם נשלחים מחדש');
      if (row.deleted && row.action !== 'delete') throw new HttpError(409, 'source_deleted', 'ההודעה נמחקה בקבוצת השליטה, ולכן לא תישלח שוב');
      if (row.purged) throw new HttpError(409, 'purged', 'תוכן ההודעה כבר נמחק לפי מדיניות השמירה; שלחו אותה מחדש בקבוצת השליטה');
      if (row.status === 'unknown' && row.action === 'send' && body.confirmNotDelivered !== true) {
        throw new HttpError(409, 'confirm_required', 'לא ידוע אם ההודעה הגיעה לקבוצה. בדקו בקבוצה, ושלחו שוב רק אם היא לא שם (confirmNotDelivered: true).');
      }
      if (!['failed', 'unknown'].includes(row.status)) throw new HttpError(409, 'not_retryable', 'אפשר לנסות שוב רק פעולה שנכשלה או שממתינה לאימות');
      if (!(await api.o.queue.requeue(auth!.tenantId, params.id!))) throw new HttpError(409, 'not_retryable', 'המצב השתנה בינתיים; רעננו את הדף');
      return { requeued: true };
    });

    // The marketing site (home page).
    api.on('GET', '/', false, async ({ req, res }) => {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
      });
      res.end(siteHtml(nonce, publicOrigin(req.headers.host)));
      return undefined;
    });

    // Search engines: only the home page is for them. The app and the panel answer "noindex"
    // themselves (listing their paths here would only advertise them).
    api.on('GET', '/robots.txt', false, async ({ req, res }) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      res.end(`User-agent: *\nAllow: /$\nDisallow: /v1/\n\nSitemap: ${publicOrigin(req.headers.host)}/sitemap.xml\n`);
      return undefined;
    });
    api.on('GET', '/sitemap.xml', false, async ({ req, res }) => {
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${publicOrigin(req.headers.host)}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>\n`);
      return undefined;
    });

    // The basic dashboard (Hebrew, RTL). The page is static; it talks to the API with the user's token.
    api.on('GET', '/app', false, async ({ res }) => {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; img-src 'self' data:; media-src blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      });
      res.end(dashboardHtml(nonce));
      return undefined;
    });

    // ---- The app as a phone app: the install page owners send to customers, manifest, icons, worker.
    api.on('GET', '/app/install', false, async ({ res }) => {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      });
      res.end(installHtml(nonce, fontFaceCss()));
      return undefined;
    });
    api.on('GET', '/app/manifest.webmanifest', false, async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      res.end(appManifest());
      return undefined;
    });
    api.on('GET', '/app/sw.js', false, async ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/app' });
      res.end(appServiceWorker());
      return undefined;
    });
    for (const size of [180, 192, 512] as const) {
      api.on('GET', `/app/icon-${size}.png`, false, async ({ res }) => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(adminIcon(size));
        return undefined;
      });
    }
  };
}
