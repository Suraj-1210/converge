#!/usr/bin/env node
// Finds agency counsellors who are no longer linked to their agency, and
// relinks the ones that are safe to fix automatically.
//
//   node scripts/fix-counsellor-links.mjs            # preview: reports, changes nothing
//   node scripts/fix-counsellor-links.mjs --execute  # preview, then asks you to type
//                                                     # "RELINK <database>" before changing
//
// Run it inside the app container (`doctl apps console <app-id> web`), where
// DATABASE_URL is already set; locally it reads .env.
//
// How the damage happened: public signup used to upsert by email, so an
// owner-added counsellor who later filled in /signup was overwritten — as an
// Independent Counsellor (type 2, no org) or as an agency owner (type 0, which
// also renamed the agency and replaced its documents). The audit log still
// says which agency added them ("counsellor.invited", metadata.orgId).
//
// Automatic repair (only with --execute):
//   invited counsellor now type 2 with no org  →  type 1, org = inviting agency,
//   is_owner 0; the students they created while unlinked move into that agency,
//   assigned to them. Each repair is audit-logged ("counsellor.relinked").
// Everything else is listed for a person to decide (e.g. a counsellor who
// became an owner), never changed.
//
// The last section says whether the database is ready for migration
// 20261013120000_user_partner_org_check (agency user ⇔ has an org).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import mysql from "mysql2/promise";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");
const TYPE = { 0: "agency owner", 1: "agency counsellor", 2: "independent", 10: "admin" };
const fail = (msg) => {
  console.error(`\n[fix-counsellor-links] ${msg}`);
  process.exit(1);
};

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
  };
  if (!isLocal) {
    const ca = process.env.DATABASE_CA_CERT?.trim();
    cfg.ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  return { cfg, label: `${database} @ ${u.hostname}`, database };
}

const { cfg, label, database } = connectionConfig(databaseUrl());
const db = await mysql.createConnection(cfg);
const q = async (sql, params) => (await db.query(sql, params))[0];
const who = (r) => `#${r.id} ${r.name}`;

try {
  console.log(`\nDatabase: ${label}${execute ? "" : "   (preview — nothing will change)"}\n`);

  // ---- 1. Counsellors added by an agency (audit trail) ----
  const invited = await q(`
    SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) AS name, u.type, u.is_owner, u.org_id,
           u.status, u.deleted_at, inv.org_id AS invited_org, o.name AS invited_org_name, inv.at AS invited_at
    FROM (
      SELECT user_id, org_id, MIN(at) AS at
      FROM (
        SELECT entity_id AS user_id,
               CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.orgId')) AS UNSIGNED) AS org_id,
               created_at AS at
        FROM audit_log WHERE action = 'counsellor.invited' AND entity_type = 'user'
      ) a
      GROUP BY user_id, org_id
    ) inv
    JOIN \`user\` u ON u.id = inv.user_id
    LEFT JOIN organization o ON o.id = inv.org_id
    ORDER BY inv.at`);

  const ok = [];
  const fixable = [];
  const manual = [];
  for (const r of invited) {
    if (r.type === 1 && r.org_id === r.invited_org) ok.push(r);
    else if (r.type === 2 && r.org_id === null && r.invited_org_name !== null) fixable.push(r);
    else manual.push(r);
  }
  for (const r of fixable) {
    const [{ n }] = await q(
      "SELECT COUNT(*) AS n FROM student WHERE created_by_user_id = ? AND org_id IS NULL",
      [r.id],
    );
    r.students = Number(n);
  }

  console.log(`1. Counsellors added by an agency: ${invited.length}`);
  console.log(`   correctly linked: ${ok.length}`);
  console.log(`   turned independent — will be relinked: ${fixable.length}`);
  for (const r of fixable) {
    console.log(
      `     ${who(r)}  → agency #${r.invited_org} "${r.invited_org_name}"` +
        `${r.students ? `, with ${r.students} student(s) they created` : ""}`,
    );
  }
  console.log(`   needs a decision (not changed): ${manual.length}`);
  for (const r of manual) {
    const why =
      r.invited_org_name === null
        ? `inviting agency #${r.invited_org} no longer exists`
        : r.type === 0
          ? `now an agency owner (org #${r.org_id ?? "none"}${r.org_id === r.invited_org ? ", the same agency — it has two owners" : ""})`
          : `now ${TYPE[r.type] ?? `type ${r.type}`} with org #${r.org_id ?? "none"}`;
    console.log(`     ${who(r)}  added by #${r.invited_org} "${r.invited_org_name ?? "?"}": ${why}`);
  }

  // ---- 2. Structural anomalies, whatever their history ----
  const anomalies = await q(`
    SELECT id, CONCAT(first_name, ' ', last_name) AS name, type, is_owner, org_id
    FROM \`user\`
    WHERE type IN (0, 1, 2)
      AND ((type = 2) <> (org_id IS NULL)
           OR (type = 0 AND is_owner <> 1)
           OR (type <> 0 AND is_owner = 1))
    ORDER BY id`);
  const multiOwner = await q(`
    SELECT org_id, COUNT(*) AS n FROM \`user\`
    WHERE is_owner = 1 AND org_id IS NOT NULL GROUP BY org_id HAVING n > 1`);
  const fixableIds = new Set(fixable.map((r) => r.id));
  const otherAnomalies = anomalies.filter((r) => !fixableIds.has(r.id));
  console.log(`\n2. Other inconsistent partner rows: ${otherAnomalies.length}`);
  for (const r of otherAnomalies) {
    console.log(`     ${who(r)}  ${TYPE[r.type]}, org #${r.org_id ?? "none"}, is_owner ${r.is_owner}`);
  }
  console.log(`   agencies with more than one owner: ${multiOwner.length}`);
  for (const r of multiOwner) console.log(`     org #${r.org_id}: ${r.n} owners`);

  // ---- 3. Readiness for the org CHECK constraint ----
  const blocking = anomalies.filter((r) => (r.type === 2) !== (r.org_id === null));
  const blockingAfter = blocking.filter((r) => !fixableIds.has(r.id));
  console.log(
    `\n3. Rows that would block the org CHECK constraint: ${blocking.length}` +
      ` (${blockingAfter.length} after the automatic repair)`,
  );
  console.log(
    blocking.length === 0
      ? "   Ready for migration 20261013140000_user_partner_org_check."
      : blockingAfter.length === 0
        ? "   Ready for migration 20261013140000_user_partner_org_check after --execute."
        : "   NOT ready: resolve the rows listed above first.",
  );

  if (!execute) {
    console.log("\nPreview only. Re-run with --execute to relink the counsellors listed under 1.\n");
    process.exit(0);
  }
  if (fixable.length === 0) {
    console.log("\nNothing to repair automatically.\n");
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType "RELINK ${database}" to relink ${fixable.length} counsellor(s): `);
  rl.close();
  if (answer.trim() !== `RELINK ${database}`) fail("Confirmation did not match — nothing changed.");

  await db.beginTransaction();
  try {
    for (const r of fixable) {
      // Re-check inside the transaction: only touch rows still in the state we reported.
      const res = await q(
        "UPDATE `user` SET type = 1, is_owner = 0, org_id = ? WHERE id = ? AND type = 2 AND org_id IS NULL",
        [r.invited_org, r.id],
      );
      if (res.affectedRows !== 1) throw new Error(`#${r.id} changed since the preview — aborting`);
      const moved = await q(
        "UPDATE student SET org_id = ?, counsellor_id = ? WHERE created_by_user_id = ? AND org_id IS NULL",
        [r.invited_org, r.id, r.id],
      );
      await q(
        "INSERT INTO audit_log (action, entity_type, entity_id, metadata) VALUES ('counsellor.relinked', 'user', ?, ?)",
        [
          r.id,
          JSON.stringify({
            by: "scripts/fix-counsellor-links.mjs",
            from: { type: r.type, orgId: r.org_id },
            to: { type: 1, orgId: r.invited_org },
            studentsMoved: moved.affectedRows,
          }),
        ],
      );
      console.log(`   relinked ${who(r)} → #${r.invited_org}, ${moved.affectedRows} student(s) moved`);
    }
    await db.commit();
    console.log("\nDone.\n");
  } catch (e) {
    await db.rollback();
    fail(`Rolled back, nothing changed: ${e.message}`);
  }
} finally {
  await db.end();
}
