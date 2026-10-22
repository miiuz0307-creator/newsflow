/**
 * Keeps one TelegramAccount running per connected bot, loads bots at startup
 * (decrypting their tokens with the tenant key), persists the polling offset,
 * and hands inbound messages to the worker.
 */
import type { ChatInfo, InboundMessage, SyncEvent } from '../core/types.js';
import type { Sql } from '../db/pg.js';
import type { TenantKeys } from '../db/pgStores.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { TelegramAccount } from './account.js';
import { TelegramBotApi, type BotApiOptions } from './botApi.js';

export interface TelegramRuntimeOptions {
  workerSql: Sql;
  keys: TenantKeys;
  apiOptions: BotApiOptions;
  onMessage: (m: InboundMessage) => void;
  /** Edits seen by a bot (PUSH Sync). */
  onSync?: (e: SyncEvent) => void;
  /** Called so the worker can send through the bot. */
  onStarted?: (acc: TelegramAccount) => void;
  onStopped?: (botId: string) => void;
  logger?: Logger;
  /** Long-poll timeout; tests use 0. */
  pollTimeoutSec?: number;
}

export class TelegramRuntime {
  private readonly bots = new Map<string, { tenantId: string; acc: TelegramAccount }>();
  private readonly log: Logger;

  constructor(private readonly o: TelegramRuntimeOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'telegram-runtime' });
  }

  /** Verifies a token without starting anything. Returns the bot's identity. */
  async verifyToken(token: string): Promise<{ id: number; username?: string }> {
    const api = new TelegramBotApi(token, this.o.apiOptions);
    const me = await api.getMe();
    if (!me.is_bot) throw new Error('token does not belong to a bot');
    return { id: me.id, username: me.username };
  }

  async start(tenantId: string, botId: string, token: string): Promise<TelegramAccount> {
    await this.stop(botId);
    const sql = this.o.workerSql;
    const acc = new TelegramAccount({
      tenantId,
      accountId: botId,
      api: new TelegramBotApi(token, this.o.apiOptions),
      logger: this.o.logger,
      pollTimeoutSec: this.o.pollTimeoutSec,
      onMessage: (m) => this.o.onMessage(m),
      onSync: (e) => this.o.onSync?.(e),
      onChatsChanged: (chats) => void this.saveChats(tenantId, botId, chats).catch((e) => this.log.error('save chats failed', { err: String(e) })),
      loadOffset: async () => {
        const r = await sql.query<{ update_offset: number | null }>('SELECT update_offset FROM tg_bots WHERE id = $1', [botId]);
        return r.rows[0]?.update_offset ?? undefined;
      },
      saveOffset: async (offset) => {
        await sql.query('UPDATE tg_bots SET update_offset = $2 WHERE id = $1', [botId, offset]);
      },
    });
    await acc.start();
    this.bots.set(botId, { tenantId, acc });
    this.o.onStarted?.(acc);
    return acc;
  }

  async stop(botId: string): Promise<void> {
    const b = this.bots.get(botId);
    if (!b) return;
    this.bots.delete(botId);
    await b.acc.stop();
    this.o.onStopped?.(botId);
  }

  get(botId: string): TelegramAccount | undefined {
    return this.bots.get(botId)?.acc;
  }

  chats(botId: string): ChatInfo[] {
    return this.get(botId)?.listChats() ?? [];
  }

  async addChat(botId: string, chatId: string): Promise<ChatInfo> {
    const b = this.bots.get(botId);
    if (!b) throw new Error('bot is not running');
    const info = await b.acc.addChat(chatId);
    await this.saveChats(b.tenantId, botId, [info]);
    return info;
  }

  /** Starts every active bot. Called once when a worker boots. */
  async loadAll(): Promise<number> {
    const r = await this.o.workerSql.query<{ id: string; tenant_id: string; token_blob: string }>(
      `SELECT b.id, b.tenant_id, b.token_blob FROM tg_bots b JOIN tenants t ON t.id = b.tenant_id WHERE b.status = 'active' AND t.status = 'active'`);
    let n = 0;
    for (const row of r.rows) {
      try {
        const token = (await this.o.keys.cipher(row.tenant_id)).decryptString(`tg-token:${row.id}`, row.token_blob);
        await this.start(row.tenant_id, row.id, token);
        n++;
      } catch (e) {
        this.log.error('bot failed to start', { botId: row.id, err: String(e) });
        await this.o.workerSql.query('UPDATE tg_bots SET last_error = $2 WHERE id = $1', [row.id, String(e).slice(0, 300)]);
      }
    }
    return n;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.bots.keys()].map((id) => this.stop(id)));
  }

  private async saveChats(tenantId: string, botId: string, chats: ChatInfo[]) {
    for (const ch of chats) {
      await this.o.workerSql.query(
        `INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, type, can_send, is_admin, participant_count, updated_at)
         VALUES ($1, 'tg', $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (platform, account_id, chat_id) DO UPDATE SET title = EXCLUDED.title, type = EXCLUDED.type,
           can_send = EXCLUDED.can_send, is_admin = EXCLUDED.is_admin, participant_count = EXCLUDED.participant_count, updated_at = now()`,
        [tenantId, botId, ch.ref.chatId, ch.title, ch.type, ch.canSend, ch.isAdmin, ch.participantCount ?? null],
      );
    }
  }
}
