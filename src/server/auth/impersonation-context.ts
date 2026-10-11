import { AsyncLocalStorage } from "node:async_hooks";

// Who is really acting during an impersonated request. Set by the tRPC auth
// middlewares (protectedAdminProcedure / protectedPartnerProcedure) and read by
// the audit_log hook in ~/server/db, so every audit row written while a Super
// Admin is impersonating someone is attributed to the real admin
// (metadata.byCpUserId) and records who they were acting as
// (metadata.impersonation) — without touching each audit call site.
export interface ImpersonationContext {
  realCpUserId: number;
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
  return { ...base, byCpUserId: imp.realCpUserId, impersonation: imp.as };
}
