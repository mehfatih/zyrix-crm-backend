import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { env, corsOrigins, isDevelopment } from "./config/env";
import { prisma } from "./config/database";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import authRoutes from "./routes/auth.routes";
import customerRoutes from "./routes/customer.routes";
import dealRoutes from "./routes/deal.routes";
import activityRoutes from "./routes/activity.routes";
import taskRoutes from "./routes/task.routes";
import quoteRoutes from "./routes/quote.routes";
import loyaltyRoutes from "./routes/loyalty.routes";
import taxRoutes from "./routes/tax.routes";
import cashflowRoutes from "./routes/cashflow.routes";
import followupRoutes from "./routes/followup.routes";
import aiCfoRoutes from "./routes/ai-cfo.routes";
import commissionRoutes from "./routes/commission.routes";
import campaignsRoutes from "./routes/campaigns.routes";
import contractRoutes from "./routes/contract.routes";
import portalRoutes from "./routes/portal.routes";
import chatRoutes from "./routes/chat.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import reportsRoutes from "./routes/reports.routes";
import advancedRoutes from "./routes/advanced.routes";
import whatsappRoutes from "./routes/whatsapp.routes";
import adminRoutes from "./routes/admin.routes";
import publicRoutes from "./routes/public.routes";
import paymentRoutes from "./routes/payment.routes";
import { webhookReceiverRouter, webhookAdminRouter } from "./routes/webhook.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import securityRoutes from "./routes/security.routes";
import billingRoutes from "./routes/billing.routes";
import dashboardLayoutRoutes from "./routes/dashboard-layout.routes";
import templatesRoutes from "./routes/templates.routes";
import workflowsRoutes from "./routes/workflows.routes";
import workflowWebhookRouter from "./routes/workflow-webhook.routes";
import apiKeysRoutes from "./routes/api-keys.routes";
import publicApiRoutes from "./routes/public-api.routes";
import zapierRoutes from "./routes/zapier.routes";
import aiAgentsRoutes from "./routes/ai-agents.routes";
import oauthRoutes from "./routes/oauth.routes";
import brandRoutes from "./routes/brand.routes";
import commentsRoutes from "./routes/comments.routes";
import notificationsRoutes from "./routes/notifications.routes";
import analyticsReportsRoutes from "./routes/analytics-reports.routes";
import brandsRoutes from "./routes/brands.routes";
import taxInvoicesRoutes from "./routes/tax-invoices.routes";
import sessionEventsRoutes from "./routes/session-events.routes";
import featureFlagsRoutes from "./routes/feature-flags.routes";
import rolesRoutes from "./routes/roles.routes";
import auditLogsRoutes from "./routes/audit-logs.routes";
import ipAllowlistRoutes from "./routes/ip-allowlist.routes";
import retentionRoutes from "./routes/retention.routes";
import complianceRoutes from "./routes/compliance.routes";
import scimRoutes from "./routes/scim.routes";
import scimTokensRoutes from "./routes/scim-tokens.routes";
import { enforceIpAllowlist } from "./middleware/ipAllowlist";
import { startRetentionCron } from "./cron/data-retention";
import { authenticateToken } from "./middleware/auth";
import { seedSystemRolesForAllCompanies } from "./services/roles.service";
import { seedTemplates } from "./services/templates-seed";
import { startSyncScheduler } from "./cron/sync";
import { startWorkflowWorker } from "./cron/workflow-worker";
import { startScheduledReportsWorker } from "./cron/scheduled-reports-worker";

const app: Express = express();

// Trust Railway/Cloudflare proxy (for correct IP in rate-limit + logs)
app.set("trust proxy", 1);

app.use(helmet());

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

// ──────────────────────────────────────────────────────────────────────
// Webhook RECEIVER must come BEFORE express.json() so HMAC verification
// sees the exact bytes the platform signed. Its own router applies
// express.raw() scoped to the receiver path only.
// ──────────────────────────────────────────────────────────────────────
app.use("/api/webhooks", webhookReceiverRouter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

if (isDevelopment) {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

app.get("/", (_req, res) => {
  res.json({
    name: "Zyrix CRM API",
    version: "0.6.0",
    status: "operational",
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "healthy",
      database: "connected",
      ai: env.GEMINI_API_KEY ? "configured" : "not configured",
      uptime: process.uptime(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
});

app.get("/api", (_req, res) => {
  res.json({
    message: "Zyrix CRM API v0.6.0",
    endpoints: {
      auth: "/api/auth",
      customers: "/api/customers",
      deals: "/api/deals",
      activities: "/api/activities",
      tasks: "/api/tasks",
      quotes: "/api/quotes",
      loyalty: "/api/loyalty",
      tax: "/api/tax",
      cashflow: "/api/cashflow",
      followup: "/api/followup",
      aiCfo: "/api/ai-cfo",
      commission: "/api/commission",
      campaigns: "/api/campaigns",
      contracts: "/api/contracts",
      portal: "/api/portal",
      chat: "/api/chat",
      dashboard: "/api/dashboard",
      reports: "/api/reports",
      advanced: "/api/advanced",
      whatsapp: "/api/whatsapp",
      admin: "/api/admin",
      public: "/api/public",
      payments: "/api/payments",
    },
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/deals", dealRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/loyalty", loyaltyRoutes);
app.use("/api/tax", taxRoutes);
app.use("/api/cashflow", cashflowRoutes);
app.use("/api/followup", followupRoutes);
app.use("/api/ai-cfo", aiCfoRoutes);
app.use("/api/commission", commissionRoutes);
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/contracts", contractRoutes);
app.use("/api/portal", portalRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/advanced", advancedRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookAdminRouter);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/security", securityRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/dashboard", dashboardLayoutRoutes);
app.use("/api/templates", templatesRoutes);
app.use("/api/workflows", workflowsRoutes);
app.use("/api/keys", apiKeysRoutes);
app.use("/api/ai-agents", aiAgentsRoutes);
app.use("/api/oauth", oauthRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/comments", commentsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/analytics-reports", analyticsReportsRoutes);
app.use("/api/brands", brandsRoutes);
app.use("/api/tax-invoices", taxInvoicesRoutes);
app.use("/api/session-events", sessionEventsRoutes);
app.use("/api/feature-flags", featureFlagsRoutes);
app.use("/api", rolesRoutes);
app.use("/api/audit-logs", auditLogsRoutes);
app.use("/api/admin/ip-allowlist", ipAllowlistRoutes);
app.use("/api/data-retention", retentionRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/scim-tokens", scimTokensRoutes);
app.use("/scim/v2", scimRoutes);
// Public workflow webhook receiver — no auth, rate-limited per workflow
app.use("/wh", workflowWebhookRouter);
// Public API v1 — API-key auth, rate-limited per key
app.use("/v1", publicApiRoutes);
// Zapier-specific routes (flat-array responses, dropdowns, etc.)
app.use("/v1/zapier", zapierRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║          🚀 Zyrix CRM Backend v0.6.0             ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Environment:  ${env.NODE_ENV}`);
  console.log(`  Port:         ${env.PORT}`);
  console.log(`  AI:           ${env.GEMINI_API_KEY ? "✓ Gemini ready" : "✗ Not configured"}`);
  console.log(
    `  Payments:     Iyzico ${env.IYZICO_API_KEY ? "✓" : "✗"}  HyperPay ${env.HYPERPAY_ACCESS_TOKEN ? "✓" : "✗"}`
  );
  console.log("");
  console.log("  Modules loaded:");
  console.log("    ✓ Auth");
  console.log("    ✓ Customers CRUD");
  console.log("    ✓ Deals + Pipeline");
  console.log("    ✓ Activities");
  console.log("    ✓ WhatsApp + AI");
  console.log("    ✓ Admin Panel (Super Admin)");
  console.log("    ✓ Payments (Iyzico + HyperPay)");
  console.log("");

  // Register scheduled jobs after the server is listening so cron output
  // is never lost to missed log buffering on cold boots.
  startSyncScheduler();
  startWorkflowWorker();
  startScheduledReportsWorker();
  startRetentionCron();

  // Seed curated templates — idempotent upsert by slug. Failures here
  // shouldn't crash the server; template gallery will just show whatever
  // is already in the DB (or empty on first deploy before SQL migration
  // runs).
  seedTemplates().catch((err) => {
    console.error("[templates] seed failed (non-fatal):", err.message);
  });

  // Ensure every existing company has the four system roles (P1 RBAC).
  // Idempotent — no-ops for companies already seeded. Non-fatal so a
  // DB hiccup or missing `roles` table (pre-SQL-apply) can't block boot.
  seedSystemRolesForAllCompanies()
    .then(({ companies }) =>
      console.log(`[rbac] system roles ensured for ${companies} companies`)
    )
    .catch((err) =>
      console.error("[rbac] system role seed failed (non-fatal):", err.message)
    );
});

const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down...`);
  await prisma.$disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;