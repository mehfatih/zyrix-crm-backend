import crypto from "crypto";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { hashPassword } from "../utils/password";
import { recordAudit } from "../utils/audit";
import { sendEmail } from "./email.service";
import { badRequest, forbidden } from "../middleware/errorHandler";
import { AppError } from "../middleware/errorHandler";

// ============================================================================
// ADMIN PASSWORD RESET SERVICE
// ----------------------------------------------------------------------------
// Two-step flow for super_admin users. Raw tokens are never persisted —
// we store SHA-256 digests and compare at redeem time. Non-enumerable
// on request (silent-success when email is unknown) but rate-limited
// per-user when known.
// ============================================================================

const TOKEN_BYTES = 32; // 32 random bytes → 64 hex chars
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_OPEN_TOKENS_PER_HOUR = 3;

type SupportedLocale = "en" | "ar" | "tr";

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function pickLocale(value: string | null | undefined): SupportedLocale {
  if (value === "ar" || value === "tr") return value;
  return "en";
}

function buildEmail(locale: SupportedLocale, fullName: string, link: string): {
  subject: string;
  html: string;
  text: string;
} {
  const copy = {
    en: {
      subject: "Reset your Zyrix CRM admin password",
      greeting: `Hi ${fullName},`,
      lead: "We received a request to reset your Zyrix admin password.",
      cta: "Reset password",
      fallback: "Or copy this link into your browser:",
      expiry: "This link expires in 1 hour. If you didn't request this, you can safely ignore this email.",
      support: "Need help? Contact support@zyrix.co",
      dir: "ltr" as const,
    },
    ar: {
      subject: "إعادة تعيين كلمة مرور مدير Zyrix CRM",
      greeting: `مرحبا ${fullName}،`,
      lead: "تلقينا طلبا لإعادة تعيين كلمة مرور حساب المدير الخاص بك في Zyrix.",
      cta: "إعادة تعيين كلمة المرور",
      fallback: "أو انسخ هذا الرابط إلى متصفحك:",
      expiry: "ينتهي صلاحية هذا الرابط خلال ساعة واحدة. إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.",
      support: "هل تحتاج إلى مساعدة؟ راسلنا على support@zyrix.co",
      dir: "rtl" as const,
    },
    tr: {
      subject: "Zyrix CRM yönetici şifrenizi sıfırlayın",
      greeting: `Merhaba ${fullName},`,
      lead: "Zyrix yönetici şifrenizi sıfırlama isteğinizi aldık.",
      cta: "Şifreyi sıfırla",
      fallback: "Veya bu bağlantıyı tarayıcınıza kopyalayın:",
      expiry: "Bu bağlantının süresi 1 saat içinde dolar. Bu isteği siz yapmadıysanız bu e-postayı güvenle yok sayabilirsiniz.",
      support: "Yardıma mı ihtiyacınız var? support@zyrix.co",
      dir: "ltr" as const,
    },
  }[locale];

  const fontFamily = locale === "ar"
    ? `"Tajawal", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    : `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

  const html = `<!DOCTYPE html>
<html dir="${copy.dir}" lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.subject}</title>
</head>
<body style="margin:0;padding:20px;background:#F0F9FF;font-family:${fontFamily};">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(8,145,178,0.08);">
    <div style="background:linear-gradient(135deg,#0891B2,#06B6D4);color:#ffffff;padding:40px;text-align:center;">
      <h1 style="margin:0;font-size:24px;letter-spacing:-0.01em;">Zyrix CRM</h1>
    </div>
    <div style="padding:40px;color:#164E63;">
      <h2 style="color:#0E7490;margin-top:0;font-size:20px;">${copy.greeting}</h2>
      <p style="font-size:15px;line-height:1.6;">${copy.lead}</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${link}" style="display:inline-block;background:#0891B2;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:600;">${copy.cta}</a>
      </div>
      <p style="font-size:13px;color:#475569;margin:0 0 6px;">${copy.fallback}</p>
      <p style="font-size:12px;color:#0E7490;word-break:break-all;background:#F0F9FF;padding:8px 10px;border-radius:6px;">${link}</p>
      <p style="font-size:13px;color:#64748B;margin-top:24px;">${copy.expiry}</p>
    </div>
    <div style="background:#F9FAFB;padding:20px;text-align:center;color:#6B7280;font-size:12px;">
      <p style="margin:0;">${copy.support}</p>
      <p style="margin:6px 0 0;">&copy; ${new Date().getFullYear()} Zyrix CRM</p>
    </div>
  </div>
</body>
</html>`;

  const text = `${copy.greeting}\n\n${copy.lead}\n\n${copy.cta}: ${link}\n\n${copy.expiry}\n\n${copy.support}`;

  return { subject: copy.subject, html, text };
}

export async function requestAdminPasswordReset(
  email: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<void> {
  const normalized = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: normalized },
  });

  // Email-enumeration prevention: never reveal whether the address exists.
  // Still audit-log the attempt.
  if (!user || user.role !== "super_admin" || user.status !== "active") {
    await recordAudit({
      action: "admin.password_reset_requested_unknown_email",
      metadata: { email: normalized },
      ipAddress,
      userAgent,
    });
    return;
  }

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - TOKEN_TTL_MS);

  const openTokens = await prisma.passwordResetToken.count({
    where: {
      userId: user.id,
      usedAt: null,
      createdAt: { gte: oneHourAgo },
      expiresAt: { gt: now },
    },
  });

  if (openTokens >= MAX_OPEN_TOKENS_PER_HOUR) {
    throw new AppError(
      "Too many reset requests. Please try again later.",
      429,
      "RATE_LIMITED"
    );
  }

  // Invalidate any pre-existing open tokens so only the latest link works.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: now },
  });

  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
      ipAddress,
      userAgent,
    },
  });

  const locale = pickLocale(user.preferredLocale);
  const baseUrl = env.APP_URL || env.FRONTEND_URL;
  const link = `${baseUrl.replace(/\/$/, "")}/${locale}/admin/reset-password?token=${rawToken}`;
  const { subject, html, text } = buildEmail(locale, user.fullName, link);

  await sendEmail({ to: user.email, subject, html, text });

  await recordAudit({
    userId: user.id,
    companyId: user.companyId,
    action: "admin.password_reset_requested",
    entityType: "user",
    entityId: user.id,
    ipAddress,
    userAgent,
  });
}

export async function confirmAdminPasswordReset(
  rawToken: string,
  newPassword: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<void> {
  if (!/^[a-f0-9]+$/i.test(rawToken) || rawToken.length < 32) {
    throw badRequest("Invalid or expired reset link.");
  }

  const tokenHash = hashToken(rawToken);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!record) throw badRequest("Invalid or expired reset link.");
  if (record.usedAt) throw badRequest("This reset link has already been used.");
  if (record.expiresAt < new Date()) {
    throw badRequest("This reset link has expired. Please request a new one.");
  }

  const user = record.user;
  if (user.role !== "super_admin" || user.status !== "active") {
    throw forbidden("Account not eligible for password reset.");
  }

  if (newPassword.length < 12) {
    throw badRequest("Password must be at least 12 characters long.");
  }
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw badRequest("Password must contain at least one letter and one digit.");
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  await recordAudit({
    userId: user.id,
    companyId: user.companyId,
    action: "admin.password_reset_confirmed",
    entityType: "user",
    entityId: user.id,
    ipAddress,
    userAgent,
  });
}
