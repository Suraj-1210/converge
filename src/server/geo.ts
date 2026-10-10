// Location master list (geo_country / geo_state / geo_city, from GeoNames).
// Read by the public `geo` router for the signup pickers, and used to check a
// submitted country / state / city on the server, so the list the client
// shows is also the list the API enforces.

import { db } from "~/server/db";

export async function listCountries(): Promise<{ iso2: string; name: string }[]> {
  return db.geo_country.findMany({
    orderBy: { name: "asc" },
    select: { iso2: true, name: true },
  });
}

export async function listStates(country: string): Promise<string[]> {
  const rows = await db.geo_state.findMany({
    where: { country_iso2: country.toUpperCase() },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  return [...new Set(rows.map((r) => r.name))];
}

// Cities in `state`, or — for a country with no first-level divisions — every
// city in the country.
export async function listCities(country: string, state: string | null): Promise<string[]> {
  const rows = await db.geo_city.findMany({
    where: {
      country_iso2: country.toUpperCase(),
      ...(state ? { state: { name: state } } : {}),
    },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  return [...new Set(rows.map((r) => r.name))];
}

export type LocationCheck =
  | { ok: true; country: string; state: string | null; city: string }
  | { ok: false; field: "country" | "state" | "city"; message: string };

// Validates a submitted location against the master list. Country and state
// must come from the list. The city may be typed in by hand ("my city isn't
// listed"); when it does match a listed city its canonical spelling is used.
export async function checkLocation(input: {
  country?: string | null;
  state?: string | null;
  city?: string | null;
}): Promise<LocationCheck> {
  const iso2 = input.country?.trim().toUpperCase() ?? "";
  const country = iso2
    ? await db.geo_country.findUnique({ where: { iso2 }, select: { iso2: true } })
    : null;
  if (!country) return { ok: false, field: "country", message: "Select a country from the list" };

  const states = await listStates(iso2);
  const stateName = input.state?.trim() ?? "";
  let state: string | null = null;
  if (states.length > 0) {
    state = states.find((s) => s.toLowerCase() === stateName.toLowerCase()) ?? null;
    if (!state) return { ok: false, field: "state", message: "Select a state from the list" };
  }

  const typed = input.city?.trim().replace(/\s+/g, " ") ?? "";
  if (!typed) return { ok: false, field: "city", message: "City is required" };
  if (typed.length > 100) return { ok: false, field: "city", message: "City name is too long" };
  const listed = await db.geo_city.findFirst({
    where: {
      country_iso2: iso2,
      name: typed, // column collation is case- and accent-insensitive
      ...(state ? { state: { name: state } } : {}),
    },
    select: { name: true },
  });

  return { ok: true, country: iso2, state, city: listed?.name ?? typed };
}
