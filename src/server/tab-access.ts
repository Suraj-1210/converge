import "server-only";
import { db } from "~/server/db";
import { type AdminSection, resolveSections } from "~/lib/admin-sections";
import { type PartnerTab, resolvePartnerTabs } from "~/lib/partner-tabs";

// Effective tab access (Super Admin's tab switches, 27 Oct 2026): per tab, the
// user's override ?? their type's saved default ?? the built-in default. The
// rules live in ~/lib/admin-sections and ~/lib/partner-tabs; this only loads
// the saved rows. Nothing is copied onto users, so a user created later picks
// up their type's default, and a type change takes effect on the next request.

export type TabPortal = "admin" | "partner";

// One lookup per user per request: tRPC batches share the context, so the
// sidebar, page gate and every gated procedure in a batch read the same set.
export type TabAccessCache = Map<string, Promise<readonly string[]>>;

function toMap(rows: { tab: string; enabled: number }[]): Map<string, boolean> {
  return new Map(rows.map((r) => [r.tab, r.enabled === 1]));
}

async function loadRows(portal: TabPortal, userId: number, type: number) {
  const [defaults, overrides] = await Promise.all([
    db.cp_tab_default.findMany({
      where: { portal, user_type: type },
      select: { tab: true, enabled: true },
    }),
    db.cp_tab_override.findMany({
      where: portal === "admin" ? { cp_user_id: userId } : { user_id: userId },
      select: { tab: true, enabled: true },
    }),
  ]);
  return { defaults: toMap(defaults), overrides: toMap(overrides) };
}

export async function adminSectionsFor(cpUserId: number, role: number): Promise<AdminSection[]> {
  const { defaults, overrides } = await loadRows("admin", cpUserId, role);
  return resolveSections(role, defaults, overrides);
}

export async function partnerTabsFor(userId: number, type: number): Promise<PartnerTab[]> {
  const { defaults, overrides } = await loadRows("partner", userId, type);
  return resolvePartnerTabs(type, defaults, overrides);
}

function cached<T extends string>(
  cache: TabAccessCache | undefined,
  key: string,
  load: () => Promise<T[]>,
): Promise<readonly T[]> {
  if (!cache) return load();
  let hit = cache.get(key) as Promise<readonly T[]> | undefined;
  if (!hit) {
    hit = load();
    cache.set(key, hit);
    // Don't keep a failed lookup for the rest of the request.
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

export function cachedAdminSections(
  cache: TabAccessCache | undefined,
  user: { id: number; role: number },
): Promise<readonly AdminSection[]> {
  return cached(cache, `admin:${user.id}:${user.role}`, () => adminSectionsFor(user.id, user.role));
}

export function cachedPartnerTabs(
  cache: TabAccessCache | undefined,
  user: { id: number; type: number },
): Promise<readonly PartnerTab[]> {
  return cached(cache, `partner:${user.id}:${user.type}`, () => partnerTabsFor(user.id, user.type));
}
