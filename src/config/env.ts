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

  // Google SIGN-IN / login (existing — do NOT reuse for the integration).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // ── Google Workspace integration (Drive + Sheets, Sprint 5) ──────────
  // SEPARATE OAuth client from login above so login is never at risk. All
  // optional → the connect/callback routes short-circuit with a typed
  // GOOGLE_NOT_CONFIGURED error and /status returns available:false, so the
  // app boots fine and the web hides all Google UI until these are set.
  // Scope is fixed in code to the non-sensitive `drive.file` (+ openid email
  // profile) — never add a sensitive/restricted scope here.
  GOOGLE_INTEGRATION_CLIENT_ID: z.string().optional(),
  GOOGLE_INTEGRATION_CLIENT_SECRET: z.string().optional(),
  GOOGLE_INTEGRATION_REDIRECT_URI: z
    .string()
    .optional(), // e.g. https://api.crm.zyrix.co/api/integrations/google/callback

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z.coerce.boolean().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().optional(), // frontend base URL for building claim/reset links
  // Sprint 10: backend public base for email open-pixel / click-tracking URLs
  // (these run on the API host, not the frontend). Defaults to the prod API.
  EMAIL_TRACKING_BASE_URL: z.string().optional(),
  // Sprint 10: Resend webhook signing secret (Svix). Webhook verify is skipped
  // (503) until set — see docs at STOP-2.
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),

  // E-commerce OAuth providers. All optional — the corresponding
  // install/callback routes short-circuit with a 501 if the env vars
  // for that provider aren't set, so one provider can be live while
  // the other is still pending partner-portal review.
  SALLA_CLIENT_ID: z.string().optional(),
  SALLA_CLIENT_SECRET: z.string().optional(),
  // Legacy Shopify OAuth credentials (kept for the /api/oauth path). The new
  // /api/integrations/shopify module reads SHOPIFY_API_KEY ?? SHOPIFY_CLIENT_ID
  // so either naming works (see config/shopify.ts).
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),

  // ── Shopify OAuth (new integrations module) ──────────────────────────
  // All optional: the connect/callback routes short-circuit with a typed
  // SHOPIFY_NOT_CONFIGURED error when the key/secret are missing, so the
  // app boots fine before the human adds these on Railway.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  // Comma-separated scopes; MUST match the scopes declared in the Partner
  // Dashboard app config. Defaults to the read-only proposal from the sprint.
  SHOPIFY_SCOPES: z
    .string()
    .default("read_products,read_orders,read_customers,read_inventory,read_fulfillments"),
  SHOPIFY_APP_URL: z.string().optional(), // https://crm.zyrix.co
  SHOPIFY_REDIRECT_URI: z.string().optional(), // https://api.crm.zyrix.co/api/integrations/shopify/callback
  // Current stable Admin API version. Confirmed 2026-04 in recon (Jun 2026);
  // bump to 2026-07 on/after 2026-07-01.
  SHOPIFY_API_VERSION: z.string().default("2026-04"),
  // 32-byte base64 key for AES-256-GCM token encryption at rest. Generate:
  //   openssl rand -base64 32
  INTEGRATION_TOKEN_ENC_KEY: z.string().optional(),
  // Mobile return deep link scheme, e.g. "zyrix://". Defaults to the scheme
  // already configured in the Expo app.json.
  MOBILE_DEEP_LINK_SCHEME: z.string().default("zyrix://"),

  // ── WhatsApp Business Cloud API (new /api/integrations/whatsapp module) ──
  // All optional: the routes short-circuit with WHATSAPP_NOT_CONFIGURED when
  // the key vars are missing, so the app boots fine before they're added.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(), // verifies X-Hub-Signature-256
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(), // System User permanent token
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(), // GET handshake token
  // Current stable Graph API version. Confirmed v25.0 (Feb 2026) in recon;
  // bump when Meta releases the next version.
  WHATSAPP_GRAPH_API_VERSION: z.string().default("v25.0"),

  // ── Meta Lead Ads (new /api/integrations/meta/leads module, Sprint 2) ──
  // Reuses the SAME Meta app as WhatsApp (META_APP_ID/META_APP_SECRET above).
  // All optional: the leadgen webhook + fetch short-circuit gracefully at
  // request time when these are missing, so the app boots fine before they
  // are added on Railway. Neutral META_* names (not WHATSAPP_-prefixed).
  META_LEADS_PAGE_ACCESS_TOKEN: z.string().optional(), // long-lived Page token
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),    // leadgen GET handshake
  // Graph API version for the leads module. Confirmed v25.0 (Feb 2026) against
  // Meta's changelog in recon; same value as WhatsApp but a neutral var.
  META_GRAPH_API_VERSION: z.string().default("v25.0"),

  // ── Meta Messaging (Messenger + Instagram DM, Sprint 3) ──────────────
  // Same Meta app; reuses META_APP_SECRET (signature) + META_WEBHOOK_VERIFY_TOKEN
  // (handshake) + META_GRAPH_API_VERSION above. All optional → boots without
  // them; the messaging webhook/send fail gracefully at request time.
  META_PAGE_ACCESS_TOKEN: z.string().optional(), // Page token w/ messaging scopes
  META_PAGE_ID: z.string().optional(),           // {PAGE_ID}/messages send endpoint
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),   // linked IG professional account id

  // ── AI Support Widget (Sprint 4) ────────────────────────────────────
  // Reuses GEMINI_API_KEY (AI) + RESEND_API_KEY/EMAIL_FROM (mailer) above.
  // All optional → the widget degrades gracefully (no AI key → route to
  // human/email; no mailer → transcript/fallback emails no-op).
  SUPPORT_NOTIFY_EMAIL: z.string().optional(),      // escalations → Zyrix team
  SUPPORT_SLACK_WEBHOOK_URL: z.string().optional(), // optional Slack escalation ping
  SUPPORT_FALLBACK_MINUTES: z.coerce.number().default(15), // auto email-fallback window

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