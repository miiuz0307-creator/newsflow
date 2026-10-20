# NewsFlow (working name) — phase 1

News distribution for WhatsApp and Telegram group managers. This repository
holds the phase 1 (feasibility) core: linking WhatsApp numbers, encrypted
sessions, routing from source to target groups, templates, safe delivery,
Telegram, a development API, and tests for all of it.

**Status:** everything here runs against simulations (WhatsApp) and a local
fake (Telegram). No real number has been linked and nothing has been sent to
a real group. Linking real test numbers needs the owner's approval.

## Layout

```
src/
  crypto/keyring.ts        envelope encryption: master key → per-tenant key → AES-256-GCM
  wa/                      WhatsApp: transport contract, connection manager, encrypted auth store,
                           Baileys adapter (guarded), simulated network
  telegram/                Bot API client, account (polling, rights, media), local fake server
  routing/                 filters, Hebrew templates, invite-link removal, dedup, quiet hours, validation
  delivery/                queue, dispatcher, rate limiter, safety monitor, kill switches, media store
  engine/                  inbound pipeline, worker composition
  db/                      dependency-free Postgres client (SCRAM), migrations runner, Postgres stores
  api/                     development HTTP API (tokens, linking, SSE status, routes, approvals, stops)
  main.ts                  process entry point (API + worker)
db/
  bootstrap-roles.sql      the three database roles (owner / app / worker)
  migrations/              schema, Row Level Security, retention, provisioning
scripts/
  simulate.ts              narrated demo, nothing real involved
  loadtest.ts              load simulation (memory or Postgres queue)
  feasibility.ts           real-number test — locked behind ALLOW_REAL_WHATSAPP and an approval flag
  migrate.ts               applies migrations
test/                      unit, integration (Postgres), API and end-to-end tests
```

## Running

Requires Node.js 20+ and PostgreSQL 16. No npm packages are needed for the
core (see "Dependencies" below).

```bash
npm run simulate                      # narrated demo, no database needed
npm test                              # all tests (Postgres tests skip if no local server)
npm run typecheck
```

Postgres-backed tests expect a local server on port 55432 with the roles
from `db/bootstrap-roles.sql` and the development passwords used in
`test/pgHelpers.ts`. Override with `TEST_PG_PORT` / `TEST_PG_SOCKET`.

Run the server (development, simulated WhatsApp):

```bash
psql -f db/bootstrap-roles.sql        # once, as a superuser; then set the role passwords
DATABASE_URL=postgres://newsflow_owner:...@localhost/newsflow npm run db:migrate
cp .env.example .env                  # fill in values
npm run api:dev
```

## Safety switches

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOW_REAL_WHATSAPP` | off | Without it, the Baileys transport refuses to start. |
| `ALLOW_REAL_TELEGRAM` | off | Without it, the Telegram client refuses to call api.telegram.org. |
| `DEV_TOKENS` | off | Enables `/v1/dev/token`; refused in production regardless. |

## Dependencies

The npm registry was unreachable while phase 1 was built, so the core uses
only Node.js built-ins (`node:test`, `node:crypto`, `node:http`, a small
Postgres wire-protocol client). Planned swaps once packages can be installed:

- `baileys` (pinned, integrity-checked) — the adapter in `src/wa/baileysTransport.ts` is ready
- `pg` — replaces `src/db/pg.ts` behind the same `Sql` interface
- `qrcode` — QR image for the linking screen (the API already returns the QR string)

## Not in phase 1

Flutter app, real sign-up/login, billing, Super Admin UI, push notifications,
object storage, multi-worker session assignment, monitoring stack. See the
progress report.
