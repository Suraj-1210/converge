# CLAUDE.md

Working notes for Claude Code sessions on this repo. Things here were verified
against the running app — prefer them over the stale sections of README.md.

## What this is

Converge — partner/student application management for Collegepond.
Next.js 15 (App Router, Turbopack) + tRPC 11 + Prisma 6 + MySQL 8.

## Running locally

**Node 20 is required** (`engines: 20.x`). Newer majors may work but are not what
production builds with.

You need a MySQL 8 server. Either:

- `./start-database.sh` — starts a `converge-mysql` Docker container, or
- **any local MySQL 8** — the db scripts detect a local `mysql` client and use it.
  This is the working path on Windows without WSL/Docker.

Then:

```
cp .env.example .env     # set DATABASE_URL + AUTH_SECRET (openssl rand -base64 48)
npm install
npm run db:reset:force   # loads schema.sql + seed.sql
npm run dev
```

Everything else in `.env` is optional in dev and degrades safely — see
"Silent degradation" below.

### Logging in locally

No real email/SMS is sent. The OTP is printed to the dev-server log as
`[OTP:sandbox] SMS to <phone> => <code>`, and in `next dev` a "dev autopilot"
fills and submits it automatically, so login usually needs no interaction.

Seeded accounts are listed at the top of `prisma/sql/seed.sql`. Admin login at
`/admin/login` needs **both** email and phone (`admin@collegepond.com` /
`+91 9876543210`). `/login` is the separate partner portal.

## Commands that matter

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run check` | `next lint && tsc --noEmit` |
| `npm run build` | `prisma generate && next build` |
| `npm run db:reset:force` | Drop + reload schema.sql + seed.sql (dev only) |
| `npm run db:diff [name]` | Diff live DB against schema.sql → new delta file |
| `npm run db:apply` | Apply pending deltas (Node; no mysql client needed) |
| `npm run db:baseline` | Record deltas as applied WITHOUT running them |

## There are no tests

No test suite, no CI, no `test` script. `npm run check` (lint + typecheck) is
the entire automated safety net — run it before pushing. Behavioural changes
need manual verification against a running app.

## Database workflow (SQL-first)

`prisma/sql/schema.sql` is the source of truth, not the Prisma schema. Prisma
models are generated downstream and use `@map`/`@@map`, so **Prisma names differ
from database names** (`cp_user`, `approved_by_cp_user_id`, `min_entry_req`…).

1. Edit the model (MySQL Workbench → Forward Engineer) and commit over `schema.sql`
2. `npm run db:diff` → writes a delta to `prisma/sql/migrations/`
3. **Read the delta before applying.** Diff tools express a *rename* as
   `DROP` + `ADD`, which destroys the column's data. Convert those to
   `RENAME`/`CHANGE` by hand. This is the single most dangerous step here.
4. `npm run db:apply` — forward-only, idempotent, tracked in `schema_migrations`

### The baseline trap

`schema.sql` **creates** `schema_migrations` but never populates it. So a
database loaded from `schema.sql` already contains every delta while looking
like it has never been migrated. Applying the deltas there fails on
already-existing columns.

`db:apply` detects this (tables present, no migration history) and stops rather
than guessing. Run `npm run db:baseline` **once per environment** to record the
files as applied without executing them. Production was bootstrapped from
`schema.sql` by hand, so it needs this too.

## Deployment

DigitalOcean App Platform. App id `19cda1e2-324f-48fb-a59a-f2ff93088ada`,
region `blr`, Managed MySQL 8.4 (`converge-db`, blr1), Spaces for uploads.

- Deploys from **`main`**. `deploy_on_push: false` — **a push never deploys.**
- Deploy on demand: `doctl apps create-deployment 19cda1e2-324f-48fb-a59a-f2ff93088ada`
- Health check `/api/health` runs `SELECT 1`, so 200 means app **and** DB are up
- A failed build does **not** replace the running version; roll back per
  deployment in the dashboard
- `.do/app.yaml` documents the config but **App Platform stores its own copy** —
  editing the file changes nothing. Apply with `doctl apps update --spec`.
- `doctl apps spec get` returns secrets as encrypted `EV[...]` refs that
  round-trip safely, so a spec update does not clobber them
- `doctl apps console <id> web` gets a shell in the container, with the
  production env vars already present — the right way to run one-off DB tasks
  without handling the production password locally

### Build gotchas (already encoded in app.yaml — don't "fix" them)

- The build command sets a **dummy `DATABASE_URL`**: `next build` imports every
  route under `NODE_ENV=production` and constructs the Prisma client, which
  throws without one. It never connects.
- `SKIP_ENV_VALIDATION=1` so `@t3-oss/env` doesn't fail on runtime-only secrets
- `NODE_ENV` is **RUN_TIME only**. Setting it at build time makes npm skip
  devDependencies → "Cannot find module '@tailwindcss/postcss'".

## Silent degradation — assume nothing works until tested

Missing config mostly does **not** raise errors, which makes broken integrations
look identical to working ones:

| Unset | Dev | Production |
|---|---|---|
| `MSG91_*` | SMS OTP logged to console | Fails loudly — login breaks |
| `SES_*` | Emails (incl. email OTP) printed to console | Fails loudly — partner login + all email break |
| `SPACES_*` | Uploads to `./public/uploads` | Throws (ephemeral disk) |
| `PERISKOPE_*` | WhatsApp sends skipped silently | **Also silent** |

`src/server/periskope.ts` reads `process.env` directly rather than going through
`env.js`, so a missing or wrong key never surfaces — `periskopeConfigured()`
just returns false. Smoke-test WhatsApp and uploads explicitly after any config
change.

## Repo conventions

- `generated/prisma/` is **committed**, so `prisma generate` produces diff noise
  on any machine whose engine differs. Don't commit
  `query_engine-windows.dll.node` — the Linux target is what production needs.
- Secrets never go in `.do/app.yaml` — placeholders only, real values in the
  dashboard
- `AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` must stay **stable**. Rotating
  the first logs everyone out; rotating the second makes stored portal
  credentials permanently undecryptable.
