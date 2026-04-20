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
import whatsappRoutes from "./routes/whatsapp.routes";
import adminRoutes from "./routes/admin.routes";
import publicRoutes from "./routes/public.routes";
import paymentRoutes from "./routes/payment.routes";

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
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/payments", paymentRoutes);

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