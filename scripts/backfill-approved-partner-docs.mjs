#!/usr/bin/env node
// One-off backfill: partners and counsellors who are already approved (Active)
// but whose current documents still say "Pending".
//
// Since cfa2f94 (13 Oct 2026), approving a partner also approves its pending
// documents (approvePendingPartnerDocuments in src/server/applications/store.ts).
// Anyone approved before that reached an environment — and agency counsellors
// approved on Counselor Approvals before that path got the cascade — still
// has Pending documents. This applies the same cascade to them, once.
//
//   node scripts/backfill-approved-partner-docs.mjs
//       Preview (default). Lists every affected partner, what would change and
//       why, and changes nothing.
//   node scripts/backfill-approved-partner-docs.mjs --explain=<email>
//       Read-only: one partner's status, current documents and full audit
//       trail, to see why their documents weren't approved.
//   node scripts/backfill-approved-partner-docs.mjs --apply --confirm=<database>
//       Applies it. <database> must be the name of the database DATABASE_URL
//       points at (the preview prints it), so it can't hit the wrong one.
//
// Run it inside the app container (`doctl apps console <app-id> web`, or the
// app's Console tab), where DATABASE_URL is already set; locally it reads .env.
//
// Which documents: the partner's current (is_most_recent) non-student
// documents that are Pending — personal ones, plus the organization's for an
// agency owner. Same set as the in-app cascade. Two exceptions are left
// Pending, because they arrived after Collegepond's approval and still need
// a human look:
//   - documents created after the partner's latest logged approval, and
//   - for partners approved before approvals were logged (no approval entry
//     at all), documents an admin added on their behalf.
// Both are listed as "left for review".
//
// Idempotent: it only touches rows that are still Pending, so a second run
// finds nothing. Each partner is updated in its own transaction together with
// a partner.documents_approved audit entry.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name) => flag(name)?.split("=").slice(1).join("=") ?? null;
const apply = Boolean(flag("apply"));
const confirm = value("confirm");
const explain = value("explain");

const fail = (msg) => {
  console.error(`\n[backfill-docs] ${msg}`);
  process.exit(1);
};

// UserType / UserStatus / DocumentStatus (src/server/db/enums.ts).
const TYPE = { 0: "Agency owner", 1: "Agency counsellor", 2: "Independent" };
const AGENCY_OWNER = 0;
const APPROVED = 1;
const DOC_PENDING = 0;
const DOC_APPROVED = 1;
const DOC_STATUS = { 0: "pending", 1: "approved", 2: "rejected" };
const APPROVAL_ACTIONS = ["partner.status_updated", "counsellor.approved"];

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(ROOT, ".env");
  if (!existsSync(envFile)) fail("DATABASE_URL not set and .env missing.");
  const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => /^DATABASE_URL=/.test(l));
  if (!line) fail("DATABASE_URL not found in .env.");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

function connectionConfig(raw) {
  const u = new URL(raw);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  const cfg = {
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    timezone: "Z",
  };
  if (!isLocal) {
    const ca = process.env.DATABASE_CA_CERT?.trim();
    cfg.ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  return { cfg, database, label: `${database} @ ${u.hostname}` };
}

const iso = (d) => (d ? new Date(d).toISOString().replace(".000Z", "Z") : "—");
const meta = (m) => (typeof m === "string" ? JSON.parse(m) : (m ?? {}));

const { cfg, database, label } = connectionConfig(databaseUrl());
if (apply && confirm !== database) {
  fail(`--apply needs --confirm=${database} (the database this would change). Nothing was changed.`);
}
const db = await mysql.createConnection(cfg);
const q = async (sql, params) => (await db.query(sql, params))[0];

// A partner's current, non-student documents: personal, plus the org's for an
// agency owner (mirrors approvePendingPartnerDocuments).
async function currentDocs(u) {
  const ownsOrg = u.type === AGENCY_OWNER && u.org_id != null;
  return q(
    `SELECT id, doc_type, status, created_at FROM document
      WHERE is_most_recent = 1 AND student_id IS NULL
        AND (user_id = ? ${ownsOrg ? "OR (user_id IS NULL AND org_id = ?)" : ""})
      ORDER BY id`,
    ownsOrg ? [u.id, u.org_id] : [u.id],
  );
}

// Approval entries for a user: the Partners page logs partner.status_updated
// (metadata.to = "approved") since cfa2f94; Counselor Approvals logs
// counsellor.approved. Nothing was logged for partner approvals before that.
async function latestApproval(userId) {
  const rows = await q(
    `SELECT action, metadata, created_at FROM audit_log
      WHERE entity_type = 'user' AND entity_id = ? AND action IN (?)
      ORDER BY created_at DESC, id DESC`,
    [userId, APPROVAL_ACTIONS],
  );
  return rows.find((r) => r.action === "counsellor.approved" || meta(r.metadata).to === "approved") ?? null;
}

async function adminAddedDocIds(docIds) {
  if (docIds.length === 0) return new Set();
  const rows = await q(
    `SELECT entity_id FROM audit_log
      WHERE action = 'partner.document_added_by_admin' AND entity_type = 'document' AND entity_id IN (?)`,
    [docIds],
  );
  return new Set(rows.map((r) => r.entity_id));
}

try {
  console.log(`[backfill-docs] database: ${label}`);

  if (explain) {
    const [u] = await q(
      "SELECT id, type, status, org_id, email, first_name, last_name, created_at, deleted_at FROM `user` WHERE email = ?",
      [explain.toLowerCase()],
    );
    if (!u) fail(`No user with email ${explain}.`);
    console.log(`\n${u.first_name} ${u.last_name} <${u.email}> — user #${u.id}, ${TYPE[u.type] ?? `type ${u.type}`}, status ${u.status}${u.deleted_at ? ", REMOVED" : ""}, signed up ${iso(u.created_at)}`);
    console.log("\nCurrent documents:");
    for (const d of await currentDocs(u)) console.log(`  #${d.id} ${d.doc_type.padEnd(16)} ${DOC_STATUS[d.status] ?? d.status}  uploaded ${iso(d.created_at)}`);
    console.log("\nAudit trail (oldest first):");
    const trail = await q(
      `SELECT action, metadata, created_at FROM audit_log
        WHERE (entity_type = 'user' AND entity_id = ?) OR user_id = ?
        ORDER BY created_at, id`,
      [u.id, u.id],
    );
    if (trail.length === 0) console.log("  (none)");
    for (const a of trail) console.log(`  ${iso(a.created_at)}  ${a.action}  ${JSON.stringify(meta(a.metadata))}`);
    const appr = await latestApproval(u.id);
    console.log(
      appr
        ? `\nLatest logged approval: ${iso(appr.created_at)} (${appr.action}).`
        : "\nNo approval is logged. Partner approvals weren't audited before cfa2f94 reached this environment (staging: 13 Oct 2026 ~11:49 UTC), so this partner was approved before approving also verified documents.",
    );
    process.exit(0);
  }

  const users = await q(
    `SELECT id, type, org_id, email, first_name, last_name FROM \`user\`
      WHERE status = ? AND deleted_at IS NULL AND type IN (0, 1, 2)
      ORDER BY id`,
    [APPROVED],
  );

  const plan = [];
  for (const u of users) {
    const pending = (await currentDocs(u)).filter((d) => d.status === DOC_PENDING);
    if (pending.length === 0) continue;
    const appr = await latestApproval(u.id);
    const adminAdded = await adminAddedDocIds(pending.map((d) => d.id));
    const approve = [];
    const leave = [];
    for (const d of pending) {
      if (appr && new Date(d.created_at) > new Date(appr.created_at)) {
        leave.push({ d, why: "uploaded after the approval" });
      } else if (!appr && adminAdded.has(d.id)) {
        leave.push({ d, why: "added by an admin; approval time unknown" });
      } else {
        approve.push(d);
      }
    }
    plan.push({ u, appr, approve, leave });
  }

  const docLine = (d) => `#${d.id} ${d.doc_type} (uploaded ${iso(d.created_at)})`;
  if (plan.length === 0) console.log("\nNo approved partner has pending current documents. Nothing to do.");
  for (const { u, appr, approve, leave } of plan) {
    console.log(`\n${u.first_name} ${u.last_name} <${u.email}> — user #${u.id}, ${TYPE[u.type]}`);
    console.log(
      `  approval: ${appr ? `${iso(appr.created_at)} via ${appr.action}` : "not logged (approved before approvals were audited)"}`,
    );
    for (const d of approve) console.log(`  approve  ${docLine(d)}`);
    for (const { d, why } of leave) console.log(`  leave    ${docLine(d)} — ${why}`);
  }
  const total = plan.reduce((s, p) => s + p.approve.length, 0);
  const left = plan.reduce((s, p) => s + p.leave.length, 0);
  const partners = plan.filter((p) => p.approve.length > 0).length;
  console.log(`\nSummary: ${total} document(s) to approve across ${partners} partner(s); ${left} left for review.`);

  if (!apply) {
    console.log(`\nPreview only. To apply: node scripts/backfill-approved-partner-docs.mjs --apply --confirm=${database}`);
    process.exit(0);
  }

  let changed = 0;
  for (const { u, approve } of plan) {
    if (approve.length === 0) continue;
    const ids = approve.map((d) => d.id);
    await db.beginTransaction();
    try {
      // Re-checks Pending, so a document someone just verified or rejected
      // isn't overwritten, and a rerun changes nothing.
      const [res] = await db.query(
        "UPDATE document SET status = ? WHERE id IN (?) AND status = ? AND is_most_recent = 1",
        [DOC_APPROVED, ids, DOC_PENDING],
      );
      if (res.affectedRows > 0) {
        await db.query(
          `INSERT INTO audit_log (user_id, org_id, action, entity_type, entity_id, metadata)
           VALUES (?, ?, 'partner.documents_approved', 'user', ?, ?)`,
          [
            u.id,
            u.org_id,
            u.id,
            JSON.stringify({
              reason: "Backfill: approved before approving also verified documents",
              documentIds: ids,
              docTypes: approve.map((d) => d.doc_type),
              byCpUserId: null,
              script: "backfill-approved-partner-docs",
            }),
          ],
        );
      }
      await db.commit();
      changed += res.affectedRows;
      console.log(`  ${u.email}: ${res.affectedRows} approved`);
    } catch (e) {
      await db.rollback();
      throw e;
    }
  }
  console.log(`\nDone. ${changed} document(s) approved.`);
} finally {
  await db.end();
}
