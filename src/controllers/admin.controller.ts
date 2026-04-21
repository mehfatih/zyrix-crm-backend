import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../config/database";
import { bootstrapAdminPanel } from "../services/admin-bootstrap.service";
import { adminSignin } from "../services/admin-auth.service";
import * as CompaniesSvc from "../services/admin-companies.service";
import * as UsersSvc from "../services/admin-users.service";
import * as PlansSvc from "../services/admin-plans.service";
import * as AnnouncementsSvc from "../services/admin-announcements.service";
import * as SupportSvc from "../services/admin-support.service";
import * as SettingsSvc from "../services/admin-settings.service";
import { runScheduledSync } from "../cron/sync";
import type { AuthenticatedRequest } from "../types";

// ============================================================================
// ADMIN CONTROLLER
// ============================================================================

const bootstrapSchema = z.object({ token: z.string().min(10) });
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const listCompaniesSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  plan: z.string().optional(),
  sortBy: z.enum(["createdAt", "name", "plan"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  plan: z.string().optional(),
  billingEmail: z.string().email().optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  size: z.string().optional(),
  baseCurrency: z.string().min(3).max(8).nullable().optional(),
  // Auto-lock idle timeout in minutes. 0 or null disables it (e.g.
  // for TV-dashboard merchants). Range 0..60 — longer than an hour
  // defeats the security purpose of the feature.
  idleTimeoutMinutes: z.number().int().min(0).max(60).nullable().optional(),
});

const suspendCompanySchema = z.object({ reason: z.string().optional() });

const listUsersSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  search: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  companyId: z.string().optional(),
  sortBy: z.enum(["createdAt", "email", "lastLoginAt"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

const updateUserSchema = z.object({
  fullName: z.string().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
});

const disableUserSchema = z.object({ reason: z.string().optional() });

const updatePlanSchema = z.object({
  name: z.string().optional(),
  nameAr: z.string().optional(),
  nameTr: z.string().optional(),
  description: z.string().optional(),
  descriptionAr: z.string().optional(),
  descriptionTr: z.string().optional(),
  priceMonthlyUsd: z.coerce.number().optional(),
  priceYearlyUsd: z.coerce.number().optional(),
  priceMonthlyTry: z.coerce.number().optional(),
  priceYearlyTry: z.coerce.number().optional(),
  priceMonthlySar: z.coerce.number().optional(),
  priceYearlySar: z.coerce.number().optional(),
  maxUsers: z.coerce.number().optional(),
  maxCustomers: z.coerce.number().optional(),
  maxDeals: z.coerce.number().optional(),
  maxStorageGb: z.coerce.number().optional(),
  maxWhatsappMsg: z.coerce.number().optional(),
  maxAiTokens: z.coerce.number().optional(),
  features: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.coerce.number().optional(),
  color: z.string().optional(),
});

const grantOverrideSchema = z.object({
  companyId: z.string().min(1),
  featureSlug: z.string().min(1),
  enabled: z.boolean().optional(),
  expiresAt: z.coerce.date().optional(),
  reason: z.string().optional(),
});

// ────────────────────────────────────────────────────────
// Bootstrap + Auth
// ────────────────────────────────────────────────────────
export async function bootstrap(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = bootstrapSchema.parse(req.body);
    const result = await bootstrapAdminPanel(token);
    res.status(201).json({
      success: true,
      data: result,
      message: "Admin panel bootstrapped successfully.",
    });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = loginSchema.parse(req.body);
    const result = await adminSignin(dto);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const authReq = req as AuthenticatedRequest;
    const user = await prisma.user.findUnique({
      where: { id: authReq.user.userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        emailVerified: true,
        twoFactorEnabled: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "User not found" },
      });
      return;
    }
    res.status(200).json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Stats
// ────────────────────────────────────────────────────────
export async function stats(_req: Request, res: Response, next: NextFunction) {
  try {
    const [
      totalCompanies,
      activeCompanies,
      suspendedCompanies,
      trialCompanies,
      totalUsers,
      activeUsers,
      totalCustomers,
      totalDeals,
      totalSubscriptions,
      activeSubscriptions,
    ] = await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { status: "active" } }),
      prisma.company.count({ where: { status: "suspended" } }),
      prisma.company.count({ where: { status: "trial" } }),
      prisma.user.count(),
      prisma.user.count({ where: { status: "active" } }),
      prisma.customer.count(),
      prisma.deal.count(),
      prisma.subscription.count(),
      prisma.subscription.count({ where: { status: "active" } }),
    ]);

    const plansDistribution = await prisma.company.groupBy({
      by: ["plan"],
      _count: { _all: true },
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentSignups = await prisma.company.count({
      where: { createdAt: { gte: thirtyDaysAgo } },
    });

    res.status(200).json({
      success: true,
      data: {
        companies: {
          total: totalCompanies,
          active: activeCompanies,
          suspended: suspendedCompanies,
          trial: trialCompanies,
          recentSignups30d: recentSignups,
        },
        users: { total: totalUsers, active: activeUsers },
        dataCounts: { customers: totalCustomers, deals: totalDeals },
        subscriptions: { total: totalSubscriptions, active: activeSubscriptions },
        plansDistribution: plansDistribution.map((p: { plan: string; _count: { _all: number } }) => ({
          plan: p.plan,
          count: p._count._all,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Companies
// ────────────────────────────────────────────────────────
export async function listCompanies(req: Request, res: Response, next: NextFunction) {
  try {
    const opts = listCompaniesSchema.parse(req.query);
    const result = await CompaniesSvc.listCompanies(opts);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const company = await CompaniesSvc.getCompany((req.params.id as any));
    res.status(200).json({ success: true, data: company });
  } catch (err) {
    next(err);
  }
}

export async function updateCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = updateCompanySchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await CompaniesSvc.updateCompany((req.params.id as any), actor, dto);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function suspendCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = suspendCompanySchema.parse(req.body ?? {});
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await CompaniesSvc.suspendCompany((req.params.id as any), actor, reason);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function resumeCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await CompaniesSvc.resumeCompany((req.params.id as any), actor);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function deleteCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const result = await CompaniesSvc.deleteCompany((req.params.id as any), actor);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function impersonateCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const result = await CompaniesSvc.impersonateCompanyOwner((req.params.id as any), actor);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function impersonateCompanyToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const result = await CompaniesSvc.impersonateCompanyToken(
      (req.params.id as string),
      actor
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Users
// ────────────────────────────────────────────────────────
export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const opts = listUsersSchema.parse(req.query);
    const result = await UsersSvc.listUsers(opts);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getUser(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await UsersSvc.getUser((req.params.id as any));
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = updateUserSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await UsersSvc.updateUser((req.params.id as any), actor, dto);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function disableUser(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = disableUserSchema.parse(req.body ?? {});
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await UsersSvc.disableUser((req.params.id as any), actor, reason);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function enableUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await UsersSvc.enableUser((req.params.id as any), actor);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function forceResetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const result = await UsersSvc.forceResetPassword((req.params.id as any), actor);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Plans
// ────────────────────────────────────────────────────────
export async function listPlansAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const plans = await PlansSvc.listPlans(includeInactive);
    res.status(200).json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
}

export async function getPlanAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const plan = await PlansSvc.getPlan((req.params.id as any));
    res.status(200).json({ success: true, data: plan });
  } catch (err) {
    next(err);
  }
}

export async function updatePlanAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = updatePlanSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const updated = await PlansSvc.updatePlan((req.params.id as any), actor, dto);
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function listOverrides(req: Request, res: Response, next: NextFunction) {
  try {
    const companyId = req.query.companyId as string | undefined;
    const result = await PlansSvc.listOverrides(companyId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function grantOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = grantOverrideSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const result = await PlansSvc.grantOverride(
      dto.companyId,
      dto.featureSlug,
      actor,
      { enabled: dto.enabled, expiresAt: dto.expiresAt, reason: dto.reason }
    );
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function revokeOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const result = await PlansSvc.revokeOverride((req.params.id as any), actor);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Audit Logs
// ────────────────────────────────────────────────────────
export async function listAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1"));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50")));
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, email: true, fullName: true } },
          company: { select: { id: true, name: true, slug: true } },
        },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    next(err);
  }
}
// ────────────────────────────────────────────────────────
// Announcements
// ────────────────────────────────────────────────────────
const createAnnouncementSchema = z.object({
  title: z.string().min(1),
  titleAr: z.string().optional(),
  titleTr: z.string().optional(),
  content: z.string().min(1),
  contentAr: z.string().optional(),
  contentTr: z.string().optional(),
  type: z.enum(["info", "warning", "critical", "success"]).optional(),
  target: z.enum(["all", "plan", "company"]).optional(),
  targetValue: z.string().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateAnnouncementSchema = createAnnouncementSchema.partial();

const listAnnouncementsSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  active: z.coerce.boolean().optional(),
  target: z.string().optional(),
});

export async function listAnnouncements(req: Request, res: Response, next: NextFunction) {
  try {
    const q = listAnnouncementsSchema.parse(req.query);
    const data = await AnnouncementsSvc.listAnnouncements(q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await AnnouncementsSvc.getAnnouncement(req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function createAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = createAnnouncementSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await AnnouncementsSvc.createAnnouncement(
      actor,
      dto as AnnouncementsSvc.CreateAnnouncementDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = updateAnnouncementSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await AnnouncementsSvc.updateAnnouncement(
      req.params.id as string,
      actor,
      dto
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await AnnouncementsSvc.deleteAnnouncement(
      req.params.id as string,
      actor
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Support Tickets
// ────────────────────────────────────────────────────────
const listTicketsSchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  category: z.string().optional(),
  companyId: z.string().optional(),
  assignedToId: z.string().optional(),
});

const updateTicketSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  category: z.string().optional(),
  assignedToId: z.string().nullable().optional(),
});

const assignTicketSchema = z.object({ assigneeId: z.string().min(1) });

export async function listTickets(req: Request, res: Response, next: NextFunction) {
  try {
    const q = listTicketsSchema.parse(req.query);
    const data = await SupportSvc.listTickets(q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await SupportSvc.getTicket(req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = updateTicketSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await SupportSvc.updateTicket(req.params.id as string, actor, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function assignTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const { assigneeId } = assignTicketSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await SupportSvc.assignTicket(req.params.id as string, actor, assigneeId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function closeTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await SupportSvc.closeTicket(req.params.id as string, actor);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function ticketStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await SupportSvc.getTicketStats();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ────────────────────────────────────────────────────────
// Settings — super admins management
// ────────────────────────────────────────────────────────
const inviteSuperAdminSchema = z.object({
  email: z.string().email(),
  fullName: z.string().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function listSuperAdmins(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await SettingsSvc.listSuperAdmins();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function inviteSuperAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = inviteSuperAdminSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await SettingsSvc.inviteSuperAdmin(
      actor,
      dto as SettingsSvc.InviteSuperAdminDto
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function revokeSuperAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await SettingsSvc.revokeSuperAdmin(actor, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function changeAdminPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const actor = (req as AuthenticatedRequest).user.userId;
    const data = await SettingsSvc.changeAdminPassword(
      actor,
      currentPassword,
      newPassword
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ============================================================================
// CRON — manual trigger for the scheduled e-commerce sync
// ============================================================================
export async function triggerSyncCron(_req: Request, res: Response, next: NextFunction) {
  try {
    // Fire-and-forget: return immediately so the admin UI doesn't hang on
    // a long sync sweep. The response tells them it's been kicked off and
    // they can watch the per-store status on /settings/integrations.
    runScheduledSync().catch((e) => {
      console.error("[admin] manual sync trigger failed:", e?.message || e);
    });
    res.status(202).json({
      success: true,
      data: { triggered: true, message: "Scheduled sync started in background" },
    });
  } catch (err) {
    next(err);
  }
}
