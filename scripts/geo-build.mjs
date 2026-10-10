#!/usr/bin/env node
// =============================================================================
// Converge — build the location master list (geo_country / geo_state / geo_city)
// =============================================================================
// Regenerates prisma/sql/migrations/20261010120100_geo_master_data.sql from a
// GeoNames export. Only needed to refresh the data; deploys just apply the file.
//
// Source: GeoNames (https://www.geonames.org), licensed CC BY 4.0. Attribution
// is shown on the signup page under the location fields; keep it there.
//
// Download into an empty directory, unzip cities1000.zip, then:
//   https://download.geonames.org/export/dump/countryInfo.txt
//   https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   https://download.geonames.org/export/dump/cities1000.zip
//
//   node scripts/geo-build.mjs <dir-with-those-files> [output.sql]
//
// What goes in:
//   countries  every current country (defunct AN / CS dropped)
//   states     every first-level division (GeoNames admin1)
//   cities     populated places with population >= 1000, minus city sections
//              (PPLX, except in India) and historical/abandoned/destroyed places. Duplicate
//              names within one state collapse to the most populous entry,
//              since partners pick a name, not a geoname id.
// South Asian names use GeoNames' ASCII form ("Thane", not "Thāne"), which is
// how they are written locally in English.
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2];
const OUT =
  process.argv[3] ??
  join(ROOT, "prisma", "sql", "migrations", "20261010120100_geo_master_data.sql");
if (!SRC) {
  console.error("Usage: node scripts/geo-build.mjs <geonames-dir> [output.sql]");
  process.exit(1);
}

const DEFUNCT_COUNTRIES = new Set(["AN", "CS"]);
const SKIP_FEATURES = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);
// GeoNames files some real Indian cities as PPLX (Navi Mumbai, Theni, Baranagar),
// and India has only ~60 PPLX entries, so keep them there.
const KEEP_SECTIONS_IN = new Set(["IN"]);
const ASCII_NAME_COUNTRIES = new Set(["IN", "NP", "BD", "LK", "PK", "BT", "MV"]);
// organization.city / organization.state are VARCHAR(100).
const MAX_NAME = 100;
const CHUNK = 2000;

const rows = (file) =>
  readFileSync(join(SRC, file), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/\r$/, "").split("\t"));

const sq = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

// --- countries ---------------------------------------------------------------
const countries = rows("countryInfo.txt")
  .filter((c) => !DEFUNCT_COUNTRIES.has(c[0]))
  .map((c) => ({ iso2: c[0], name: c[4] }));
const countrySet = new Set(countries.map((c) => c.iso2));

// --- states (admin1) ---------------------------------------------------------
const stateByKey = new Map(); // "IN.16" -> state
for (const [key, name, ascii, id] of rows("admin1CodesASCII.txt")) {
  const [iso2, code] = key.split(".");
  if (!countrySet.has(iso2)) continue;
  const display = (ASCII_NAME_COUNTRIES.has(iso2) ? ascii : name).trim();
  if (!display || display.length > MAX_NAME) continue;
  stateByKey.set(key, { id: Number(id), iso2, code, name: display });
}

// --- cities ------------------------------------------------------------------
const best = new Map(); // country|stateId|lower(name) -> city
for (const r of rows("cities1000.txt")) {
  const [id, name, ascii, , , , , feature, iso2, , admin1, , , , population] = r;
  if (!countrySet.has(iso2)) continue;
  if (SKIP_FEATURES.has(feature) && !(feature === "PPLX" && KEEP_SECTIONS_IN.has(iso2))) continue;
  const display = (ASCII_NAME_COUNTRIES.has(iso2) ? ascii : name).trim();
  if (!display || display.length > MAX_NAME) continue;
  const state = stateByKey.get(`${iso2}.${admin1}`);
  const city = {
    id: Number(id),
    iso2,
    stateId: state?.id ?? null,
    name: display,
    population: Number(population) || 0,
  };
  const key = `${iso2}|${city.stateId}|${display.toLowerCase()}`;
  const prev = best.get(key);
  if (!prev || city.population > prev.population) best.set(key, city);
}
const cities = [...best.values()].sort((a, b) => a.id - b.id);
const states = [...stateByKey.values()].sort((a, b) => a.id - b.id);

// --- SQL -----------------------------------------------------------------------
function inserts(table, cols, items, toValues) {
  const out = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const values = items.slice(i, i + CHUNK).map((x) => `(${toValues(x)})`);
    out.push(`INSERT INTO \`${table}\` (${cols}) VALUES\n${values.join(",\n")};`);
  }
  return out.join("\n");
}

const sql = `-- Location master list for partner signup: countries, states and cities.
-- GENERATED by scripts/geo-build.mjs — do not edit by hand; rerun the script.
--
-- Data: GeoNames (https://www.geonames.org), CC BY 4.0. Cities are populated
-- places with population >= 1000.
-- ${countries.length} countries, ${states.length} states, ${cities.length} cities.
--
-- Reference data, not schema: the file is idempotent (it replaces the whole
-- list), and db:bootstrap runs *_data.sql files instead of baselining them, so
-- fresh environments get the data too.

DELETE FROM \`geo_city\`;
DELETE FROM \`geo_state\`;
DELETE FROM \`geo_country\`;

${inserts("geo_country", "`iso2`, `name`", countries, (c) => `${sq(c.iso2)},${sq(c.name)}`)}

${inserts("geo_state", "`id`, `country_iso2`, `code`, `name`", states, (s) => `${s.id},${sq(s.iso2)},${sq(s.code)},${sq(s.name)}`)}

${inserts("geo_city", "`id`, `country_iso2`, `state_id`, `name`, `population`", cities, (c) => `${c.id},${sq(c.iso2)},${c.stateId ?? "NULL"},${sq(c.name)},${c.population}`)}
`;

writeFileSync(OUT, sql);
console.log(
  `Wrote ${OUT}\n  ${countries.length} countries, ${states.length} states, ${cities.length} cities ` +
    `(${(sql.length / 1024 / 1024).toFixed(1)} MB)`,
);
