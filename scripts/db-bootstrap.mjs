#!/usr/bin/env node
// =============================================================================
// Converge — DB bootstrap (fresh environment)
// =============================================================================
// Brings an EMPTY database up to the current schema:
//   1. applies prisma/sql/schema.sql   (the full structure — source of truth)
//   2. applies prisma/sql/seed.sql     (dev/staging accounts; --no-seed to skip)
//   3. records every file in prisma/sql/migrations/ as already applied —
//      except reference-data files (*_data.sql), which it runs first
//
// Step 3 matters: schema.sql already contains every delta but does not populate
// schema_migrations, so without it db-apply.mjs would later try to re-apply
// migrations onto columns that already exist. See its baseline note.
// *_data.sql files load rows (e.g. the geo_* location master list) that
// schema.sql cannot carry; they are idempotent, so running them is safe.
//
// Like db-apply.mjs this talks to MySQL through mysql2, so it runs inside the
// App Platform container where no `mysql` client exists.
//
// Usage (from the app console of a NEW environment):
//   npm run db:bootstrap
//   npm run db:bootstrap -- --no-seed     # structure only, no sample data
//
// REFUSES to run against a database that already has tables. This is not a
// migration tool and must never be pointed at production.
// =============================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_DIR = join(ROOT, "prisma", "sql");
const MIG_DIR = join(SQL_DIR, "migrations");
const ENV_FILE = join(ROOT, ".env");

const argv = new Set(process.argv.slice(2));
const SEED = !argv.has("--no-seed");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "db"]);

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(ENV_FILE)) fail(`DATABASE_URL not set and ${ENV_FILE} missing.`);
  const line = readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^DATABASE_URL=/.test(l))
    .pop();
  if (!line) fail("DATABASE_URL not found in .env.");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

const u = new URL(databaseUrl());
const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
if (!database) fail("could not parse database name from DATABASE_URL.");

const cfg = {
  host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
  port: Number(u.port) || 3306,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database,
  multipleStatements: true,
};
if (!LOCAL_HOSTS.has(u.hostname)) {
  const ca = process.env.DATABASE_CA_CERT?.trim();
  cfg.ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

console.log(`Target: ${cfg.user}@${cfg.host}:${cfg.port}/${database}`);

const conn = await mysql.createConnection(cfg);
try {
  const [[{ n: existing }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?",
    [database],
  );
  if (existing > 0) {
    console.error("");
    console.error(`Error: '${database}' already has ${existing} table(s).`);
    console.error("");
    console.error("  db:bootstrap is only for EMPTY databases. To move an existing");
    console.error("  one forward use `npm run db:apply`. To wipe a LOCAL dev");
    console.error("  database use `npm run db:reset:force`.");
    console.error("");
    process.exit(1);
  }

  console.log("Applying schema.sql...");
  await conn.query(readFileSync(join(SQL_DIR, "schema.sql"), "utf8"));

  if (SEED && existsSync(join(SQL_DIR, "seed.sql"))) {
    console.log("Applying seed.sql...");
    await conn.query(readFileSync(join(SQL_DIR, "seed.sql"), "utf8"));
  } else {
    console.log("Skipping seed.sql.");
  }

  await conn.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version VARCHAR(255) NOT NULL, " +
      "applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
      "PRIMARY KEY (version)) ENGINE=InnoDB",
  );

  const files = existsSync(MIG_DIR)
    ? readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()
    : [];
  const dataFiles = files.filter((f) => f.endsWith("_data.sql"));
  for (const f of dataFiles) {
    console.log(`Loading reference data ${f}...`);
    await conn.query(readFileSync(join(MIG_DIR, f), "utf8"));
  }
  for (const f of files) {
    await conn.query("INSERT IGNORE INTO schema_migrations (version) VALUES (?)", [f]);
  }
  console.log(
    `Baselined ${files.length} migration(s) — only the ${dataFiles.length} *_data.sql file(s) were executed.`,
  );

  const [[{ n: tables }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?",
    [database],
  );
  console.log(`\nDone. '${database}' now has ${tables} table(s).`);
} finally {
  await conn.end().catch(() => {});
}
