import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_URL: z.string().url().default("http://localhost:4000"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z.coerce.boolean().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().optional(), // frontend base URL for building claim/reset links

  GEMINI_API_KEY: z.string().optional(),

  // E-commerce OAuth providers. All optional — the corresponding
  // install/callback routes short-circuit with a 501 if the env vars
  // for that provider aren't set, so one provider can be live while
  // the other is still pending partner-portal review.
  SALLA_CLIENT_ID: z.string().optional(),
  SALLA_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),

  // Admin Panel Bootstrap
  ADMIN_BOOTSTRAP_TOKEN: z.string().optional(),
  SUPER_ADMIN_EMAILS: z.string().optional(),
  SUPER_ADMIN_PASSWORD: z.string().optional(),

  // Payment Gateways
  IYZICO_API_KEY: z.string().optional(),
  IYZICO_SECRET_KEY: z.string().optional(),
  IYZICO_BASE_URL: z.string().default("https://sandbox-api.iyzipay.com"),
  HYPERPAY_ACCESS_TOKEN: z.string().optional(),
  HYPERPAY_ENTITY_ID: z.string().optional(),
  HYPERPAY_BASE_URL: z.string().default("https://test.oppwa.com"),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

export type EnvSchema = z.infer<typeof envSchema>;

let env: EnvSchema;

try {
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("❌ Invalid environment variables:");
    error.errors.forEach((err) => {
      console.error(`  - ${err.path.join(".")}: ${err.message}`);
    });
  } else {
    console.error("❌ Unknown error parsing env:", error);
  }
  process.exit(1);
}

export { env };

export const isDevelopment = env.NODE_ENV === "development";
export const isProduction = env.NODE_ENV === "production";
export const isStaging = env.NODE_ENV === "staging";
export const corsOrigins = env.CORS_ORIGINS.split(",").map((o) => o.trim());