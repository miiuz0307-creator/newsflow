/**
 * Creates a Super Admin user and prints the two-factor setup link.
 *
 *   DATABASE_URL=postgres://newsflow_owner:...@host/db MASTER_KEY=... tsx scripts/create-admin.ts <email> <superadmin|support>
 *
 * The password is read from ADMIN_PASSWORD (not from the command line, so it
 * doesn't land in shell history). Scan the printed otpauth:// link (or enter
 * the secret) in an authenticator app; logins require its 6-digit code.
 */
import { checkPassword, hashPassword } from '../src/auth/password.js';
import { encryptTotpSecret } from '../src/api/modules/admin.js';
import { generateTotpSecret, otpauthUrl } from '../src/auth/totp.js';
import { PgConnection, parseDatabaseUrl } from '../src/db/pg.js';

const [email, role = 'support'] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD ?? '';
if (!email || !['superadmin', 'support'].includes(role)) {
  console.error('usage: create-admin.ts <email> <superadmin|support>   (password in ADMIN_PASSWORD)');
  process.exit(2);
}
const problem = checkPassword(password, email);
if (problem || password.length < 12) {
  console.error(`password rejected: ${problem?.message ?? 'admins need at least 12 characters'}`);
  process.exit(2);
}
const conn = await PgConnection.connect(parseDatabaseUrl(process.env.DATABASE_URL ?? ''));
const secret = generateTotpSecret();
const master = process.env.MASTER_KEY ?? '';
if (Buffer.from(master, 'base64').length !== 32) {
  console.error('MASTER_KEY (the same one the server uses) is required: the 2FA secret is stored encrypted');
  process.exit(2);
}
await conn.query('INSERT INTO admins (email, password_hash, totp_secret, role) VALUES ($1, $2, $3, $4)', [email, await hashPassword(password), encryptTotpSecret(master, email, secret), role]);
await conn.close();
console.log(`admin created: ${email} (${role})`);
console.log(`two-factor secret: ${secret}`);
console.log(`authenticator link: ${otpauthUrl(secret, email)}`);
