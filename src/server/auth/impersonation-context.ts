import { AsyncLocalStorage } from "node:async_hooks";

// Who is really acting during an impersonated request. Set by the tRPC auth
// middlewares (protectedAdminProcedure / protectedPartnerProcedure) and read by
// the audit_log hook in ~/server/db, so every audit row written while someone
// is impersonating is attributed to the real person and records who they were
// acting as (metadata.impersonation) — without touching each audit call site:
//   - a Super Admin: metadata.byCpUserId;
//   - an agency owner viewing as their counsellor: metadata.byUserId, and the
//     row's user_id moves from the counsellor to the owner.
// Exactly one of realCpUserId / realUserId is set.
export interface ImpersonationContext {
  realCpUserId?: number;
  realUserId?: number;
  as: { kind: "staff" | "partner"; id: number; name: string };
}

const storage = new AsyncLocalStorage<ImpersonationContext>();

export function runWithImpersonation<T>(ctx: ImpersonationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentImpersonation(): ImpersonationContext | undefined {
  return storage.getStore();
}

// Merge real-actor attribution into an audit_log metadata value.
export function attributeAuditMetadata(metadata: unknown, imp: ImpersonationContext): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
  const by = imp.realCpUserId ? { byCpUserId: imp.realCpUserId } : { byUserId: imp.realUserId };
  return { ...base, ...by, impersonation: imp.as };
}

// The audit row's user_id while an agency owner acts as their counsellor:
// the owner, where the row names the counsellor as the actor.
export function attributeAuditUserId(userId: unknown, imp: ImpersonationContext): unknown {
  return imp.realUserId && userId === imp.as.id ? imp.realUserId : userId;
}
