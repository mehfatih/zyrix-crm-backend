import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { env, corsOrigins, isDevelopment } from "./config/env";
import { prisma } from "./config/database";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

// Routes
import authRoutes from "./routes/auth.routes";

// ============================================================================
// ZYRIX CRM BACKEND — Entry Point
// ============================================================================

const app: Express = express();

// ─────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
// Health Check Endpoints
// ─────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "Zyrix CRM API",
    version: "0.1.0",
    status: "operational",
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    documentation: "https://crm.zyrix.co/api-docs",
  });
});

app.get("/health", async (_req, res) => {
  try {
    // Check DB connection
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "healthy",
      database: "connected",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      database: "disconnected",
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/api", (_req, res) => {
  res.json({
    message: "Zyrix CRM API v0.1.0",
    endpoints: {
      health: "/health",
      auth: "/api/auth",
      authEndpoints: {
        signup: "POST /api/auth/signup",
        signin: "POST /api/auth/signin",
        refresh: "POST /api/auth/refresh",
        logout: "POST /api/auth/logout",
        me: "GET /api/auth/me (requires Bearer token)",
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);

// ─────────────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────
// Server Startup
// ─────────────────────────────────────────────────────────────────────────
const server = app.listen(env.PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║                                                  ║");
  console.log("║          🚀 Zyrix CRM Backend v0.1.0             ║");
  console.log("║                                                  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Environment:  ${env.NODE_ENV}`);
  console.log(`  Port:         ${env.PORT}`);
  console.log(`  URL:          ${env.API_URL}`);
  console.log(`  Frontend:     ${env.FRONTEND_URL}`);
  console.log(`  CORS:         ${corsOrigins.join(", ")}`);
  console.log("");
  console.log("  Auth endpoints:");
  console.log(`    POST  ${env.API_URL}/api/auth/signup`);
  console.log(`    POST  ${env.API_URL}/api/auth/signin`);
  console.log(`    POST  ${env.API_URL}/api/auth/refresh`);
  console.log(`    POST  ${env.API_URL}/api/auth/logout`);
  console.log(`    GET   ${env.API_URL}/api/auth/me`);
  console.log("");
});

// ─────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  await prisma.$disconnect();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;