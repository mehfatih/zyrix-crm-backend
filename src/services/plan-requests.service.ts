// ============================================================================
// PLAN CHANGE REQUESTS (Sprint 16D) — in-app upgrade/downgrade flow.
// Tenant requests a plan → platform admin notified → admin confirms payment
// (manual v1) and approves → company.plan is set and every feature under the
// plan goes live instantly via entitlement resolution. No billing automation.
// ============================================================================

import { prisma } from "../config/database";
import { env } from "../config/env";
import { badRequest, notFound } from "../middleware/errorHandler";
import { sendEmail } from "./email.service";
import { recordPlanChange } from "./entitlements.service";

const PLAN_SLUGS = ["free", "starter", "business", "enterprise"] as const;
type PlanSlug = (typeof PLAN_SLUGS)[number];
function isPlan(v: string): v is PlanSlug {
  return (PLAN_SLUGS as readonly string[]).includes(v);
}

const APP_URL = env.APP_URL || "https://crm.zyrix.co";
const adminEmail = () => env.ADMIN_NOTIFY_EMAIL || "support@zyrix.co";

function triEmail(blocks: { en: string; ar: string; tr: string }): string {
  return `
<div style="font-family:Inter,Arial,sans-serif;color:#0f172a;line-height:1.6">
  <p>${blocks.en}</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0" />
  <p dir="rtl" style="font-family:Tajawal,Arial">${blocks.ar}</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0" />
  <p>${blocks.tr}</p>
</div>`;
}

async function ownerEmail(companyId: string): Promise<string | null> {
  const u = await prisma.user.findFirst({
    where: { companyId, status: { not: "deleted" } },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return u?.email ?? null;
}

// ── Tenant side ──────────────────────────────────────────────────────────

export async function createOrUpdateRequest(
  companyId: string,
  requestedByUserId: string,
  requestedPlan: string,
  note?: string
) {
  if (!isPlan(requestedPlan)) throw badRequest(`Unknown plan: ${requestedPlan}`);
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { plan: true, name: true },
  });
  if (!company) throw notFound("Company");
  if (company.plan === requestedPlan) {
    throw badRequest("You are already on this plan.");
  }

  const existing = await prisma.planChangeRequest.findFirst({
    where: { companyId, status: "pending" },
  });
  const request = existing
    ? await prisma.planChangeRequest.update({
        where: { id: existing.id },
        data: { requestedPlan, currentPlan: company.plan, note: note ?? null, requestedByUserId },
      })
    : await prisma.planChangeRequest.create({
        data: {
          companyId,
          currentPlan: company.plan,
          requestedPlan,
          note: note ?? null,
          requestedByUserId,
        },
      });

  // Notify the platform admin (fire-and-forget; never block the request).
  sendEmail({
    to: adminEmail(),
    subject: `[Zyrix] Plan request: ${company.name} → ${requestedPlan}`,
    html: triEmail({
      en: `${company.name} requested an upgrade from <b>${company.plan}</b> to <b>${requestedPlan}</b>.${note ? ` Note: ${note}` : ""} Review in the admin panel → Plan requests.`,
      ar: `طلبت شركة ${company.name} الترقية من <b>${company.plan}</b> إلى <b>${requestedPlan}</b>.${note ? ` ملاحظة: ${note}` : ""} راجع الطلب من لوحة الإدارة ← طلبات الباقات.`,
      tr: `${company.name}, <b>${company.plan}</b> planından <b>${requestedPlan}</b> planına yükseltme talep etti.${note ? ` Not: ${note}` : ""} Yönetim paneli → Plan talepleri.`,
    }),
  }).catch(() => {});

  return request;
}

export async function getCurrentRequest(companyId: string) {
  return prisma.planChangeRequest.findFirst({
    where: { companyId },
    orderBy: { createdAt: "desc" },
  });
}

export async function cancelRequest(companyId: string) {
  const existing = await prisma.planChangeRequest.findFirst({
    where: { companyId, status: "pending" },
  });
  if (!existing) throw notFound("Pending request");
  return prisma.planChangeRequest.update({
    where: { id: existing.id },
    data: { status: "cancelled" },
  });
}

// ── Admin side ───────────────────────────────────────────────────────────

export async function listRequests(status?: string) {
  const rows = await prisma.planChangeRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  // Attach company name for the admin list.
  const ids = [...new Set(rows.map((r) => r.companyId))];
  const companies = await prisma.company.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, plan: true },
  });
  const byId = new Map(companies.map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r, company: byId.get(r.companyId) ?? null }));
}

export async function pendingCount(): Promise<number> {
  return prisma.planChangeRequest.count({ where: { status: "pending" } });
}

export async function approveRequest(id: string, adminId: string) {
  const req = await prisma.planChangeRequest.findUnique({ where: { id } });
  if (!req) throw notFound("Request");
  if (req.status !== "pending") throw badRequest("Request is not pending.");
  const company = await prisma.company.findUnique({
    where: { id: req.companyId },
    select: { plan: true, name: true },
  });
  if (!company) throw notFound("Company");

  // Set the plan → instant activation (resolution + cache invalidate + audit).
  await prisma.company.update({
    where: { id: req.companyId },
    data: { plan: req.requestedPlan },
  });
  await recordPlanChange(req.companyId, company.plan, req.requestedPlan, adminId);

  const updated = await prisma.planChangeRequest.update({
    where: { id },
    data: { status: "approved", decidedByAdminId: adminId, decidedAt: new Date() },
  });

  const to = await ownerEmail(req.companyId);
  if (to) {
    sendEmail({
      to,
      subject: `[Zyrix] Your ${req.requestedPlan} plan is now live`,
      html: triEmail({
        en: `Your plan has been activated: <b>${req.requestedPlan}</b>. Everything under it is live now — just refresh. <a href="${APP_URL}">Open Zyrix</a>.`,
        ar: `تم تفعيل باقتك: <b>${req.requestedPlan}</b>. كل ميزاتها متاحة الآن — فقط حدّث الصفحة. <a href="${APP_URL}">افتح Zyrix</a>.`,
        tr: `Planınız etkinleştirildi: <b>${req.requestedPlan}</b>. Tüm özellikler artık aktif — sayfayı yenilemeniz yeterli. <a href="${APP_URL}">Zyrix'i aç</a>.`,
      }),
    }).catch(() => {});
  }
  return updated;
}

export async function rejectRequest(id: string, adminId: string, reason?: string) {
  const req = await prisma.planChangeRequest.findUnique({ where: { id } });
  if (!req) throw notFound("Request");
  if (req.status !== "pending") throw badRequest("Request is not pending.");
  const updated = await prisma.planChangeRequest.update({
    where: { id },
    data: { status: "rejected", decidedByAdminId: adminId, decidedAt: new Date(), note: reason ?? req.note },
  });

  const to = await ownerEmail(req.companyId);
  if (to) {
    sendEmail({
      to,
      subject: `[Zyrix] Update on your plan request`,
      html: triEmail({
        en: `We couldn't activate <b>${req.requestedPlan}</b> yet.${reason ? ` ${reason}` : ""} Reply to this email and we'll help.`,
        ar: `لم نتمكن من تفعيل <b>${req.requestedPlan}</b> بعد.${reason ? ` ${reason}` : ""} ردّ على هذا البريد وسنساعدك.`,
        tr: `<b>${req.requestedPlan}</b> planını henüz etkinleştiremedik.${reason ? ` ${reason}` : ""} Bu e-postayı yanıtlayın, yardımcı olalım.`,
      }),
    }).catch(() => {});
  }
  return updated;
}
