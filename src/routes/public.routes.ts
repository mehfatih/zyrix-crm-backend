import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { getPublicPlans } from "../services/public-plans.service";
import { getActivePublicAnnouncements } from "../services/admin-announcements.service";
import { sendEmail } from "../services/email.service";
import { getQuoteByPublicToken, acceptQuote, rejectQuote } from "../services/quote.service";
import { prisma } from "../config/database";
import { env } from "../config/env";

// ============================================================================
// PUBLIC ROUTES — /api/public/*
// No auth required — for pricing page & marketing site
// ============================================================================

const router = Router();

router.get("/plans", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await getPublicPlans();
    res.status(200).json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/announcements",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = (req.query.plan as string) || undefined;
      const companyId = (req.query.companyId as string) || undefined;
      const data = await getActivePublicAnnouncements({ plan, companyId });
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Contact form
// ─────────────────────────────────────────────────────────────────────────
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many contact submissions. Please try again later.",
    },
  },
});

const contactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  topic: z
    .enum(["sales", "support", "partnership", "press", "other"])
    .default("sales"),
  message: z.string().min(5).max(5000),
});

router.post(
  "/contact",
  contactLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = contactSchema.parse(req.body);
      const to = "hello@zyrix.co";
      const subjectPrefix = `[${dto.topic.toUpperCase()}]`;
      const subject = `${subjectPrefix} ${dto.name} — ${dto.company || "—"}`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0F172A;">
          <h2 style="color: #0891B2; margin: 0 0 12px;">New contact form submission</h2>
          <p style="margin: 0 0 16px; color: #64748B; font-size: 13px;">
            Received at ${new Date().toISOString()}
          </p>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr><td style="padding: 6px 0; color: #64748B; width: 110px;">Name</td><td style="font-weight: 600;">${escapeHtml(dto.name)}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748B;">Email</td><td><a href="mailto:${escapeHtml(dto.email)}" style="color: #0891B2;">${escapeHtml(dto.email)}</a></td></tr>
            <tr><td style="padding: 6px 0; color: #64748B;">Company</td><td>${escapeHtml(dto.company || "—")}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748B;">Phone</td><td>${escapeHtml(dto.phone || "—")}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748B;">Topic</td><td>${escapeHtml(dto.topic)}</td></tr>
          </table>
          <div style="margin-top: 20px; padding: 16px; background: #F0F9FF; border: 1px solid #BAE6FD; border-radius: 8px;">
            <div style="font-size: 11px; color: #64748B; text-transform: uppercase; font-weight: 700; margin-bottom: 6px;">Message</div>
            <div style="white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${escapeHtml(dto.message)}</div>
          </div>
        </div>
      `;

      // Send to internal inbox (best-effort)
      await sendEmail({
        to,
        subject,
        html,
        text: `From: ${dto.name} <${dto.email}>\nCompany: ${dto.company || "—"}\nPhone: ${dto.phone || "—"}\nTopic: ${dto.topic}\n\n${dto.message}`,
      });

      // Auto-reply to sender (best-effort)
      if (env.RESEND_API_KEY) {
        await sendEmail({
          to: dto.email,
          subject: "We received your message — Zyrix CRM",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0F172A;">
              <h2 style="color: #0891B2;">Thanks, ${escapeHtml(dto.name)}!</h2>
              <p>We received your message and will get back to you within 1 business day.</p>
              <p style="font-size: 13px; color: #64748B;">
                If your request is urgent, you can also reach us on WhatsApp.
              </p>
              <p style="margin-top: 24px; font-size: 13px; color: #64748B;">
                — The Zyrix team, Istanbul
              </p>
            </div>
          `,
        });
      }

      res.status(200).json({ success: true, data: { received: true } });
    } catch (err) {
      next(err);
    }
  }
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─────────────────────────────────────────────────────────────────────────
// Public quote view (customer-facing)
// ─────────────────────────────────────────────────────────────────────────
router.get(
  "/quotes/:token",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getQuoteByPublicToken(req.params.token as string);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/quotes/:token/accept",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = await prisma.quote.findUnique({
        where: { publicToken: req.params.token as string },
        select: { id: true, companyId: true, status: true },
      });
      if (!q) {
        res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Quote not found" },
        });
        return;
      }
      if (q.status === "accepted" || q.status === "rejected") {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_STATUS", message: "Quote already resolved" },
        });
        return;
      }
      const data = await acceptQuote(q.companyId, q.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/quotes/:token/reject",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = await prisma.quote.findUnique({
        where: { publicToken: req.params.token as string },
        select: { id: true, companyId: true, status: true },
      });
      if (!q) {
        res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Quote not found" },
        });
        return;
      }
      if (q.status === "accepted" || q.status === "rejected") {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_STATUS", message: "Quote already resolved" },
        });
        return;
      }
      const data = await rejectQuote(q.companyId, q.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
