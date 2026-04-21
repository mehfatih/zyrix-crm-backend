import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../middleware/superAdmin";
import * as AdminCtrl from "../controllers/admin.controller";
import * as FeatureCtrl from "../controllers/feature-flags.controller";

// ============================================================================
// ADMIN ROUTES — /api/admin/*
// ============================================================================

const router = Router();

const bootstrapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many bootstrap attempts." },
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many login attempts." },
  },
});

// Public (no auth)
router.post("/bootstrap", bootstrapLimiter, AdminCtrl.bootstrap);
router.post("/login", loginLimiter, AdminCtrl.login);

// Protected — super_admin only
router.use(requireSuperAdmin);

// Account
router.get("/me", AdminCtrl.me);

// Stats
router.get("/stats", AdminCtrl.stats);

// Companies
router.get("/companies", AdminCtrl.listCompanies);
router.get("/companies/:id", AdminCtrl.getCompany);
router.patch("/companies/:id", AdminCtrl.updateCompany);
router.post("/companies/:id/suspend", AdminCtrl.suspendCompany);
router.post("/companies/:id/resume", AdminCtrl.resumeCompany);
router.delete("/companies/:id", AdminCtrl.deleteCompany);
router.post("/companies/:id/impersonate", AdminCtrl.impersonateCompany);

// Per-company feature flags — platform owner controls which features
// each merchant has enabled.
router.get("/companies/:id/features", FeatureCtrl.adminGetCompanyFlags);
router.post("/companies/:id/features", FeatureCtrl.adminSetBulk);
router.post("/companies/:id/features/toggle", FeatureCtrl.adminSetFlag);
router.post(
  "/companies/:id/impersonate-token",
  AdminCtrl.impersonateCompanyToken
);

// Users
router.get("/users", AdminCtrl.listUsers);
router.get("/users/:id", AdminCtrl.getUser);
router.patch("/users/:id", AdminCtrl.updateUser);
router.post("/users/:id/disable", AdminCtrl.disableUser);
router.post("/users/:id/enable", AdminCtrl.enableUser);
router.post("/users/:id/force-reset-password", AdminCtrl.forceResetPassword);

// Plans
router.get("/plans", AdminCtrl.listPlansAdmin);
router.get("/plans/:id", AdminCtrl.getPlanAdmin);
router.patch("/plans/:id", AdminCtrl.updatePlanAdmin);

// Plan Overrides
router.get("/plan-overrides", AdminCtrl.listOverrides);
router.post("/plan-overrides", AdminCtrl.grantOverride);
router.delete("/plan-overrides/:id", AdminCtrl.revokeOverride);

// Audit Logs
router.get("/audit-logs", AdminCtrl.listAuditLogs);

// Announcements
router.get("/announcements", AdminCtrl.listAnnouncements);
router.get("/announcements/:id", AdminCtrl.getAnnouncement);
router.post("/announcements", AdminCtrl.createAnnouncement);
router.patch("/announcements/:id", AdminCtrl.updateAnnouncement);
router.delete("/announcements/:id", AdminCtrl.deleteAnnouncement);

// Support Tickets
router.get("/tickets/stats", AdminCtrl.ticketStats);
router.get("/tickets", AdminCtrl.listTickets);
router.get("/tickets/:id", AdminCtrl.getTicket);
router.patch("/tickets/:id", AdminCtrl.updateTicket);
router.post("/tickets/:id/assign", AdminCtrl.assignTicket);
router.post("/tickets/:id/close", AdminCtrl.closeTicket);

// Settings — super admins
router.get("/super-admins", AdminCtrl.listSuperAdmins);
router.post("/super-admins/invite", AdminCtrl.inviteSuperAdmin);
router.delete("/super-admins/:id", AdminCtrl.revokeSuperAdmin);
router.post("/change-password", AdminCtrl.changeAdminPassword);

// Operations — manually kick off the scheduled sync
router.post("/trigger-sync", AdminCtrl.triggerSyncCron);

export default router;
