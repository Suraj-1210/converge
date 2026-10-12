#!/usr/bin/env node
// One-off "start fresh" reset: removes every partner (and everything that
// hangs off partners — students, applications, commissions, invoices,
// payouts, documents, notifications, BDM pipeline) and every staff account
// except the ones in KEEP_STAFF. Reference data stays: universities, courses,
// commission contracts and rates, vendors, events, FX rates, geo lists,
// settings, migration history.
//
//   node scripts/reset-data.mjs            # preview: counts only, changes nothing
//   node scripts/reset-data.mjs --execute  # preview, then asks you to type
//                                          # "WIPE <database>" before deleting
//
// Run it inside the app container (`doctl apps console <app-id> web`), where
// DATABASE_URL and SPACES_* are already set. Before deleting, every row about
// to be removed is saved as gzipped JSON to private storage
// (Spaces: backups/reset-<db>-<time>.json.gz; locally: ./backups/). The
// deletes run in one transaction with foreign-key checks on, so it either
// completes or changes nothing. Uploaded files (documents, MOU PDFs) are not
// touched.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { gzipSync } from "node:zlib";
import mysql from "mysql2/promise";

const KEEP_STAFF = ["arjun@collegepond.com", "suraj@collegepond.com"];

// Emptied completely.
const WIPE_TABLES = [
  "organization", "user", "session", "notification", "notification_preference",
  "document", "event_registration", "event_reminder", "otp_code",
  "student", "student_education", "student_emergency_contact", "student_note",
  "student_test_score", "student_work_experience", "shortlist", "whatsapp_message",
  "application", "application_stage_history", "application_portal_credential",
  "commission", "commission_tranche", "invoice", "invoice_item", "partner_payout",
  "partner_bank_account", "vendor_invoice", "vendor_invoice_item", "vendor_payment",
  "bdm_prospect", "bdm_prospect_stage_history", "bdm_activity", "bdm_task",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");
const fail = (msg) => {
  console.error(`\n[reset-data] ${msg}`);
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
  return { cfg, label: `${database} @ ${u.hostname}` };
}

const { cfg, label } = connectionConfig(databaseUrl());
const db = await mysql.createConnection(cfg);
const q = async (sql, params) => (await db.query(sql, params))[0];

try {
  const tables = new Set(
    (await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()")).map((r) => r.t),
  );
  const wipe = WIPE_TABLES.filter((t) => tables.has(t));
  const fks = await q(`
    SELECT k.table_name AS child, k.column_name AS col, k.referenced_table_name AS parent, r.delete_rule AS rule
    FROM information_schema.key_column_usage k
    JOIN information_schema.referential_constraints r
      ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
    WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL`);

  // ---- Staff ----
  const staff = await q("SELECT id, email, CONCAT(first_name, ' ', last_name) AS name FROM cp_user ORDER BY id");
  const keep = staff.filter((s) => KEEP_STAFF.includes(s.email.toLowerCase()));
  const drop = staff.filter((s) => !KEEP_STAFF.includes(s.email.toLowerCase()));
  for (const email of KEEP_STAFF) {
    if (!keep.some((s) => s.email.toLowerCase() === email)) fail(`Staff account ${email} not found — refusing to run (it would leave no way in).`);
  }
  const dropIds = drop.map((s) => s.id);

  // ---- Anything outside the wipe set that would block or be affected ----
  const problems = [];
  const sideEffects = [];
  const wipeSet = new Set(wipe);
  for (const fk of fks) {
    if (wipeSet.has(fk.child)) continue;
    let n = 0;
    if (wipeSet.has(fk.parent)) {
      [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${fk.child}\` WHERE \`${fk.col}\` IS NOT NULL`);
    } else if (fk.parent === "cp_user" && fk.child !== "cp_user" && dropIds.length) {
      [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${fk.child}\` WHERE \`${fk.col}\` IN (?)`, [dropIds]);
    }
    if (!n) continue;
    if (fk.child === "audit_log") continue; // handled below
    const what = `${fk.child}.${fk.col} -> ${fk.parent}: ${n} row(s), ON DELETE ${fk.rule}`;
    if (fk.rule === "CASCADE" || fk.rule === "SET NULL") sideEffects.push(what);
    else problems.push(what);
  }

  // Audit entries about partners/orgs go (their FKs would block); staff-only
  // entries stay as history.
  const [{ n: auditRows }] = await q("SELECT COUNT(*) AS n FROM audit_log WHERE user_id IS NOT NULL OR org_id IS NOT NULL");

  // ---- Delete order: children before parents ----
  const order = [];
  const pending = new Set(wipe);
  while (pending.size) {
    const ready = [...pending].filter((t) =>
      !fks.some((fk) => fk.parent === t && fk.child !== t && pending.has(fk.child)),
    );
    if (!ready.length) fail(`Circular foreign keys among: ${[...pending].join(", ")}`);
    for (const t of ready.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }

  // ---- Preview ----
  console.log(`\nDatabase: ${label}\n`);
  console.log(`Staff kept (${keep.length}):`);
  for (const s of keep) console.log(`  ${s.name} <${s.email}>`);
  console.log(`Staff deleted (${drop.length}):`);
  for (const s of drop) console.log(`  ${s.name} <${s.email}>`);
  console.log("\nRows deleted:");
  const counts = {};
  for (const t of order) {
    const [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${t}\``);
    counts[t] = n;
    if (n) console.log(`  ${t.padEnd(32)} ${n}`);
  }
  console.log(`  ${"audit_log (partner entries)".padEnd(32)} ${auditRows}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0) + auditRows + drop.length;
  console.log(`  ${"cp_user".padEnd(32)} ${drop.length}`);
  console.log(`  ${"TOTAL".padEnd(32)} ${total}`);
  if (sideEffects.length) {
    console.log("\nAlso changed automatically by the database:");
    for (const s of sideEffects) console.log(`  ${s}`);
  }
  if (problems.length) {
    console.log("\nBLOCKED — rows outside the reset still point at data it would delete:");
    for (const p of problems) console.log(`  ${p}`);
    fail("Nothing was changed.");
  }

  if (!execute) {
    console.log("\nPreview only — nothing was changed. Re-run with --execute to delete.");
    process.exit(0);
  }
  const phrase = `WIPE ${cfg.database}`;
  let answer = process.argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
  if (answer === undefined) {
    if (!process.stdin.isTTY) fail(`--execute needs an interactive terminal, or --confirm="${phrase}".`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    answer = await rl.question(`\nThis permanently deletes the rows above. Type "${phrase}" to continue: `);
    rl.close();
  }
  if (answer.trim() !== phrase) fail("Confirmation didn't match. Nothing was changed.");

  // ---- Backup, then delete, in one transaction ----
  await db.beginTransaction();
  try {
    const backup = { database: label, takenAt: new Date().toISOString(), keptStaff: KEEP_STAFF, tables: {} };
    for (const t of order) backup.tables[t] = await q(`SELECT * FROM \`${t}\` FOR UPDATE`);
    backup.tables.audit_log = await q("SELECT * FROM audit_log WHERE user_id IS NOT NULL OR org_id IS NOT NULL FOR UPDATE");
    backup.tables.cp_user = dropIds.length ? await q("SELECT * FROM cp_user WHERE id IN (?) FOR UPDATE", [dropIds]) : [];
    const where = await saveBackup(cfg.database, gzipSync(JSON.stringify(backup)));
    console.log(`\nBackup saved: ${where}`);

    await q("DELETE FROM audit_log WHERE user_id IS NOT NULL OR org_id IS NOT NULL");
    for (const t of order) {
      const res = await q(`DELETE FROM \`${t}\``);
      if (res.affectedRows) console.log(`  deleted ${String(res.affectedRows).padStart(6)}  ${t}`);
    }
    if (dropIds.length) {
      const res = await q("DELETE FROM cp_user WHERE id IN (?)", [dropIds]);
      console.log(`  deleted ${String(res.affectedRows).padStart(6)}  cp_user`);
    }
    await db.commit();
    console.log("\nDone. Committed.");
  } catch (err) {
    await db.rollback();
    fail(`Failed, rolled back — nothing was changed.\n${err?.stack ?? err}`);
  }
} finally {
  await db.end().catch(() => {});
}

async function saveBackup(database, body) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backups/reset-${database}-${stamp}.json.gz`;
  const e = process.env;
  if (e.SPACES_KEY && e.SPACES_SECRET && e.SPACES_BUCKET && e.SPACES_REGION && e.SPACES_ENDPOINT) {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      region: e.SPACES_REGION,
      endpoint: e.SPACES_ENDPOINT,
      credentials: { accessKeyId: e.SPACES_KEY, secretAccessKey: e.SPACES_SECRET },
    });
    await s3.send(new PutObjectCommand({
      Bucket: e.SPACES_BUCKET, Key: key, Body: body, ContentType: "application/gzip", ACL: "private",
    }));
    return `spaces://${e.SPACES_BUCKET}/${key}`;
  }
  const file = join(ROOT, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}
