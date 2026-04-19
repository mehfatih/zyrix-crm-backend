import "dotenv/config";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// ============================================================================
// ZYRIX CRM BACKEND — Entry Point
// ============================================================================
// Initial minimal Express server.
// Full routes, middleware, and auth will be added in subsequent files.
// ============================================================================

const app: Express = express();

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [FRONTEND_URL];

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

if (NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// ─────────────────────────────────────────────────────────────────────────
// Health Check Endpoints
// ─────────────────────────────────────────────────────────────────────────
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "Zyrix CRM API",
    version: "0.1.0",
    status: "operational",
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
    documentation: "https://crm.zyrix.co/api-docs",
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api", (_req: Request, res: Response) => {
  res.json({
    message: "Zyrix CRM API v0.1.0",
    endpoints: {
      health: "/health",
      auth: "/api/auth (coming soon)",
      customers: "/api/customers (coming soon)",
      deals: "/api/deals (coming soon)",
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested resource does not exist",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────────────────────────────────
app.use(
  (
    err: Error,
    _req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    console.error("[ERROR]", err);
    res.status(500).json({
      error: "Internal Server Error",
      message:
        NODE_ENV === "development"
          ? err.message
          : "An unexpected error occurred",
      timestamp: new Date().toISOString(),
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Server Startup
// ─────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║                                                  ║");
  console.log("║          🚀 Zyrix CRM Backend v0.1.0             ║");
  console.log("║                                                  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Environment:  ${NODE_ENV}`);
  console.log(`  Port:         ${PORT}`);
  console.log(`  URL:          http://localhost:${PORT}`);
  console.log(`  Frontend:     ${FRONTEND_URL}`);
  console.log(`  CORS:         ${corsOrigins.join(", ")}`);
  console.log("");
  console.log("  Available endpoints:");
  console.log(`    GET  http://localhost:${PORT}/`);
  console.log(`    GET  http://localhost:${PORT}/health`);
  console.log(`    GET  http://localhost:${PORT}/api`);
  console.log("");
});

// ─────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────
const shutdown = (signal: string) => {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });

  // Force exit if shutdown takes too long
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;