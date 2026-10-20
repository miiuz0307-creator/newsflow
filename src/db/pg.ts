/**
 * Minimal PostgreSQL client (wire protocol v3) with no dependencies.
 *
 * Why it exists: the npm registry was unreachable when phase 1 was built, so
 * the `pg` package could not be installed. Everything above this file talks
 * to the small `Sql` interface below, so swapping in `pg` later is a
 * one-file change (see PgPackageSql in the report).
 *
 * Supports: trust, cleartext and SCRAM-SHA-256 auth; parameterized queries
 * (extended protocol, text format); multi-statement scripts for migrations;
 * a small pool with transactions; TLS via `sslmode=require`.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
  command: string;
}

/** The only database surface the application uses. */
export interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export class PgError extends Error {
  constructor(public readonly fields: Record<string, string>) {
    super(fields.M ?? 'postgres error');
    this.name = 'PgError';
  }
  get code(): string | undefined {
    return this.fields.C;
  }
  get detail(): string | undefined {
    return this.fields.D;
  }
}

export interface ConnOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl?: boolean;
  /** Unix socket directory (host is ignored when set). */
  socketDir?: string;
  applicationName?: string;
}

export function parseDatabaseUrl(url: string): ConnOptions {
  const u = new URL(url);
  const params = u.searchParams;
  const host = params.get('host') ?? decodeURIComponent(u.hostname || 'localhost');
  return {
    host: host.startsWith('/') ? 'localhost' : host,
    socketDir: host.startsWith('/') ? host : undefined,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    ssl: params.get('sslmode') === 'require' || params.get('ssl') === 'true',
  };
}

// ---------- value conversion ----------

const OID = { bool: 16, bytea: 17, int8: 20, int2: 21, int4: 23, text: 25, json: 114, float4: 700, float8: 701, timestamp: 1114, timestamptz: 1184, numeric: 1700, uuid: 2950, jsonb: 3802, textArr: 1009, uuidArr: 2951, int4Arr: 1007 } as const;

function parseArray(s: string): (string | null)[] {
  // Handles the simple 1-D text form {a,"b c",NULL}
  if (s === '{}') return [];
  const out: (string | null)[] = [];
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') {
      let v = '';
      i++;
      while (s[i] !== '"') {
        if (s[i] === '\\') i++;
        v += s[i++];
      }
      out.push(v);
      i += 2;
    } else {
      let j = s.indexOf(',', i);
      if (j === -1) j = s.length - 1;
      const v = s.slice(i, j);
      out.push(v === 'NULL' ? null : v);
      i = j + 1;
    }
  }
  return out;
}

function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case OID.bool: return text === 't';
    case OID.int2:
    case OID.int4: return Number(text);
    case OID.int8: {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case OID.float4:
    case OID.float8: return Number(text);
    case OID.json:
    case OID.jsonb: return JSON.parse(text);
    case OID.timestamptz:
    case OID.timestamp: return new Date(text.includes('T') || text.endsWith('Z') ? text : text.replace(' ', 'T') + (oid === OID.timestamp ? 'Z' : ''));
    case OID.bytea: return Buffer.from(text.slice(2), 'hex');
    case OID.textArr:
    case OID.uuidArr: return parseArray(text);
    case OID.int4Arr: return parseArray(text).map((v) => (v === null ? null : Number(v)));
    default: return text;
  }
}

function serializeParam(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Buffer.from(v.toISOString());
  if (Buffer.isBuffer(v)) return Buffer.from('\\x' + v.toString('hex'));
  if (typeof v === 'object') return Buffer.from(JSON.stringify(v));
  if (typeof v === 'boolean') return Buffer.from(v ? 't' : 'f');
  return Buffer.from(String(v));
}

// ---------- message framing ----------

class Writer {
  private parts: Buffer[] = [];
  int32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  int16(n: number) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.parts.push(b); return this; }
  cstr(s: string) { this.parts.push(Buffer.from(s + '\0')); return this; }
  bytes(b: Buffer) { this.parts.push(b); return this; }
  frame(type: string | null): Buffer {
    const body = Buffer.concat(this.parts);
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4);
    return type ? Buffer.concat([Buffer.from(type), len, body]) : Buffer.concat([len, body]);
  }
}

interface Msg { type: string; body: Buffer }

class Reader {
  private off = 0;
  constructor(private readonly b: Buffer) {}
  int32() { const v = this.b.readInt32BE(this.off); this.off += 4; return v; }
  int16() { const v = this.b.readInt16BE(this.off); this.off += 2; return v; }
  cstr() { const end = this.b.indexOf(0, this.off); const s = this.b.toString('utf8', this.off, end); this.off = end + 1; return s; }
  bytes(n: number) { const s = this.b.subarray(this.off, this.off + n); this.off += n; return s; }
  rest() { return this.b.subarray(this.off); }
}

function parseErrorFields(body: Buffer): Record<string, string> {
  const r = new Reader(body);
  const f: Record<string, string> = {};
  for (;;) {
    const code = r.bytes(1).toString();
    if (code === '\0' || code === '') break;
    f[code] = r.cstr();
  }
  return f;
}

// ---------- connection ----------

export class PgConnection implements Sql {
  private sock!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private waiters: ((m: Msg) => void)[] = [];
  private inbox: Msg[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private fatal: Error | null = null;

  private constructor(private readonly opts: ConnOptions) {}

  static async connect(opts: ConnOptions): Promise<PgConnection> {
    const c = new PgConnection(opts);
    await c.open();
    return c;
  }

  private async open() {
    const o = this.opts;
    const raw: net.Socket = await new Promise((resolve, reject) => {
      const s = o.socketDir ? net.connect(`${o.socketDir}/.s.PGSQL.${o.port}`) : net.connect(o.port, o.host);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    if (o.ssl) {
      raw.write(new Writer().int32(80877103).frame(null));
      const answer: Buffer = await new Promise((r) => raw.once('data', r));
      if (answer.toString() !== 'S') throw new Error('server refused TLS');
      this.sock = tls.connect({ socket: raw, servername: o.host });
      await new Promise<void>((r, j) => { this.sock.once('secureConnect', () => r()); this.sock.once('error', j); });
    } else {
      this.sock = raw;
    }
    this.sock.on('data', (d: Buffer) => this.onData(d));
    this.sock.on('error', (e) => this.fail(e));
    this.sock.on('close', () => this.fail(new Error('connection closed')));
    const start = new Writer().int32(196608).cstr('user').cstr(o.user).cstr('database').cstr(o.database)
      .cstr('application_name').cstr(o.applicationName ?? 'newsflow').cstr('client_encoding').cstr('UTF8').cstr('');
    this.sock.write(start.frame(null));
    await this.authenticate();
  }

  private fail(e: Error) {
    if (this.fatal) return;
    this.fatal = e;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ type: '!', body: Buffer.from(e.message) });
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const m = { type: String.fromCharCode(this.buf[0]!), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (m.type === 'N' || m.type === 'S' || m.type === 'A') continue; // notices, parameter status, notifications
      const w = this.waiters.shift();
      if (w) w(m);
      else this.inbox.push(m);
    }
  }

  private next(): Promise<Msg> {
    if (this.fatal) return Promise.reject(this.fatal);
    const m = this.inbox.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) =>
      this.waiters.push((msg) => (msg.type === '!' ? reject(this.fatal ?? new Error(msg.body.toString())) : resolve(msg))),
    );
  }

  private async authenticate() {
    let scram: { nonce: string; clientFirstBare: string; serverSig?: Buffer } | null = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'E') throw new PgError(parseErrorFields(m.body));
      if (m.type === 'K') continue;
      if (m.type === 'Z') return;
      if (m.type !== 'R') throw new Error(`unexpected message ${m.type} during auth`);
      const r = new Reader(m.body);
      const code = r.int32();
      if (code === 0) continue; // AuthenticationOk
      const password = this.opts.password ?? '';
      if (code === 3) {
        this.sock.write(new Writer().cstr(password).frame('p'));
      } else if (code === 10) {
        const mechs = r.rest().toString().split('\0');
        if (!mechs.includes('SCRAM-SHA-256')) throw new Error(`unsupported SASL mechanisms: ${mechs.join(',')}`);
        const nonce = randomBytes(18).toString('base64');
        const clientFirstBare = `n=*,r=${nonce}`;
        scram = { nonce, clientFirstBare };
        const payload = Buffer.from(`n,,${clientFirstBare}`);
        this.sock.write(new Writer().cstr('SCRAM-SHA-256').int32(payload.length).bytes(payload).frame('p'));
      } else if (code === 11) {
        if (!scram) throw new Error('SASL continue without start');
        const serverFirst = r.rest().toString();
        const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
        if (!attrs.r?.startsWith(scram.nonce)) throw new Error('SCRAM nonce mismatch');
        const salted = pbkdf2Sync(password.normalize('NFKC'), Buffer.from(attrs.s!, 'base64'), Number(attrs.i), 32, 'sha256');
        const clientKey = createHmac('sha256', salted).update('Client Key').digest();
        const storedKey = createHash('sha256').update(clientKey).digest();
        const finalNoProof = `c=biws,r=${attrs.r}`;
        const authMessage = `${scram.clientFirstBare},${serverFirst},${finalNoProof}`;
        const clientSig = createHmac('sha256', storedKey).update(authMessage).digest();
        const proof = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) proof[i] = clientKey[i]! ^ clientSig[i]!;
        const serverKey = createHmac('sha256', salted).update('Server Key').digest();
        scram.serverSig = createHmac('sha256', serverKey).update(authMessage).digest();
        this.sock.write(new Writer().bytes(Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`)).frame('p'));
      } else if (code === 12) {
        const v = Object.fromEntries(r.rest().toString().split(',').map((kv) => [kv[0], kv.slice(2)])).v;
        const got = Buffer.from(v ?? '', 'base64');
        if (!scram?.serverSig || got.length !== 32 || !timingSafeEqual(got, scram.serverSig)) {
          throw new Error('SCRAM server signature mismatch');
        }
      } else {
        throw new Error(`unsupported auth method ${code} (use scram-sha-256)`);
      }
    }
  }

  query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
    const run = this.chain.then(() => this.runExtended<R>(text, params));
    this.chain = run.catch(() => {});
    return run;
  }

  /** Runs a script with several statements and no parameters (migrations). */
  exec(script: string): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.closed) throw this.fatal ?? new Error('connection closed');
      this.sock.write(new Writer().cstr(script).frame('Q'));
      let err: PgError | null = null;
      for (;;) {
        const m = await this.next();
        if (m.type === 'E') err = new PgError(parseErrorFields(m.body));
        if (m.type === 'Z') break;
      }
      if (err) throw err;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async runExtended<R>(text: string, params: unknown[]): Promise<QueryResult<R>> {
    if (this.closed) throw this.fatal ?? new Error('connection closed');
    const bind = new Writer().cstr('').cstr('').int16(0).int16(params.length);
    for (const p of params) {
      const b = serializeParam(p);
      if (b === null) bind.int32(-1);
      else bind.int32(b.length).bytes(b);
    }
    bind.int16(0);
    this.sock.write(Buffer.concat([
      new Writer().cstr('').cstr(text).int16(0).frame('P'),
      bind.frame('B'),
      new Writer().bytes(Buffer.from('P\0')).frame('D'),
      new Writer().cstr('').int32(0).frame('E'),
      new Writer().frame('S'),
    ]));
    let fields: { name: string; oid: number }[] = [];
    const rows: R[] = [];
    let command = '';
    let rowCount = 0;
    let err: PgError | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case 'T': {
          const r = new Reader(m.body);
          const n = r.int16();
          fields = [];
          for (let i = 0; i < n; i++) {
            const name = r.cstr();
            r.int32(); r.int16();
            const oid = r.int32();
            r.int16(); r.int32(); r.int16();
            fields.push({ name, oid });
          }
          break;
        }
        case 'D': {
          const r = new Reader(m.body);
          const n = r.int16();
          const row: Record<string, unknown> = {};
          for (let i = 0; i < n; i++) {
            const len = r.int32();
            const f = fields[i]!;
            row[f.name] = len === -1 ? null : parseValue(f.oid, r.bytes(len).toString('utf8'));
          }
          rows.push(row as R);
          break;
        }
        case 'C': {
          command = new Reader(m.body).cstr();
          const last = Number(command.split(' ').pop());
          rowCount = Number.isFinite(last) ? last : rows.length;
          break;
        }
        case 'E':
          err = new PgError(parseErrorFields(m.body));
          break;
        case 'Z':
          if (err) throw err;
          return { rows, rowCount, command: command.split(' ')[0] ?? '' };
        default:
          break; // '1' ParseComplete, '2' BindComplete, 'n' NoData, 'I' EmptyQuery
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sock.write(new Writer().frame('X'));
    } catch { /* ignore */ }
    this.sock.end();
  }

  get isClosed() {
    return this.closed;
  }
}

// ---------- pool ----------

export class PgPool implements Sql {
  private idle: PgConnection[] = [];
  private total = 0;
  private waiting: ((c: PgConnection) => void)[] = [];
  private ending = false;

  constructor(private readonly opts: ConnOptions, private readonly max = 10) {}

  static fromUrl(url: string, max = 10): PgPool {
    return new PgPool(parseDatabaseUrl(url), max);
  }

  async acquire(): Promise<PgConnection> {
    if (this.ending) throw new Error('pool is closed');
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.isClosed) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      try {
        return await PgConnection.connect(this.opts);
      } catch (e) {
        this.total--;
        throw e;
      }
    }
    return new Promise((r) => this.waiting.push(r));
  }

  release(c: PgConnection) {
    if (c.isClosed) {
      this.total--;
      return;
    }
    const w = this.waiting.shift();
    if (w) w(c);
    else this.idle.push(c);
  }

  async query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    const c = await this.acquire();
    try {
      return await c.query<R>(text, params);
    } finally {
      this.release(c);
    }
  }

  /** Runs `fn` inside BEGIN/COMMIT on one connection; rolls back on error. */
  async transaction<T>(fn: (sql: PgConnection) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      this.release(c);
    }
  }

  async end(): Promise<void> {
    this.ending = true;
    await Promise.all(this.idle.splice(0).map((c) => c.close()));
  }
}
