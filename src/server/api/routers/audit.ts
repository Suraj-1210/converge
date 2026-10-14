import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure, protectedPartnerProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { AdminRole } from "~/server/db/enums";
import { BANK_AUDIT_ACTIONS } from "~/server/bank-accounts";

// Audit logs are a compliance surface — restricted to Super Admin + Finance.
const VIEW_ROLES: number[] = [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_MANAGER, AdminRole.FINANCE_EXECUTIVE];
function assertCanView(role: number) {
  if (!VIEW_ROLES.includes(role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Audit logs are restricted to Super Admins and Finance." });
  }
}

const PAGE_SIZE = 15;

// entity_type → module label (shown in the table + Module filter).
const MODULE_BY_ENTITY: Record<string, string> = {
  student: "Students",
  application: "Applications",
  event: "Events",
  user: "Partners",
  cp_user: "Users",
  export: "Exports",
  partner_bank_account: "Bank Details",
  counselling_team: "Counselling Teams",
};
const ENTITY_BY_MODULE: Record<string, string> = Object.fromEntries(
  Object.entries(MODULE_BY_ENTITY).map(([k, v]) => [v, k]),
);

// Every action string the app writes today (entity.verb). Used to back the
// Action-type filter (category → action IN (...)).
const ACTION_STRINGS = [
  ...BANK_AUDIT_ACTIONS,
  "application.credential_saved", "application.credential_viewed", "application.removed", "application.status_updated", "application.uni_id_saved", "application.vendor_selected",
  "counsellor.approved", "counsellor.invited", "counsellor.rejected",
  "counselling_team.auto_assign_off", "counselling_team.auto_assign_on", "counselling_team.updated",
  "event.created", "event.deleted", "event.updated",
  "export.downloaded",
  "impersonation.ended", "impersonation.started",
  "partner.documents_approved", "partner.status_updated",
  "student.academics_updated", "student.application_created", "student.cp_counsellor_assigned", "student.cp_counsellor_auto_assigned", "student.document_removed", "student.document_uploaded", "student.profile_updated", "student.shortlist_removed", "student.shortlisted", "student.status_updated", "student.tests_updated", "student.work_experience_updated",
];

function categoryOf(action: string): string {
  if (action.startsWith("impersonation.")) return "Impersonation";
  if (action.startsWith("bank.verified")) return "Approval";
  if (action.includes("revealed")) return "View";
  if (action.startsWith("export.")) return "Export";
  if (action.includes("status")) return "Status Change";
  if (action.includes("approved")) return "Approval";
  if (action.includes("rejected")) return "Rejection";
  if (action.includes("invited")) return "Invite";
  if (action.includes("removed") || action.includes("deleted")) return "Delete";
  if (action.includes("viewed")) return "View";
  if (action.includes("created") || action.includes("uploaded") || action.includes("shortlisted") || action.includes("saved")) return "Create";
  if (action.includes("updated")) return "Update";
  return "Action";
}
const CATEGORIES = Array.from(new Set(ACTION_STRINGS.map(categoryOf))).sort();
const actionsForCategory = (cat: string) => ACTION_STRINGS.filter((a) => categoryOf(a) === cat);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function actorIdOf(metadata: unknown): number | null {
  const v = asRecord(metadata).byCpUserId;
  return typeof v === "number" ? v : null;
}
function s(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return "";
  return JSON.stringify(v);
}
function humanize(action: string, entityId: number | null, metadata: unknown): string {
  const words = action.replace(/\./g, " ").replace(/_/g, " ");
  const base = words.charAt(0).toUpperCase() + words.slice(1);
  const meta = asRecord(metadata);
  const idPart = entityId ? ` (#${entityId})` : "";
  // Anything done while impersonating names who the admin was acting as.
  const imp = asRecord(meta.impersonation);
  const asPart = typeof imp.name === "string" ? ` [as ${imp.name}]` : "";
  if (action.startsWith("impersonation.")) {
    const who = `${s(meta.targetName) || `#${s(meta.targetId)}`}${meta.targetRole ? ` (${s(meta.targetRole)})` : ""}`;
    return action === "impersonation.started" ? `Started impersonating ${who}` : `Stopped impersonating ${who}`;
  }
  if (action.startsWith("bank.")) return humanizeBank(action, meta) + asPart;
  if (action === "export.downloaded") {
    const rows = typeof meta.rows === "number" ? ` — ${meta.rows} rows` : "";
    return `Exported ${s(meta.file)}${rows}${asPart}`;
  }
  if (action.includes("status") && meta.from != null && meta.to != null) {
    return `${base}: ${s(meta.from)} → ${s(meta.to)}${idPart}${asPart}`;
  }
  const extra =
    typeof meta.fileName === "string" ? ` — ${meta.fileName}` :
    typeof meta.reason === "string" && meta.reason ? ` — ${meta.reason}` : "";
  return `${base}${idPart}${extra}${asPart}`;
}

// Bank-detail rows carry last-4 digits only (never a full account number).
function humanizeBank(action: string, meta: Record<string, unknown>): string {
  const acct = (v: unknown) => (typeof v === "string" && v ? `••${v}` : "—");
  switch (action) {
    case "bank.details_saved":
      return meta.hadAccount === true
        ? `Bank details changed: ${acct(meta.oldLast4)} → ${acct(meta.newLast4)}`
        : `Bank details added: ${acct(meta.newLast4)}`;
    case "bank.verified_manually":
      return `Bank account ${acct(meta.last4)} verified by hand${meta.note ? ` — ${s(meta.note)}` : ""}`;
    case "bank.verified_razorpayx":
      return `Bank account ${acct(meta.last4)} verified via RazorpayX${meta.registeredName ? ` — ${s(meta.registeredName)}` : ""}`;
    case "bank.razorpayx_check_failed":
      return `RazorpayX check on ${acct(meta.last4)} did not pass (${s(meta.accountStatus) || s(meta.validationStatus) || "unknown"})`;
    case "bank.rejected":
      return `Bank account ${acct(meta.last4)} rejected${meta.reason ? ` — ${s(meta.reason)}` : ""}`;
    case "bank.account_number_revealed":
      return `Full account number for ${acct(meta.last4)} revealed`;
    default:
      return action;
  }
}

const exportInput = z.object({
  file: z.string().min(1).max(200),
  rows: z.number().int().min(0).optional(),
});

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };

interface AuditFilter { module?: string; category?: string; actorId?: number; from?: string; to?: string; search?: string }
function buildWhere(input: AuditFilter) {
  const search = input.search?.trim().toLowerCase();
  // Collapse the Action-type + free-text filters into one `action` condition.
  let actionCond: { in: string[] } | { contains: string } | undefined;
  if (input.category && search) {
    actionCond = { in: actionsForCategory(input.category).filter((a) => a.includes(search)) };
  } else if (input.category) {
    actionCond = { in: actionsForCategory(input.category) };
  } else if (search) {
    actionCond = { contains: search };
  }
  const createdAt =
    input.from || input.to
      ? {
          ...(input.from ? { gte: new Date(`${input.from}T00:00:00`) } : {}),
          ...(input.to ? { lte: new Date(`${input.to}T23:59:59`) } : {}),
        }
      : undefined;
  return {
    ...(input.module && ENTITY_BY_MODULE[input.module] ? { entity_type: ENTITY_BY_MODULE[input.module] } : {}),
    ...(actionCond ? { action: actionCond } : {}),
    ...(input.actorId != null ? { metadata: { path: "$.byCpUserId", equals: input.actorId } } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

interface Actors { staff: Map<number, string>; partners: Map<number, string> }
async function resolveActors(rows: { metadata: unknown; user_id: number | null }[]): Promise<Actors> {
  const ids = Array.from(new Set(rows.map((r) => actorIdOf(r.metadata)).filter((x): x is number => x != null)));
  // Partner-portal actions (e.g. a partner saving bank details) have no staff
  // actor; they name the partner user instead.
  const partnerIds = Array.from(
    new Set(rows.filter((r) => actorIdOf(r.metadata) == null && r.user_id != null).map((r) => r.user_id!)),
  );
  const [actors, partners] = await Promise.all([
    ids.length
      ? db.collegepond_user.findMany({ where: { id: { in: ids } }, select: { id: true, first_name: true, last_name: true } })
      : [],
    partnerIds.length
      ? db.user.findMany({ where: { id: { in: partnerIds } }, select: { id: true, first_name: true, last_name: true } })
      : [],
  ]);
  return {
    staff: new Map(actors.map((a) => [a.id, `${a.first_name} ${a.last_name}`.trim()])),
    partners: new Map(partners.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()])),
  };
}
function mapRow(r: { id: number; created_at: Date; action: string; entity_type: string | null; entity_id: number | null; user_id: number | null; metadata: unknown }, actorMap: Actors) {
  const actorId = actorIdOf(r.metadata);
  const partnerName = actorId == null && r.user_id != null ? actorMap.partners.get(r.user_id) : undefined;
  return {
    id: r.id,
    timestamp: r.created_at.toISOString(),
    actorId,
    actor:
      actorId != null
        ? (actorMap.staff.get(actorId) ?? `Admin #${actorId}`)
        : partnerName
          ? `${partnerName} (partner)`
          : "System",
    action: r.action,
    category: categoryOf(r.action),
    module: r.entity_type ? (MODULE_BY_ENTITY[r.entity_type] ?? r.entity_type) : "—",
    description: humanize(r.action, r.entity_id, r.metadata),
    entityId: r.entity_id,
    metadata: asRecord(r.metadata),
  };
}

export const auditRouter = createTRPCRouter({
  // Static-ish filter options for the dropdowns.
  filters: protectedAdminProcedure.query(async ({ ctx }) => {
    assertCanView(ctx.cpUser.role);
    const admins = await db.collegepond_user.findMany({
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      select: { id: true, first_name: true, last_name: true },
    });
    return {
      admins: admins.map((a) => ({ id: a.id, name: `${a.first_name} ${a.last_name}`.trim() })),
      modules: Object.values(MODULE_BY_ENTITY),
      categories: CATEGORIES,
    };
  }),

  list: protectedAdminProcedure
    .input(z.object({
      page: z.number().int().min(1).default(1),
      module: z.string().optional(),
      category: z.string().optional(),
      actorId: z.number().int().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      search: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      assertCanView(ctx.cpUser.role);
      const where = buildWhere(input);

      const [total, rows, today, week, month, allTime] = await Promise.all([
        db.audit_log.count({ where }),
        db.audit_log.findMany({ where, orderBy: { created_at: "desc" }, skip: (input.page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
        db.audit_log.count({ where: { created_at: { gte: startOfToday() } } }),
        db.audit_log.count({ where: { created_at: { gte: daysAgo(7) } } }),
        db.audit_log.count({ where: { created_at: { gte: daysAgo(30) } } }),
        db.audit_log.count(),
      ]);

      const actorMap = await resolveActors(rows);
      return {
        page: input.page,
        pageSize: PAGE_SIZE,
        total,
        stats: { today, week, month, total: allTime },
        rows: rows.map((r) => mapRow(r, actorMap)),
      };
    }),

  // All matching rows (capped) for CSV export.
  export: protectedAdminProcedure
    .input(z.object({ module: z.string().optional(), category: z.string().optional(), actorId: z.number().int().optional(), from: z.string().optional(), to: z.string().optional(), search: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      assertCanView(ctx.cpUser.role);
      const rows = await db.audit_log.findMany({ where: buildWhere(input), orderBy: { created_at: "desc" }, take: 5000 });
      const actorMap = await resolveActors(rows);
      return rows.map((r) => mapRow(r, actorMap));
    }),

  // Records a client-side CSV/XLSX/JSON download. Any admin may export, so this
  // isn't gated on audit view access. While impersonating, the row is
  // attributed to the real admin (see impersonation-context).
  logExport: protectedAdminProcedure
    .input(exportInput)
    .mutation(async ({ ctx, input }) => {
      await db.audit_log.create({
        data: {
          action: "export.downloaded",
          entity_type: "export",
          metadata: { byCpUserId: ctx.cpUser.id, file: input.file, rows: input.rows ?? null },
        },
      });
      return { ok: true as const };
    }),

  // Partner-portal downloads. byCpUserId is only added when a Super Admin is
  // impersonating the partner.
  logPartnerExport: protectedPartnerProcedure
    .input(exportInput)
    .mutation(async ({ ctx, input }) => {
      await db.audit_log.create({
        data: {
          action: "export.downloaded",
          entity_type: "export",
          user_id: ctx.cpPartner.id,
          metadata: { file: input.file, rows: input.rows ?? null },
        },
      });
      return { ok: true as const };
    }),
});
