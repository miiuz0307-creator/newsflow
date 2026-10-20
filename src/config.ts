/**
 * Runtime configuration, read once from environment variables.
 *
 * Every value that changes behaviour in production (limits, prices, feature
 * flags) lives in the database, not here. This file only holds what the
 * process needs to boot: where the database is, the master key, and safety
 * guards that must never be flipped by a database row.
 */

export interface AppConfig {
  env: 'development' | 'test' | 'staging' | 'production';
  databaseUrl: string;
  /** 32-byte master key, base64. Wraps per-tenant data keys. */
  masterKeyB64: string;
  /** Id of the master key, stored next to every wrapped key so keys can rotate. */
  masterKeyId: string;
  /**
   * Hard guard: real WhatsApp connections are refused unless this is true.
   * Phase 1 runs with it off; turning it on needs the owner's approval.
   */
  allowRealWhatsApp: boolean;
  /** Hard guard: real sends to Telegram are refused unless this is true. */
  allowRealTelegram: boolean;
  telegramApiBase: string;
  apiPort: number;
}

function bool(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = (env.APP_ENV ?? 'development') as AppConfig['env'];
  if (!['development', 'test', 'staging', 'production'].includes(appEnv)) {
    throw new Error(`APP_ENV must be development|test|staging|production, got "${appEnv}"`);
  }
  const masterKeyB64 = env.MASTER_KEY ?? '';
  if (appEnv === 'production' || appEnv === 'staging') {
    if (Buffer.from(masterKeyB64, 'base64').length !== 32) {
      throw new Error('MASTER_KEY must be 32 bytes, base64 encoded');
    }
  }
  return {
    env: appEnv,
    databaseUrl: env.DATABASE_URL ?? 'postgres://app_user@localhost:5432/newsflow',
    masterKeyB64,
    masterKeyId: env.MASTER_KEY_ID ?? 'mk-1',
    allowRealWhatsApp: bool(env.ALLOW_REAL_WHATSAPP),
    allowRealTelegram: bool(env.ALLOW_REAL_TELEGRAM),
    telegramApiBase: env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
    apiPort: Number(env.API_PORT ?? 8787),
  };
}
