import { PrismaClient } from "@prisma/client";
import { isDevelopment } from "./env";

// ============================================================================
// PRISMA CLIENT — Singleton Pattern
// ============================================================================
// Reuses the same Prisma instance across the app.
// In dev mode, preserves the instance across hot reloads.
// ============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ||
  new PrismaClient({
    log: isDevelopment
      ? ["query", "error", "warn"]
      : ["error"],
    errorFormat: "pretty",
  });

if (isDevelopment) {
  global.__prisma = prisma;
}

// Graceful shutdown
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});

export default prisma;