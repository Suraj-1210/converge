# Converge by Collegepond

**B2B Partner Portal for International Education Consulting**

Converge is a B2B Partner Portal for the recruitment partner ecosystem of international education consulting. Recruitment agencies, freelance counselors, and education consultants register, manage student applications, track commissions, and collaborate with Collegepond's internal teams through a unified portal.

> **🚀 New here? Just cloned this repo?** Open [Claude Code](https://claude.com/claude-code) in this folder and type `/autonomous-setup`. Claude installs everything (Node, Docker, database, seed data), starts the app, verifies it, and hands you a setup report with login details. No manual steps needed.

### Onboarding someone non-technical (no terminal at all)

They don't need to clone anything or touch a terminal. Have them:

1. Install the **Claude desktop app** — normal app install, no terminal.
2. Sign in with their Claude account.
3. Paste this message into a new chat:

> Clone the repository `https://github.com/sulkytejas/converge.git` into a
> folder called `converge` in my home directory. Then read the file
> `.claude/skills/autonomous-setup/SKILL.md` inside it and follow those
> instructions exactly, start to finish. I am not technical — do everything
> for me, explain things in plain words, and give me the final report when
> the app is running.

Their only interactions after that: clicking **Allow** when Claude asks
permission to run things, typing their computer password once if Homebrew
needs installing, and possibly one "Accept" click on Docker Desktop's first
launch. The repo is public, so no GitHub account or sign-in is needed.

---

## ⚠️ DigitalOcean migration — WIP notes (read me first)

> Running log captured during the AWS→DigitalOcean migration. **The sections
> below this one are stale** and will be rewritten from scratch using these
> notes once the migration lands. Treat this section as the current truth.

**Target:** DigitalOcean App Platform (Next.js) + Managed MySQL 8 + Spaces (S3-compatible storage).

### Done so far
- **DB model changes** — renames done via Prisma `@map`/`@@map` (DB names `cp_user`, `approved_by_cp_user_id`, `duolingo`, `min_entry_req`, `needs_edu_loan`; the Prisma/code names are unchanged), `tinyint(1)` flag conversions, NOT NULL tightenings, `unsigned`/`decimal` adjustments. **`prisma/sql/schema.sql` stays the source of truth.**
- **File storage → Spaces** — `src/server/storage/` auto-selects Spaces (prod) vs local disk (dev). Public university logos → permanent CDN URL; private docs/avatars/org-logos → object key served only through the gated **`/api/files/[...key]`** proxy (admins: any; partners: own org). Throws in prod if `SPACES_*` unset (no silent ephemeral-disk writes).
- **Security** — partners admin router now requires admin auth; OTP fails loudly in prod if MSG91 unset (no sandbox/code-logging fallback); email OTP moved to a DB table (`otp_code`) with attempt cap + resend cooldown + hashing; login no longer leaks account existence; **`/api/upload`** gated (folder allowlist + per-folder session + magic-byte MIME + per-IP rate limit).
- **Build** — all ESLint build-blockers fixed.
- **Schema-apply tooling (B2)** — `npm run db:diff` (generate a reviewable delta) + `npm run db:apply` (apply pending deltas, tracked in `schema_migrations`; idempotent, localhost-guarded, TLS for remote). Verified end-to-end (apply → re-run skips).
- **DB connectivity** — `src/server/db.ts` handles Managed MySQL TLS (B4); Prisma `binaryTargets` include the Linux engine; connection-pool cap.
- **Transactional email** — **MSG91** for non-OTP mail too (admin signup notify, partner more-info) via `src/server/email.ts`; gated on per-email template IDs, degrades to a minimal non-PII log until set.
- **Hardening** — account-status re-checked on every protected request (deactivation is immediate), upload/zip DoS guards, no PII in logs, list queries bounded (cap 500 — cursor pagination is the follow-up), `/api/health` DB ping.

### Schema-change workflow (SQL-first; Prisma generated downstream)
1. Riana edits the model in **MySQL Workbench** → **Forward Engineer → SQL** → commits it over `prisma/sql/schema.sql` (optionally commit the `.mwb` under `prisma/sql/workbench/` for history), then regenerate the Prisma client.
2. `npm run db:diff [name]` — diffs the current DB against `schema.sql`, writes a reviewable delta to `prisma/sql/migrations/`. Whoever opens the PR runs this and commits the generated delta **alongside** the `schema.sql` change in the **same PR**, so the schema change and its migration are reviewed together.
3. **Review the delta** — diff tools render a rename as `DROP`+`ADD` (data loss). Convert those to `RENAME`/`CHANGE` by hand before applying.
4. `npm run db:apply` — applies pending deltas in order, tracked in `schema_migrations`; idempotent, localhost-guarded, TLS for remote hosts (`MYSQL_SSL_CA`). Fresh DBs: load full `schema.sql` first (`npm run db:reset` in dev; one-time TLS load for the prod bootstrap).

### New env vars (see `.env.example`)
`SPACES_*` (storage), `DATABASE_CA_CERT` (Managed MySQL TLS), `SES_*` / `EMAIL_FROM` / `APP_URL` (email). **Email = Amazon SES** for OTP *and* transactional mail, with templates in `src/server/email/templates.ts`; **SMS = MSG91**. In production the app fails loud if `MSG91_*`, `SES_*` or `SPACES_*` are missing (no silent fallback).

### Still TODO before prod testing
- **B4** — Managed MySQL TLS (`?sslaccept` + CA) in `DATABASE_URL` + `src/server/db.ts`.
- **H5** — commit `.do/app.yaml` (build/run commands, `http_port`, instance size, env→secrets, MySQL attachment).
- **H3/H4** — set a distinct `CREDENTIAL_ENCRYPTION_KEY` + fresh `AUTH_SECRET` on DO; never ship the local `.env`.
- **M2** Prisma `binaryTargets` (Linux); **M3** `/api/health` DB ping.
- Plug in real `SPACES_*` + `MSG91_*` creds and smoke-test uploads, OTP delivery, DB connectivity.

---

## Tech Stack

| Layer            | Technology                | Notes                                              |
| ---------------- | ------------------------- | -------------------------------------------------- |
| Framework        | Next.js 15 (App Router)   | Server components, route handlers                  |
| Language         | TypeScript                | Strict mode, end-to-end type safety                |
| API Layer        | tRPC v11                  | Type-safe procedures consumed by React Query       |
| ORM              | Prisma                    | Generated client; canonical DDL in `prisma/sql/`   |
| Styling          | Tailwind CSS v4           | Utility-first; theme tokens in `src/styles/globals.css` |
| Authentication   | OTP via MSG91 (in progress) | Email + phone OTP; session layer not yet wired in |
| Database         | MySQL 8                   | Local dev runs in Docker                           |
| Validation       | Zod                       | Runtime input + env validation (`src/env.js`)      |
| State            | TanStack React Query      | Via tRPC integration                               |

---

## Getting Started

You have two options. **Pick the dev container path** unless you have a reason to install everything natively.

### Option A — Dev container (recommended)

One-time host install: **Docker Desktop** + **VS Code** + the **Dev Containers** extension. Then:

```bash
git clone https://github.com/sulkytejas/converge.git
cd converge
code .
```

VS Code will detect `.devcontainer/` and prompt **"Reopen in Container"** — click it. The first build takes a few minutes (downloading the Node + MySQL images). After that:

- `npm install` has run
- `.env` was created from `.env.example`
- The MySQL container is up at host `db:3306` (also forwarded to host `localhost:3306`)
- Schema from `prisma/sql/schema.sql` is applied
- The Prisma client is generated

Open the integrated terminal and run `npm run dev`. App is available at `http://localhost:3000`.

To enable real OTP delivery, fill in the `MSG91_*` keys in `.env`. Without them, OTPs are logged to the server console (sandbox mode).

### Option B — Native setup

Prerequisites: Node.js 20+, npm 10+, Docker (for the MySQL container), Git.

```bash
git clone https://github.com/sulkytejas/converge.git
cd converge
npm install
cp .env.example .env
./start-database.sh        # boots a local MySQL 8 container
npm run db:reset           # applies schema + generates Prisma client
npm run dev
```

---

## Useful scripts

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `npm run dev`            | Dev server with Turbopack                                         |
| `npm run build`          | Production build                                                  |
| `npm run start`          | Production server                                                 |
| `npm run db:reset`       | Drop DB, apply `prisma/sql/schema.sql` + `seed.sql`, regenerate client (interactive) |
| `npm run db:reset:force` | Same, no confirmation prompt                                      |
| `npm run db:push`        | Push Prisma schema to DB (Prisma-driven path)                     |
| `npm run db:studio`      | Open Prisma Studio                                                |
| `npm run lint`           | ESLint                                                            |
| `npm run typecheck`      | TypeScript type-check (`tsc --noEmit`)                            |
| `npm run format:write`   | Auto-format with Prettier                                         |

---

## Project Structure

```
converge/
├── .devcontainer/             # Dev container (Dockerfile, compose, post-create)
├── prisma/
│   ├── schema.prisma          # Prisma model definitions
│   └── sql/
│       ├── schema.sql         # Canonical MySQL DDL — applied by db-reset.sh
│       └── seed.sql           # Dev seed (dummy admin user)
├── scripts/
│   └── db-reset.sh            # Reset DB, apply schema.sql + seed.sql, regenerate Prisma client
├── public/                    # Static assets
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── admin/
│   │   │   ├── (dashboard)/   # Admin dashboard route group (sidebar+topbar layout)
│   │   │   │                  # → /admin/dashboard, /admin/students, /admin/partners, ...
│   │   │   └── login/         # Admin phone-OTP login (→ /admin/login)
│   │   ├── partner/(dashboard)/  # Partner dashboard route group
│   │   │                         # → /partner/dashboard, /partner/students, /partner/uni-assist,
│   │   │                         #   /partner/commission, /partner/resources, /partner/events
│   │   ├── login/             # Partner OTP login
│   │   ├── signup/            # Partner registration flow
│   │   ├── pending-verification/  # Shown when partner is not yet approved
│   │   ├── mou-signing/       # 4-step MOU acceptance (gated to approved partners)
│   │   ├── api/trpc/          # tRPC HTTP handler
│   │   ├── layout.tsx         # Root layout
│   │   └── page.tsx           # Redirects to /login
│   ├── components/
│   │   ├── dashboard/         # DashboardShell + PartnerDashboardShell, Sidebar, Topbar, nav configs
│   │   └── ui/                # Reusable UI primitives (button, inputs, modal, etc.)
│   ├── middleware.ts          # Gates /admin/* and /partner|/mou-signing|/pending-verification
│   ├── server/auth/jwt.ts     # Admin + partner session JWTs (jose, HS256, 8h TTL)
│   ├── server/
│   │   ├── api/routers/       # tRPC routers — auth (partner), admin-auth (admin), signup
│   │   ├── applications/      # Application/user persistence layer
│   │   ├── otp/               # OTP send/verify (MSG91 + sandbox provider)
│   │   └── db/enums.ts        # Domain enums for integer-coded columns
│   ├── trpc/                  # tRPC client setup (React provider, query client)
│   ├── styles/globals.css     # Tailwind + theme tokens
│   └── env.js                 # Zod schema for environment variables
├── generated/                 # Auto-generated Prisma client
├── start-database.sh          # Native-path Docker DB launcher
└── package.json
```

---

## Environment Variables

`.env.example` is the source of truth. Currently:

```bash
DATABASE_URL="mysql://root:password@localhost:3306/converge"

# MSG91 (SMS OTP — leave empty for sandbox: OTPs print to server log)
MSG91_AUTH_KEY=""
MSG91_SMS_TEMPLATE_ID=""

# Amazon SES (email — leave empty in dev: emails print to server log)
SES_ACCESS_KEY_ID=""
SES_SECRET_ACCESS_KEY=""

ADMIN_EMAIL=""
```

Variables are validated at startup by Zod (`src/env.js`). Set `SKIP_ENV_VALIDATION=1` to bypass the check during builds.

> Inside the dev container, `DATABASE_URL` is overridden by `.devcontainer/compose.yml` to point at the `db` service. Your `.env` is left untouched so the native-path workflow keeps working.

---

## Testing the UI

The dev DB seed (`prisma/sql/seed.sql`) adds a dummy admin so the admin flow works end-to-end on a fresh `npm run db:reset:force`. Without `MSG91_*` keys configured, OTPs print to the server log instead of being delivered (sandbox mode).

- **Admin login** (`/admin/login`) — phone-only OTP, gated by an email→phone match in the DB.
  - Seed user: `admin@collegepond.com` / `+91 9876543210`
  - Watch the server log for `[OTP:sandbox] SMS to 919876543210 => <code>`
  - Lands on `/admin/dashboard`.
- **Admin dashboard** (`/admin/dashboard`, `/admin/students`, `/admin/partners`, `/admin/universities`, `/admin/users`, `/admin/settings`, ...) — placeholder pages inside the shared sidebar+topbar shell.
- **Partner signup** (`/signup`) — full multi-step flow; uploads accept any file; the user gets persisted to the `user` table with `status = under_review`.
- **Partner login** (`/login`) — sign up first, then sign in with that email + phone. Email-OTP verified, phone-OTP sent but not verified yet. On success the response carries a `redirectUrl` based on partner state:
  - `under_review` / `rejected` / `inactive` → `/pending-verification` (warning page)
  - `approved` + MOU not signed → `/mou-signing` (4-step accept + canvas signature; partner must complete this)
  - `approved` + MOU signed → `/partner/dashboard`
- **Partner dashboard** (`/partner/dashboard`, `/partner/students`, `/partner/uni-assist`, `/partner/commission`, `/partner/resources`, `/partner/events`) — placeholder pages inside the shared sidebar+topbar shell. `last_login_at` is recorded on every dashboard mount (not on login itself).

---

## Planned scope

The sections below describe the target product — not all of it is implemented yet. Track the actual state via git history and the `src/app/admin/(dashboard)` route stubs.

### Feature modules

1. **Partner Registration & Onboarding** — multi-step form with OTP verification, document upload, admin approval. *(signup flow partially implemented; admin approval is dev-only)*
2. **Authentication & RBAC** — OTP login backed by a session table; roles enforced inside tRPC. *(OTP flow exists; session layer not yet wired)*
3. **MOU / Terms signing** — digital signature via Digio/Leegality on first admin login.
4. **Dashboard** — role-appropriate metrics and quick actions. *(shell scaffolded; content TBD)*
5. **Student Management** — profiles, academic history, documents, application timeline.
6. **Application Management** — status lifecycle from Draft to Enrolled, with notification triggers.
7. **University & Program Finder** — searchable directory with entry requirements and commissions.
8. **Commission Tracking** — tier, rates, history, payout schedule.
9. **Bank Details & Payouts** — cancelled cheque upload, account verification.
10. **Contracts** — view/download active MOUs.
11. **Team Management (Admin)** — add counselors/managers, send credentials.
12. **Notification Preferences** — per-channel delivery cadence.
13. **Education Loan Assistance** — initiate loan requests against a student.
14. **Excel Reports** — server-generated via ExcelJS.

### Roles

- **Admin** — full access across counselors, commissions, payments, team
- **Manager** — read-most across the partner org
- **Counselor** — own students and applications only

### Third-party integrations (planned)

| Service               | Provider                | Usage                                   |
| --------------------- | ----------------------- | --------------------------------------- |
| SMS / Email OTP       | MSG91                   | Verification + notifications *(active)* |
| Email                 | AWS SES                 | Transactional email                     |
| WhatsApp              | MSG91 / Gupshup         | Application status updates              |
| GST verification      | Masters India / Surepass | GSTIN validation                       |
| Aadhaar verification  | Surepass / Signzy       | KYC                                     |
| Payments              | Razorpay / RazorpayX    | Commission payouts                      |
| Digital signature     | Digio / Leegality       | MOU e-signature                         |
| File storage          | AWS S3                  | Documents, logos, signed MOUs           |

### Deployment (planned)

AWS via SST (OpenNext) into ap-south-1: Lambda compute, CloudFront CDN, RDS MySQL, S3, SES, SSM Parameter Store, CloudWatch.

| Environment | Host                                  |
| ----------- | ------------------------------------- |
| Local       | localhost:3000                        |
| Staging     | staging.converge.collegepond.com      |
| Production  | converge.collegepond.com              |

---

## Team

| Name             | Role                                           |
| ---------------- | ---------------------------------------------- |
| **Riana Nawany** | Architecture, development, testing, deployment |
| **Tejas Pashte** | Architecture, development, testing, deployment |

---

## License

Proprietary and confidential. Internal use only.
