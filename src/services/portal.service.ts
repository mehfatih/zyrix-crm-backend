import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import { randomBytes } from "crypto";
import { sendEmail } from "./email.service";

// ============================================================================
// CUSTOMER PORTAL SERVICE
// ============================================================================

const LOGIN_TOKEN_TTL_MIN = 15;
const SESSION_TOKEN_TTL_DAYS = 30;

function genToken(): string {
  return randomBytes(32).toString("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// ISSUE MAGIC LINK (sends email with login URL)
// ─────────────────────────────────────────────────────────────────────────
export async function issueMagicLink(
  email: string,
  portalBaseUrl: string
): Promise<{ delivered: boolean; customerFound: boolean }> {
  const customer = await prisma.customer.findFirst({
    where: { email: email.toLowerCase().trim() },
    include: { company: { select: { id: true, name: true } } },
  });

  // Silent-success: don't reveal whether email exists
  if (!customer) {
    return { delivered: false, customerFound: false };
  }

  const token = genToken();
  const expiresAt = new Date(
    Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000
  );

  await prisma.portalToken.create({
    data: {
      customerId: customer.id,
      companyId: customer.companyId,
      token,
      purpose: "login",
      expiresAt,
    },
  });

  const magicUrl = `${portalBaseUrl.replace(/\/$/, "")}?token=${token}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0F172A; padding: 24px;">
      <h2 style="color: #0891B2; margin: 0 0 12px;">Sign in to your portal</h2>
      <p style="font-size: 15px; color: #475569;">
        Hi ${escapeHtml(customer.fullName)},
      </p>
      <p style="font-size: 15px; color: #475569;">
        Click the button below to access your account with ${escapeHtml(customer.company.name)}.
        This link expires in ${LOGIN_TOKEN_TTL_MIN} minutes.
      </p>
      <div style="margin: 24px 0;">
        <a href="${magicUrl}" style="display: inline-block; background: #0891B2; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Access my portal
        </a>
      </div>
      <p style="font-size: 12px; color: #94A3B8;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;

  const delivered = await sendEmail({
    to: customer.email!,
    subject: `Your sign-in link — ${customer.company.name}`,
    html,
    text: `Sign in to your portal: ${magicUrl}\nThis link expires in ${LOGIN_TOKEN_TTL_MIN} minutes.`,
  });

  return { delivered, customerFound: true };
}

// ─────────────────────────────────────────────────────────────────────────
// VERIFY MAGIC TOKEN → returns session token
// ─────────────────────────────────────────────────────────────────────────
export async function verifyMagicToken(
  token: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ sessionToken: string; customer: any }> {
  const record = await prisma.portalToken.findUnique({
    where: { token },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          companyName: true,
          companyId: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!record) {
    const err: any = new Error("Invalid token");
    err.statusCode = 401;
    throw err;
  }
  if (record.purpose !== "login") {
    const err: any = new Error("Invalid token type");
    err.statusCode = 401;
    throw err;
  }
  if (record.usedAt) {
    const err: any = new Error("Token already used");
    err.statusCode = 401;
    throw err;
  }
  if (record.expiresAt < new Date()) {
    const err: any = new Error("Token expired");
    err.statusCode = 401;
    throw err;
  }

  // Mark login token used
  await prisma.portalToken.update({
    where: { id: record.id },
    data: { usedAt: new Date(), ipAddress, userAgent },
  });

  // Issue a session token (longer-lived)
  const sessionToken = genToken();
  const sessionExpires = new Date(
    Date.now() + SESSION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );
  await prisma.portalToken.create({
    data: {
      customerId: record.customerId,
      companyId: record.companyId,
      token: sessionToken,
      purpose: "session",
      expiresAt: sessionExpires,
      ipAddress,
      userAgent,
    },
  });

  return { sessionToken, customer: record.customer };
}

// ─────────────────────────────────────────────────────────────────────────
// RESOLVE SESSION TOKEN → customer
// ─────────────────────────────────────────────────────────────────────────
export async function resolveSession(token: string) {
  const record = await prisma.portalToken.findUnique({
    where: { token },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          companyName: true,
          companyId: true,
          phone: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!record || record.purpose !== "session") {
    const err: any = new Error("Invalid session");
    err.statusCode = 401;
    throw err;
  }
  if (record.expiresAt < new Date()) {
    const err: any = new Error("Session expired");
    err.statusCode = 401;
    throw err;
  }
  return record.customer;
}

export async function logout(token: string) {
  try {
    await prisma.portalToken.delete({ where: { token } });
  } catch {
    /* no-op */
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// DATA ACCESS — customer's own records
// ─────────────────────────────────────────────────────────────────────────
export async function getCustomerDashboard(customerId: string) {
  const [customer, quotes, contracts, loyalty] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        companyName: true,
        lifetimeValue: true,
        company: { select: { id: true, name: true } },
      },
    }),
    prisma.quote.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        quoteNumber: true,
        title: true,
        status: true,
        total: true,
        currency: true,
        validUntil: true,
        issuedAt: true,
        publicToken: true,
      },
    }),
    prisma.contract.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        contractNumber: true,
        title: true,
        status: true,
        value: true,
        currency: true,
        startDate: true,
        endDate: true,
        fileUrl: true,
      },
    }),
    prisma.loyaltyTransaction.aggregate({
      where: { customerId },
      _sum: { points: true },
    }),
  ]);

  if (!customer) throw notFound("Customer");

  return {
    customer,
    quotes,
    contracts,
    loyaltyBalance: loyalty._sum.points ?? 0,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
