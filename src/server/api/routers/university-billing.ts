import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeProcedure,
  financeManagerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  DocumentStatus,
  UniApplicationStatus,
  VendorInvoiceStatus,
  CommissionType,
  TrancheStatus,
  VARIANCE_REASON_CODES,
  financialYearOf,
  toINR,
} from "~/server/db/enums";
import { shareForConfirmation } from "~/server/partner-tiers";
import { PAYEE_LABEL_SELECT, payeeData, payeeForApplication, payeeLabel } from "~/server/payee";
import { trancheScheduleIssue } from "~/server/commission-schedule";
import { FINANCE_CURRENCIES } from "~/lib/currency";
import { createNotifications } from "~/server/notify";
import { appUrl, commissionClaimableEmail } from "~/server/email";
import { emailPartners, payeeRecipients } from "~/server/email/partners";

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const orNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  return t;
};

const currency = z.enum(FINANCE_CURRENCIES);
const varianceReason = z
  .number()
  .int()
  .refine((v) => (VARIANCE_REASON_CODES as number[]).includes(v), "Invalid reason");

// Resolve the default contract + applicable rate for a (university, course).
// course-specific rate wins over the university-wide rate (course_id null).
// Also the contract's currency (falling back to its vendor's; null on older
// contracts), its CP share and its tranche schedule.
async function resolveDefaultRate(universityId: number, courseId: number) {
  const contract = await db.commission_contract.findFirst({
    where: { university_id: universityId, is_default: 1 },
    include: {
      commission_rate: true,
      vendor: true,
      commission_tranche_template: { orderBy: { seq: "asc" } },
    },
  });
  if (!contract) return null;
  const courseRate = contract.commission_rate.find((r) => r.course_id === courseId);
  const rate =
    courseRate ??
    contract.commission_rate.find((r) => r.course_id === null) ??
    null;
  if (!rate) return null;
  return {
    contractId: contract.id,
    vendorId: contract.vendor_id,
    vendorName: contract.vendor?.name ?? "Direct",
    vendorType: contract.vendor?.type ?? null,
    commissionType: rate.commission_type,
    rate: num(rate.rate),
    // A course-specific rate overrides the university-wide one.
    isProgramSpecific: courseRate != null,
    contractCurrency: contract.currency ?? contract.vendor?.currency ?? null,
    // The vendor's pass-through to Collegepond (third-party deals); null on a
    // direct contract = Collegepond gets the whole commission.
    cpSharePct: contract.cp_share_pct == null ? null : num(contract.cp_share_pct),
    templates: contract.commission_tranche_template.map((t) => ({
      seq: t.seq,
      name: t.name,
      pct: t.pct == null ? null : num(t.pct),
      amount: t.amount == null ? null : num(t.amount),
    })),
  };
}
type ResolvedRate = NonNullable<Awaited<ReturnType<typeof resolveDefaultRate>>>;

// The currency a commission is stamped in (decided 30 Oct 2026): a FLAT
// amount is in the CONTRACT currency, so the commission is stamped in it —
// even when the course is priced in another (e.g. a €2,000 flat fee on a
// £-priced course is €2,000, never £2,000). A percentage is a share of the
// tuition, so it stays in the course currency. Contracts made before
// contracts had a currency fall back to the course currency (as before).
function commissionCurrency(resolved: ResolvedRate, courseCurrency: string): string {
  return resolved.commissionType === CommissionType.FLAT
    ? (resolved.contractCurrency ?? courseCurrency)
    : courseCurrency;
}

// The amount Collegepond actually earns on a commission: the gross, or on a
// third-party deal the vendor's CP share of it. It's what CP bills the vendor.
const cpReceivable = (gross: number, cpSharePct: number | null): number =>
  cpSharePct == null ? gross : Math.round(gross * cpSharePct) / 100;

// Split the gross into tranche slices as Approve commission stamps them.
function trancheSlices(resolved: ResolvedRate, gross: number) {
  return resolved.templates.length > 0
    ? resolved.templates.map((t) => ({
        seq: t.seq,
        name: t.name,
        amount:
          t.pct != null
            ? Math.round(gross * (t.pct / 100) * 100) / 100
            : t.amount ?? gross,
      }))
    : [{ seq: 1, name: "Full commission", amount: gross }];
}

const staffName = (u: { first_name: string; last_name: string } | undefined, id: number | null) =>
  id == null ? null : u ? `${u.first_name} ${u.last_name}`.trim() : `Staff #${id}`;

// The deposit slip a partner (or Collegepond) uploads for an application once
// the deposit is paid. A commission can't be approved until a counsellor has
// verified it (Suraj, 24 Oct 2026): the current slip (is_most_recent) with
// status APPROVED.
export type DepositSlipStatus = "verified" | "pending" | "rejected" | "missing";
const DEPOSIT_SLIP_DOC_TYPE = "deposit_receipt";
const SLIP_NOT_VERIFIED =
  "The deposit slip for this application hasn't been verified yet — a counsellor verifies it on the student's Application tab.";

async function depositSlipStatuses(applicationIds: number[]): Promise<Map<number, DepositSlipStatus>> {
  const out = new Map<number, DepositSlipStatus>();
  if (applicationIds.length === 0) return out;
  const docs = await db.document.findMany({
    where: {
      application_id: { in: applicationIds },
      doc_type: DEPOSIT_SLIP_DOC_TYPE,
      is_most_recent: 1,
    },
    select: { application_id: true, status: true },
  });
  for (const id of applicationIds) {
    const mine = docs.filter((d) => d.application_id === id);
    out.set(
      id,
      mine.some((d) => d.status === DocumentStatus.APPROVED)
        ? "verified"
        : mine.some((d) => d.status === DocumentStatus.PENDING)
          ? "pending"
          : mine.some((d) => d.status === DocumentStatus.REJECTED)
            ? "rejected"
            : "missing",
    );
  }
  return out;
}

// Vendor invoice numbers are unique across all vendors (a schema rule); a
// clash surfaces as Prisma's P2002.
function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

// A tranche counts as collected once Finance has recorded the vendor's
// payment for it — awaiting approval (COLLECTED) or approved and claimable
// (RECEIVED) — and stays so once it's paid out to the partner.
const isCollected = (status: number) =>
  status === TrancheStatus.COLLECTED ||
  status === TrancheStatus.RECEIVED ||
  status === TrancheStatus.PAID;

// Gross commission for a tuition under a rate (percentage of tuition, or flat).
function grossCommission(
  tuition: number,
  rate: number,
  commissionType: number,
): number {
  const v =
    commissionType === CommissionType.FLAT ? rate : (tuition * rate) / 100;
  return Math.round(v * 100) / 100;
}

export const universityBillingRouter = createTRPCRouter({
  // ========================================================================
  // Tab 1 — Confirmed Students: enrolled applications not yet confirmed for
  // billing (no commission row yet).
  // ========================================================================
  confirmedStudents: financeProcedure.query(async () => {
    const apps = await db.application.findMany({
      where: { status: UniApplicationStatus.ENROLLED, commission: { is: null } },
      orderBy: { updated_at: "desc" },
      select: {
        id: true,
        university_app_id: true,
        updated_at: true,
        student: { select: { id: true, first_name: true, last_name: true } },
        course: {
          select: {
            id: true,
            name: true,
            tuition_fee: true,
            currency: true,
            intake_month: true,
            intake_year: true,
            university: { select: { id: true, name: true, country: true } },
          },
        },
      },
    });
    // Already-confirmed (billed) enrolled students drive the progress bar.
    const confirmedCount = await db.application.count({
      where: { status: UniApplicationStatus.ENROLLED, commission: { isNot: null } },
    });
    const slips = await depositSlipStatuses(apps.map((a) => a.id));

    const students = await Promise.all(
      apps.map(async (a) => {
        const resolved = await resolveDefaultRate(a.course.university.id, a.course.id);
        const intake = [a.course.intake_month, a.course.intake_year]
          .filter(Boolean)
          .join(" ");
        const isFlat = resolved?.commissionType === CommissionType.FLAT;
        return {
          applicationId: a.id,
          studentId: a.student.id,
          studentName: `${a.student.first_name} ${a.student.last_name}`.trim(),
          cpStudentId: `CP-${a.student.id}`,
          universityStudentId: a.university_app_id,
          program: a.course.name,
          university: a.course.university.name,
          universityId: a.course.university.id,
          country: a.course.university.country,
          intake: intake || null,
          tuition: num(a.course.tuition_fee),
          currency: a.course.currency,
          rate: resolved?.rate ?? null,
          isFlat,
          // What the commission will be stamped in (contract currency for flat).
          commissionCurrency: resolved ? commissionCurrency(resolved, a.course.currency) : a.course.currency,
          vendorId: resolved?.vendorId ?? null,
          vendorName: resolved?.vendorName ?? "Direct",
          vendorType: resolved?.vendorType ?? null,
          rateType: resolved
            ? resolved.isProgramSpecific
              ? "Program-specific"
              : "Unified"
            : null,
          hasDefaultRate: resolved != null,
          depositSlip: slips.get(a.id) ?? "missing",
        };
      }),
    );
    return { students, confirmedCount, attendedCount: students.length };
  }),

  // What "Approve commission" will stamp, for the review dialog: the rate and
  // gross from the default contract, the payee and their tier share as of now,
  // the vendor, the tranche schedule and the deposit slip. Read-only.
  approvalPreview: financeProcedure
    .input(z.object({ applicationId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const app = await db.application.findUnique({
        where: { id: input.applicationId },
        select: {
          id: true,
          org_id: true,
          student_id: true,
          student: { select: { id: true, first_name: true, last_name: true } },
          course: {
            select: {
              id: true,
              name: true,
              tuition_fee: true,
              currency: true,
              university: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
      const resolved = await resolveDefaultRate(app.course.university.id, app.course.id);
      const payee = await payeeForApplication(app);
      const share = payee ? await shareForConfirmation(payee, app.student_id) : null;
      let payeeName: string | null = null;
      if (payee?.orgId != null) {
        const org = await db.organization.findUnique({ where: { id: payee.orgId }, select: { name: true } });
        payeeName = org?.name ?? "Unknown agency";
      } else if (payee) {
        const u = await db.user.findUnique({
          where: { id: payee.userId },
          select: { first_name: true, last_name: true },
        });
        payeeName = u ? `${u.first_name} ${u.last_name}`.trim() : "Unknown counsellor";
      }
      const tuition = num(app.course.tuition_fee);
      const gross = resolved ? grossCommission(tuition, resolved.rate, resolved.commissionType) : null;
      // Same split confirmBilling materialises.
      const tranches = resolved && gross != null ? trancheSlices(resolved, gross) : [];
      const cpGets = resolved && gross != null ? cpReceivable(gross, resolved.cpSharePct) : null;
      return {
        applicationId: app.id,
        studentId: app.student.id,
        studentName: `${app.student.first_name} ${app.student.last_name}`.trim(),
        university: app.course.university.name,
        program: app.course.name,
        // The commission's currency (contract currency on a flat deal) and
        // the tuition's (the course's) — they differ on a cross-currency flat deal.
        currency: resolved ? commissionCurrency(resolved, app.course.currency) : app.course.currency,
        tuitionCurrency: app.course.currency,
        tuition,
        rate: resolved?.rate ?? null,
        isFlat: resolved?.commissionType === CommissionType.FLAT,
        rateType: resolved ? (resolved.isProgramSpecific ? "Program-specific" : "Unified") : null,
        gross,
        cpSharePct: resolved?.cpSharePct ?? null,
        cpReceivable: cpGets,
        trancheIssue: resolved
          ? trancheScheduleIssue(resolved.templates, resolved.commissionType, gross)
          : null,
        vendorName: resolved?.vendorName ?? null,
        payee: payee
          ? { name: payeeName, type: payee.orgId != null ? ("agency" as const) : ("independent" as const) }
          : null,
        tier: share?.tier.name ?? null,
        sharePct: share?.sharePct ?? null,
        // The partner's share is of what Collegepond receives.
        partnerShare: share && cpGets != null ? Math.round(cpGets * share.sharePct) / 100 : null,
        tranches,
        depositSlip: (await depositSlipStatuses([app.id])).get(app.id) ?? "missing",
      };
    }),

  // Approve a student's commission ("Approve commission"; was "Confirm") —
  // creates the commission from the university's default rate. Requires a
  // default contract for that university and a verified deposit slip, and
  // records who approved it (Super Admin / Finance Manager only).
  // Also stamps the partner's commission share from their tier (Partner Tiers
  // master) as a snapshot: later tier changes never alter a confirmed row.
  // The payee is stamped too: the agency, or for an independent counsellor's
  // student, the independent (even if since suspended or deleted).
  confirmBilling: financeManagerProcedure
    .input(z.object({ applicationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const app = await db.application.findUnique({
        where: { id: input.applicationId },
        select: {
          id: true,
          org_id: true,
          student_id: true,
          status: true,
          commission: { select: { id: true } },
          course: {
            select: {
              id: true,
              tuition_fee: true,
              currency: true,
              university: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
      if (app.commission) {
        throw new TRPCError({ code: "CONFLICT", message: "Already confirmed for billing." });
      }
      if (app.status !== UniApplicationStatus.ENROLLED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only enrolled (attended) students can be billed.",
        });
      }
      if ((await depositSlipStatuses([app.id])).get(app.id) !== "verified") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: SLIP_NOT_VERIFIED });
      }
      const resolved = await resolveDefaultRate(app.course.university.id, app.course.id);
      if (!resolved) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Set a default commission rate for ${app.course.university.name} in Commission Rates first.`,
        });
      }
      const tuition = num(app.course.tuition_fee);
      const amount = grossCommission(tuition, resolved.rate, resolved.commissionType);
      const scheduleIssue = trancheScheduleIssue(resolved.templates, resolved.commissionType, amount);
      if (scheduleIssue) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${app.course.university.name}'s tranche schedule doesn't add up: ${scheduleIssue} Fix it in Commission Rates first.`,
        });
      }
      const payee = await payeeForApplication(app);
      if (!payee) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This student isn't linked to an agency or an independent counsellor, so there's nobody to pay commission to. Check who added the student.",
        });
      }
      // The student being confirmed counts toward the tier (the 11th is Gold).
      const confirmedAt = new Date();
      const share = await shareForConfirmation(payee, app.student_id, { at: confirmedAt });
      if (!share) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Partner Tiers aren't set up, so the partner's commission share can't be worked out. Ask a Super Admin to check Settings → Partner Tiers.",
        });
      }
      const created = await db.commission.create({
        data: {
          application_id: app.id,
          ...payeeData(payee),
          tuition_fee: tuition,
          currency: commissionCurrency(resolved, app.course.currency),
          tuition_currency: app.course.currency,
          // The contract's CP share (vendor pass-through), as a snapshot.
          cp_share_pct: resolved.cpSharePct,
          // Flat deals store rate 0; the gross amount carries the value.
          commision_rate:
            resolved.commissionType === CommissionType.FLAT ? 0 : resolved.rate,
          commision_amount: amount,
          vendor_id: resolved.vendorId,
          partner_share_pct: share.sharePct,
          partner_tier_id: share.tier.id,
          created_at: confirmedAt,
          approved_by_cp_user_id: ctx.cpUser.id,
          approved_at: confirmedAt,
        },
      });
      await db.audit_log.create({
        data: {
          org_id: payee.orgId,
          action: "commission.share_stamped",
          entity_type: "commission",
          entity_id: created.id,
          metadata: {
            byCpUserId: ctx.cpUser.id,
            via: "confirm_billing",
            payeeUserId: payee.userId,
            tier: share.tier.name,
            sharePct: share.sharePct,
            fyStudents: share.students,
            source: share.source,
          },
        },
      });
      // Materialize tranche instances from the contract's tranche schedule so the
      // partner can claim each tranche as CP collects it (pay-as-collected). A
      // single-payment contract gets one 100% tranche so claimability is uniform.
      await db.commission_tranche.createMany({
        data: trancheSlices(resolved, amount).map((t) => ({
          commission_id: created.id,
          seq: t.seq,
          name: t.name,
          amount: t.amount,
          status: TrancheStatus.UPCOMING,
        })),
      });
      return { commissionId: created.id };
    }),

  // ========================================================================
  // Tab 2 — Vendor Billing: confirmed commissions not yet on an invoice,
  // grouped by vendor.
  // ========================================================================
  vendorBillingStudents: financeProcedure.query(async () => {
    const comms = await db.commission.findMany({
      orderBy: { id: "asc" },
      include: {
        vendor: true,
        application: {
          select: {
            university_app_id: true,
            student: { select: { id: true, first_name: true, last_name: true } },
            course: {
              select: {
                id: true,
                name: true,
                university: { select: { id: true, name: true } },
              },
            },
          },
        },
        ...PAYEE_LABEL_SELECT,
        vendor_invoice_item: {
          select: {
            vendor_invoice: {
              select: { id: true, invoice_number: true, status: true },
            },
          },
        },
        commission_tranche: { select: { status: true } },
      },
    });

    // Batch which (university, course) pairs have a program-specific rate under
    // the university's default contract, to label Program-specific vs Unified.
    const uniIds = Array.from(
      new Set(comms.map((c) => c.application.course.university.id)),
    );
    const contracts = await db.commission_contract.findMany({
      where: { university_id: { in: uniIds }, is_default: 1 },
      include: { commission_rate: { select: { course_id: true } } },
    });
    const specificByUni = new Map<number, Set<number>>();
    for (const ct of contracts) {
      const set = new Set<number>();
      for (const r of ct.commission_rate) if (r.course_id != null) set.add(r.course_id);
      specificByUni.set(ct.university_id, set);
    }

    return comms.map((c) => {
      const inv = c.vendor_invoice_item?.vendor_invoice ?? null;
      const uniId = c.application.course.university.id;
      const courseId = c.application.course.id;
      // Tranche collection progress: how many of this commission's tranches CP has
      // already received from the vendor (RECEIVED or PAID), out of the total.
      const trancheTotal = c.commission_tranche.length;
      const trancheCollected = c.commission_tranche.filter((t) => isCollected(t.status)).length;
      const gross = num(c.commision_amount);
      const cpSharePct = c.cp_share_pct == null ? null : num(c.cp_share_pct);
      return {
        commissionId: c.id,
        vendorId: c.vendor_id,
        vendorName: c.vendor?.name ?? "Direct",
        vendorType: c.vendor?.type ?? null,
        university: c.application.course.university.name,
        universityId: uniId,
        studentName:
          `${c.application.student.first_name} ${c.application.student.last_name}`.trim(),
        cpStudentId: `CP-${c.application.student.id}`,
        universityStudentId: c.application.university_app_id,
        program: c.application.course.name,
        ...payeeLabel(c),
        tuition: num(c.tuition_fee),
        tuitionCurrency: c.tuition_currency ?? c.currency,
        currency: c.currency,
        rate: num(c.commision_rate),
        isFlat: num(c.commision_rate) === 0,
        grossAmount: gross,
        cpSharePct,
        // What CP bills the vendor: its CP share of the gross.
        calcAmount: cpReceivable(gross, cpSharePct),
        rateType: specificByUni.get(uniId)?.has(courseId)
          ? "Program-specific"
          : "Unified",
        invoice: inv
          ? { id: inv.id, number: inv.invoice_number, status: inv.status }
          : null,
        tranches: { total: trancheTotal, collected: trancheCollected },
      };
    });
  }),

  createVendorInvoice: financeManagerProcedure
    .input(
      z.object({
        vendorId: z.number().int().positive().nullable(),
        invoiceNumber: z.string().trim().min(1).max(40),
        currency,
        invoiceDate: z.string(),
        dueDate: z.string().optional(),
        notes: z.string().max(1000).optional(),
        lines: z
          .array(
            z.object({
              commissionId: z.number().int().positive(),
              tuitionAmount: z.number().min(0),
              expectedAmount: z.number().min(0),
              varianceReason: varianceReason,
              varianceNote: z.string().max(255).optional(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const ids = input.lines.map((l) => l.commissionId);
      const comms = await db.commission.findMany({
        where: { id: { in: ids } },
        include: { vendor_invoice_item: { select: { id: true } } },
      });
      if (comms.length !== ids.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Some students no longer exist." });
      }
      for (const c of comms) {
        if (c.vendor_invoice_item) {
          throw new TRPCError({ code: "CONFLICT", message: "A student is already invoiced." });
        }
        if (c.vendor_id !== input.vendorId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "All students on an invoice must share the same vendor.",
          });
        }
      }
      const byId = new Map(comms.map((c) => [c.id, c]));
      const fy = financialYearOf(new Date(input.invoiceDate));

      const items = input.lines.map((l) => {
        const c = byId.get(l.commissionId)!;
        const rate = num(c.commision_rate);
        // Percentage deals recompute from the entered tuition; flat deals keep
        // the stored gross commission. Either way CP bills its CP share of it.
        const gross =
          rate > 0
            ? grossCommission(l.tuitionAmount, rate, CommissionType.PERCENTAGE)
            : num(c.commision_amount);
        const calc = cpReceivable(gross, c.cp_share_pct == null ? null : num(c.cp_share_pct));
        const variance = Math.round((l.expectedAmount - calc) * 100) / 100;
        if (variance !== 0 && l.varianceReason === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A variance reason is required when expected ≠ calculated.",
          });
        }
        return {
          commission_id: l.commissionId,
          tuition_amount: l.tuitionAmount,
          calculated_commission: calc,
          expected_amount: l.expectedAmount,
          variance,
          variance_reason: l.varianceReason,
          variance_note: orNull(l.varianceNote),
        };
      });
      const totalExpected =
        Math.round(items.reduce((s, i) => s + i.expected_amount, 0) * 100) / 100;

      const duplicateNumber = () =>
        new TRPCError({
          code: "CONFLICT",
          message: `Invoice number ${input.invoiceNumber} is already in use — use a different number.`,
        });
      const taken = await db.vendor_invoice.findUnique({
        where: { invoice_number: input.invoiceNumber },
        select: { id: true },
      });
      if (taken) throw duplicateNumber();
      const invoice = await db.$transaction(async (tx) => {
        const inv = await tx.vendor_invoice.create({
          data: {
            invoice_number: input.invoiceNumber,
            vendor_id: input.vendorId,
            currency: input.currency,
            invoice_date: new Date(input.invoiceDate),
            due_date: input.dueDate ? new Date(input.dueDate) : null,
            status: VendorInvoiceStatus.SENT,
            total_expected_amount: totalExpected,
            notes: orNull(input.notes),
            fy,
            created_by_cp_user_id: ctx.cpUser.id,
          },
        });
        await tx.vendor_invoice_item.createMany({
          data: items.map((i) => ({ ...i, vendor_invoice_id: inv.id })),
        });
        return inv;
      }).catch((e: unknown) => {
        // Lost a race with another invoice taking the same number.
        if (prismaCode(e) === "P2002") throw duplicateNumber();
        throw e;
      });
      return { vendorInvoiceId: invoice.id };
    }),

  // ========================================================================
  // Invoices view + Ageing both read vendor invoices.
  // ========================================================================
  listVendorInvoices: financeProcedure.query(async () => {
    const invoices = await db.vendor_invoice.findMany({
      orderBy: { invoice_date: "desc" },
      include: {
        vendor: true,
        vendor_invoice_item: {
          include: {
            commission: {
              include: {
                application: {
                  select: {
                    university_app_id: true,
                    course: { select: { name: true, university: { select: { name: true } } } },
                    student: { select: { first_name: true, last_name: true } },
                  },
                },
                commission_tranche: {
                  orderBy: { seq: "asc" },
                  select: { seq: true, name: true, status: true, amount: true },
                },
              },
            },
          },
        },
        vendor_payment: { orderBy: { payment_date: "asc" } },
      },
    });

    return invoices.map((inv) => {
      const paidInr = inv.vendor_payment.reduce((s, p) => s + num(p.amount_inr), 0);
      // The invoice's tranche schedule across its students, by seq: what's
      // still to collect (in the invoice currency, each line's expected amount
      // split like its commission's tranches). Drives Record Payment.
      const bySeq = new Map<
        number,
        { seq: number; name: string | null; students: number; uncollected: number; uncollectedExpected: number }
      >();
      for (const it of inv.vendor_invoice_item) {
        const gross = num(it.commission.commision_amount);
        for (const t of it.commission.commission_tranche) {
          const e = bySeq.get(t.seq) ?? { seq: t.seq, name: t.name, students: 0, uncollected: 0, uncollectedExpected: 0 };
          e.students += 1;
          if (!isCollected(t.status)) {
            e.uncollected += 1;
            e.uncollectedExpected += num(it.expected_amount) * (gross > 0 ? num(t.amount) / gross : 1);
          }
          bySeq.set(t.seq, e);
        }
      }
      const tranches = Array.from(bySeq.values())
        .sort((a, b) => a.seq - b.seq)
        .map((t) => ({ ...t, uncollectedExpected: Math.round(t.uncollectedExpected * 100) / 100 }));
      return {
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        vendorName: inv.vendor?.name ?? "Direct",
        currency: inv.currency,
        invoiceDate: inv.invoice_date,
        dueDate: inv.due_date,
        status: inv.status,
        totalExpected: num(inv.total_expected_amount),
        paidInr: Math.round(paidInr * 100) / 100,
        notes: inv.notes,
        tranches,
        // Money still to collect against a tranche. Also true on an invoice
        // marked fully paid before collection was tranche-aware, so its
        // remaining tranches can still be recorded.
        hasUncollected: tranches.some((t) => t.uncollected > 0),
        items: inv.vendor_invoice_item.map((it) => ({
          id: it.id,
          student:
            `${it.commission.application.student.first_name} ${it.commission.application.student.last_name}`.trim(),
          universityStudentId: it.commission.application.university_app_id,
          university: it.commission.application.course.university.name,
          program: it.commission.application.course.name,
          tuition: num(it.tuition_amount),
          calculated: num(it.calculated_commission),
          expected: num(it.expected_amount),
          variance: num(it.variance),
          varianceReason: it.variance_reason,
          varianceNote: it.variance_note,
        })),
        payments: inv.vendor_payment.map((p) => ({
          id: p.id,
          date: p.payment_date,
          amountInr: num(p.amount_inr),
          exchangeRate: num(p.exchange_rate),
          amountForeign: num(p.amount_foreign),
          amountExpected: p.amount_expected == null ? null : num(p.amount_expected),
          approved: p.approved_at != null,
          reference: p.payment_reference,
          isTranche: p.is_tranche === 1,
          trancheNumber: p.tranche_number,
          totalTranches: p.total_tranches,
          isFinal: p.is_final === 1,
          notes: p.notes,
        })),
      };
    });
  }),

  // Record money received from the vendor against an invoice. Collection is
  // tranche-aware (pay-as-collected): Finance says which tranche(s) the
  // payment covers, and only those tranches become COLLECTED ("Collected,
  // awaiting approval") on every student on the invoice. A final payment
  // covers every tranche still outstanding. A payment that covers no tranche
  // (part of a tranche) is recorded but unlocks nothing. The invoice is
  // FULLY_PAID once every tranche on it is collected.
  // Any finance role records it (a Finance Executive included); nothing is
  // claimable until a Super Admin / Finance Manager approves the collection
  // (approveCollections, 30 Oct 2026).
  recordVendorPayment: financeProcedure
    .input(
      z.object({
        vendorInvoiceId: z.number().int().positive(),
        amountInr: z.number().positive(),
        exchangeRate: z.number().positive(),
        paymentDate: z.string(),
        reference: z.string().max(100).optional(),
        // Tranche seqs this payment completes (ignored when isFinal).
        trancheSeqs: z.array(z.number().int().min(1).max(255)).max(50).default([]),
        isFinal: z.boolean(),
        notes: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const inv = await db.vendor_invoice.findUnique({
        where: { id: input.vendorInvoiceId },
        include: {
          vendor_invoice_item: {
            select: {
              commission_id: true,
              expected_amount: true,
              commission: {
                select: {
                  commision_amount: true,
                  collegepond_received_at: true,
                  commission_tranche: {
                    orderBy: { seq: "asc" },
                    select: { id: true, seq: true, status: true, amount: true, amount_inr: true },
                  },
                },
              },
            },
          },
        },
      });
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      const items = inv.vendor_invoice_item;
      const outstanding = items.flatMap((it) =>
        it.commission.commission_tranche.filter((t) => !isCollected(t.status)),
      );
      // Pre-tranche commissions (no tranche rows) are collected by their
      // commission-level stamp.
      const legacyOpen = items.filter(
        (it) => it.commission.commission_tranche.length === 0 && it.commission.collegepond_received_at == null,
      );
      if (outstanding.length === 0 && legacyOpen.length === 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Every tranche on this invoice is already collected." });
      }
      const requested = Array.from(new Set(input.trancheSeqs)).sort((a, b) => a - b);
      for (const seq of input.isFinal ? [] : requested) {
        if (!outstanding.some((t) => t.seq === seq)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Tranche ${seq} isn't outstanding on this invoice — it's already collected or not part of it.`,
          });
        }
      }
      const seqs = input.isFinal ? Array.from(new Set(outstanding.map((t) => t.seq))).sort((a, b) => a - b) : requested;
      const collectNow = new Set(outstanding.filter((t) => seqs.includes(t.seq)).map((t) => t.id));

      // After this payment: is each commission fully collected, and so the invoice?
      const fullyCollected = (it: (typeof items)[number]) =>
        it.commission.commission_tranche.length > 0
          ? it.commission.commission_tranche.every((t) => isCollected(t.status) || collectNow.has(t.id))
          : it.commission.collegepond_received_at != null || input.isFinal;
      const invoiceDone = items.every(fullyCollected);
      const maxTranches = Math.max(0, ...items.map((it) => it.commission.commission_tranche.length));

      const amountForeign =
        Math.round((input.amountInr / input.exchangeRate) * 100) / 100;
      const fy = financialYearOf(new Date(input.paymentDate));
      // What the covered tranches were invoiced at (invoice currency): the
      // "claimed" side of the collection record.
      let expected = 0;
      for (const it of items) {
        const gross = num(it.commission.commision_amount);
        for (const t of it.commission.commission_tranche) {
          if (collectNow.has(t.id)) expected += num(it.expected_amount) * (gross > 0 ? num(t.amount) / gross : 1);
        }
        if (it.commission.commission_tranche.length === 0 && it.commission.collegepond_received_at == null && input.isFinal) {
          expected += num(it.expected_amount);
        }
      }

      await db.$transaction(async (tx) => {
        const payment = await tx.vendor_payment.create({
          data: {
            vendor_invoice_id: inv.id,
            amount_inr: input.amountInr,
            exchange_rate: input.exchangeRate,
            amount_foreign: amountForeign,
            amount_expected: Math.round(expected * 100) / 100,
            payment_date: new Date(input.paymentDate),
            payment_reference: orNull(input.reference),
            // Shown as "<last tranche covered>/<tranches>" on the invoice.
            is_tranche: maxTranches > 1 && seqs.length > 0 ? 1 : 0,
            tranche_number: seqs.length > 0 ? seqs[seqs.length - 1]! : null,
            total_tranches: maxTranches > 1 ? maxTranches : null,
            is_final: invoiceDone ? 1 : 0,
            notes: orNull(input.notes),
            fy,
            created_by_cp_user_id: ctx.cpUser.id,
          },
        });
        await tx.vendor_invoice.update({
          where: { id: inv.id },
          data: {
            status: invoiceDone
              ? VendorInvoiceStatus.FULLY_PAID
              : VendorInvoiceStatus.PARTIAL_PAYMENT,
          },
        });
        // Each covered tranche is collected, awaiting approval; amount_inr is
        // the tranche's slice of the line's expected amount at this payment's
        // realised rate. It becomes claimable (RECEIVED) on approval, which
        // also stamps the commission-level "fully collected" milestone.
        for (const it of items) {
          const gross = num(it.commission.commision_amount);
          for (const t of it.commission.commission_tranche) {
            if (!collectNow.has(t.id)) continue;
            const fraction = gross > 0 ? num(t.amount) / gross : 1;
            const amountInr =
              Math.round(num(it.expected_amount) * fraction * input.exchangeRate * 100) / 100;
            await tx.commission_tranche.update({
              where: { id: t.id },
              data: { status: TrancheStatus.COLLECTED, amount_inr: amountInr, vendor_payment_id: payment.id },
            });
          }
        }
        await tx.audit_log.create({
          data: {
            action: "vendor_payment.recorded",
            entity_type: "vendor_invoice",
            entity_id: inv.id,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              vendorPaymentId: payment.id,
              amountInr: input.amountInr,
              exchangeRate: input.exchangeRate,
              trancheSeqs: seqs,
              final: input.isFinal,
              collectedTrancheIds: Array.from(collectNow),
              invoiceFullyPaid: invoiceDone,
            },
          },
        });
      });
      return {
        success: true as const,
        collectedTranches: collectNow.size,
        fullyPaid: invoiceDone,
      };
    }),

  // ========================================================================
  // Collections — every recorded vendor payment as a collection record, for
  // Commission Ledger > Collections: awaiting approval first, then approved.
  // ========================================================================
  collections: financeProcedure.query(async () => {
    const payments = await db.vendor_payment.findMany({
      orderBy: { created_at: "desc" },
      take: 300,
      include: {
        vendor_invoice: {
          select: {
            id: true,
            invoice_number: true,
            currency: true,
            vendor: { select: { name: true } },
          },
        },
      },
    });
    const ids = payments.map((p) => p.id);
    const tranches =
      ids.length === 0
        ? []
        : await db.commission_tranche.findMany({
            where: { vendor_payment_id: { in: ids } },
            orderBy: [{ commission_id: "asc" }, { seq: "asc" }],
            select: {
              vendor_payment_id: true,
              seq: true,
              name: true,
              status: true,
              amount: true,
              amount_inr: true,
              commission: {
                select: {
                  id: true,
                  commision_amount: true,
                  ...PAYEE_LABEL_SELECT,
                  vendor_invoice_item: { select: { expected_amount: true } },
                  application: {
                    select: {
                      university_app_id: true,
                      student: { select: { id: true, first_name: true, last_name: true } },
                      course: { select: { name: true, university: { select: { name: true } } } },
                    },
                  },
                },
              },
            },
          });
    const staffIds = Array.from(
      new Set(
        payments
          .flatMap((p) => [p.created_by_cp_user_id, p.approved_by_cp_user_id])
          .filter((x): x is number => x != null),
      ),
    );
    const staff = new Map(
      (staffIds.length > 0
        ? await db.collegepond_user.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, first_name: true, last_name: true },
          })
        : []
      ).map((u) => [u.id, u]),
    );
    // Awaiting approval first, newest first within each group.
    payments.sort((a, b) => Number(a.approved_at != null) - Number(b.approved_at != null));
    return payments.map((p) => {
      const lines = tranches
        .filter((t) => t.vendor_payment_id === p.id)
        .map((t) => {
          const c = t.commission;
          const gross = num(c.commision_amount);
          const expectedLine = num(c.vendor_invoice_item?.expected_amount ?? null);
          return {
            commissionId: c.id,
            studentName: `${c.application.student.first_name} ${c.application.student.last_name}`.trim(),
            cpStudentId: `CP-${String(c.application.student.id).padStart(5, "0")}`,
            universityStudentId: c.application.university_app_id,
            university: c.application.course.university.name,
            program: c.application.course.name,
            ...payeeLabel(c),
            tranche: t.name ?? `Tranche ${t.seq}`,
            trancheStatus: t.status,
            // This tranche's slice of the line's invoiced amount (invoice currency).
            expected: Math.round(expectedLine * (gross > 0 ? num(t.amount) / gross : 1) * 100) / 100,
            amountInr: num(t.amount_inr),
          };
        });
      const pending = p.approved_at == null;
      return {
        id: p.id,
        vendorInvoiceId: p.vendor_invoice.id,
        invoiceNumber: p.vendor_invoice.invoice_number,
        vendorName: p.vendor_invoice.vendor?.name ?? "Direct",
        currency: p.vendor_invoice.currency,
        // Claimed (invoiced) vs received, in the invoice currency.
        amountExpected: p.amount_expected == null ? null : num(p.amount_expected),
        amountReceived: num(p.amount_foreign),
        exchangeRate: num(p.exchange_rate),
        amountInr: num(p.amount_inr),
        paymentDate: p.payment_date,
        reference: p.payment_reference,
        notes: p.notes,
        isFinal: p.is_final === 1,
        recordedBy: staffName(staff.get(p.created_by_cp_user_id ?? -1), p.created_by_cp_user_id),
        recordedAt: p.created_at,
        approvedBy: staffName(staff.get(p.approved_by_cp_user_id ?? -1), p.approved_by_cp_user_id),
        approvedAt: p.approved_at,
        pending,
        lines,
      };
    });
  }),

  // Approve collections (bulk). Their tranches become RECEIVED — claimable —
  // and the partners are told (in-app + email). A commission whose last
  // tranche is now in gets its "fully collected" stamp. Super Admin / Finance
  // Manager only: a Finance Executive records, a manager approves.
  approveCollections: financeManagerProcedure
    .input(z.object({ paymentIds: z.array(z.number().int().positive()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const payments = await db.vendor_payment.findMany({
        where: { id: { in: input.paymentIds }, approved_at: null },
        select: { id: true, exchange_rate: true, is_final: true, vendor_invoice_id: true },
      });
      if (payments.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Those collections are already approved." });
      }
      const now = new Date();
      // Partner notifications, per payee: the students now claimable.
      const claimable = new Map<string, { orgId: number | null; userId: number | null; lines: string[] }>();
      let tranchesReleased = 0;
      for (const p of payments) {
        await db.$transaction(async (tx) => {
          const res = await tx.vendor_payment.updateMany({
            where: { id: p.id, approved_at: null },
            data: { approved_at: now, approved_by_cp_user_id: ctx.cpUser.id },
          });
          if (res.count === 0) return; // approved meanwhile
          const covered = await tx.commission_tranche.findMany({
            where: { vendor_payment_id: p.id, status: TrancheStatus.COLLECTED },
            select: { id: true, commission_id: true },
          });
          await tx.commission_tranche.updateMany({
            where: { id: { in: covered.map((t) => t.id) } },
            data: { status: TrancheStatus.RECEIVED, received_at: now },
          });
          tranchesReleased += covered.length;
          const commissionIds = Array.from(new Set(covered.map((t) => t.commission_id)));
          // A final payment also settles pre-tranche commissions on its invoice.
          const legacy = p.is_final
            ? await tx.vendor_invoice_item.findMany({
                where: {
                  vendor_invoice_id: p.vendor_invoice_id,
                  commission: { collegepond_received_at: null, commission_tranche: { none: {} } },
                },
                select: { commission_id: true, expected_amount: true },
              })
            : [];
          for (const l of legacy) {
            await tx.commission.update({
              where: { id: l.commission_id },
              data: {
                collegepond_received_at: now,
                received_fx_rate: p.exchange_rate,
                claimable_inr: Math.round(num(l.expected_amount) * num(p.exchange_rate) * 100) / 100,
              },
            });
          }
          const comms = await tx.commission.findMany({
            where: { id: { in: [...commissionIds, ...legacy.map((l) => l.commission_id)] } },
            select: {
              id: true,
              org_id: true,
              payee_user_id: true,
              collegepond_received_at: true,
              commission_tranche: { select: { status: true, amount_inr: true, vendor_payment_id: true, name: true } },
              application: { select: { student: { select: { first_name: true, last_name: true } } } },
            },
          });
          for (const c of comms) {
            const ts = c.commission_tranche;
            // The commission-level "fully collected" stamp + full claimable_inr
            // (reporting), once its last tranche is approved.
            if (
              c.collegepond_received_at == null &&
              ts.length > 0 &&
              ts.every((t) => t.status === TrancheStatus.RECEIVED || t.status === TrancheStatus.PAID)
            ) {
              await tx.commission.update({
                where: { id: c.id },
                data: {
                  collegepond_received_at: now,
                  received_fx_rate: p.exchange_rate,
                  claimable_inr: Math.round(ts.reduce((s, t) => s + num(t.amount_inr), 0) * 100) / 100,
                },
              });
            }
            const key = `${c.org_id ?? ""}:${c.payee_user_id ?? ""}`;
            const entry = claimable.get(key) ?? { orgId: c.org_id, userId: c.payee_user_id, lines: [] };
            const names = ts.filter((t) => t.vendor_payment_id === p.id).map((t) => t.name).filter(Boolean);
            entry.lines.push(
              `${`${c.application.student.first_name} ${c.application.student.last_name}`.trim()}${names.length ? ` — ${names.join(", ")}` : ""}`,
            );
            claimable.set(key, entry);
          }
          await tx.audit_log.create({
            data: {
              action: "vendor_payment.collection_approved",
              entity_type: "vendor_payment",
              entity_id: p.id,
              metadata: {
                byCpUserId: ctx.cpUser.id,
                vendorInvoiceId: p.vendor_invoice_id,
                releasedTrancheIds: covered.map((t) => t.id),
                legacyCommissionIds: legacy.map((l) => l.commission_id),
              },
            },
          });
        });
      }
      // Tell each partner what they can claim now (fire-and-forget; saved).
      for (const e of claimable.values()) {
        void payeeRecipients({ orgId: e.orgId, userId: e.userId })
          .then(async (rs) => {
            await createNotifications(
              rs.map((r) => r.id),
              {
                type: "commission.claimable",
                title: e.lines.length === 1 ? "Commission ready to claim" : `${e.lines.length} commissions ready to claim`,
                body: e.lines.slice(0, 3).join("; ") + (e.lines.length > 3 ? "…" : ""),
                link: "/partner/commission",
                tone: "green",
              },
            );
            await emailPartners(
              rs,
              (r) => commissionClaimableEmail(r, { students: e.lines }, appUrl()),
              "commission-claimable",
              "fin.commission",
            );
          })
          .catch((err) => console.error("[notify] commission-claimable failed:", err));
      }
      return { approved: payments.length, tranches: tranchesReleased };
    }),

  // Ageing — unpaid (SENT/PARTIAL) invoices bucketed by days overdue.
  ageing: financeProcedure
    .input(z.object({ vendorId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ input }) => {
      const invoices = await db.vendor_invoice.findMany({
        where: {
          status: { in: [VendorInvoiceStatus.SENT, VendorInvoiceStatus.PARTIAL_PAYMENT] },
          ...(input?.vendorId ? { vendor_id: input.vendorId } : {}),
        },
        include: {
          vendor: true,
          vendor_invoice_item: {
            select: {
              commission: {
                select: {
                  application: {
                    select: {
                      course: { select: { university: { select: { name: true } } } },
                    },
                  },
                },
              },
            },
          },
          vendor_payment: { select: { amount_foreign: true } },
        },
      });
      const today = new Date();
      const rows = invoices.map((inv) => {
        const daysOverdue = inv.due_date
          ? Math.floor((today.getTime() - inv.due_date.getTime()) / 86_400_000)
          : 0;
        const paidForeign = inv.vendor_payment.reduce(
          (s, p) => s + num(p.amount_foreign),
          0,
        );
        const outstanding =
          Math.round((num(inv.total_expected_amount) - paidForeign) * 100) / 100;
        const unis = Array.from(
          new Set(
            inv.vendor_invoice_item.map(
              (it) => it.commission.application.course.university.name,
            ),
          ),
        );
        return {
          id: inv.id,
          invoiceNumber: inv.invoice_number,
          vendorName: inv.vendor?.name ?? "Direct",
          university: unis.length === 0 ? "—" : unis.length === 1 ? unis[0]! : "Multiple",
          currency: inv.currency,
          students: inv.vendor_invoice_item.length,
          outstanding,
          outstandingInr: toINR(outstanding, inv.currency),
          dueDate: inv.due_date,
          daysOverdue: Math.max(0, daysOverdue),
          bucket:
            daysOverdue <= 30 ? 0 : daysOverdue <= 60 ? 1 : daysOverdue <= 90 ? 2 : 3,
          status: inv.status,
        };
      });
      const buckets = [0, 1, 2, 3].map((b) => {
        const inBucket = rows.filter((r) => r.bucket === b);
        return {
          bucket: b,
          count: inBucket.length,
          inrTotal:
            Math.round(inBucket.reduce((s, r) => s + r.outstandingInr, 0) * 100) / 100,
        };
      });
      return { rows, buckets };
    }),

  // KPI cards — counts + exact INR received (cross-currency expected isn't
  // convertible to INR until paid, so we report counts there honestly).
  stats: financeProcedure
    .input(z.object({ fy: z.number().int().optional() }).optional())
    .query(async ({ input }) => {
      const where = input?.fy ? { fy: input.fy } : {};
      const invoices = await db.vendor_invoice.findMany({
        where,
        select: {
          status: true,
          currency: true,
          total_expected_amount: true,
          due_date: true,
        },
      });
      const payments = await db.vendor_payment.findMany({
        where: input?.fy ? { fy: input.fy } : {},
        select: { amount_inr: true },
      });
      const today = new Date();
      const expectedInr =
        Math.round(
          invoices.reduce(
            (s, i) => s + toINR(num(i.total_expected_amount), i.currency),
            0,
          ) * 100,
        ) / 100;
      const receivedInr =
        Math.round(payments.reduce((s, p) => s + num(p.amount_inr), 0) * 100) / 100;
      const outstandingInr = Math.max(
        0,
        Math.round((expectedInr - receivedInr) * 100) / 100,
      );
      const overdueCount = invoices.filter(
        (i) =>
          (i.status === VendorInvoiceStatus.SENT ||
            i.status === VendorInvoiceStatus.PARTIAL_PAYMENT) &&
          i.due_date != null &&
          i.due_date.getTime() < today.getTime(),
      ).length;
      const collectionRate =
        expectedInr > 0
          ? Math.min(100, Math.round((receivedInr / expectedInr) * 100))
          : 0;
      return { expectedInr, receivedInr, outstandingInr, overdueCount, collectionRate };
    }),

  // Financial years present in the data, for the stats dropdown.
  financialYears: financeProcedure.query(async () => {
    const rows = await db.vendor_invoice.findMany({
      where: { fy: { not: null } },
      distinct: ["fy"],
      select: { fy: true },
      orderBy: { fy: "desc" },
    });
    return rows.map((r) => r.fy!).filter((fy): fy is number => fy != null);
  }),
});
