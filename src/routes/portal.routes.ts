import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import * as PortalSvc from "../services/portal.service";

const router = Router();

// ============================================================================
// CUSTOMER PORTAL ROUTES — /api/portal/*
// Public (no JWT auth) — uses magic-link + session tokens
// ============================================================================

const magicLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const requestSchema = z.object({
  email: z.string().email(),
  portalUrl: z.string().url().optional(),
});

const verifySchema = z.object({
  token: z.string().min(10),
});

// Middleware: resolve session token from Authorization header
async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: { code: "UNAUTHENTICATED", message: "Session required" },
      });
      return;
    }
    const sessionToken = auth.slice(7);
    const customer = await PortalSvc.resolveSession(sessionToken);
    (req as any).portalCustomer = customer;
    (req as any).portalSessionToken = sessionToken;
    next();
  } catch (e) {
    next(e);
  }
}

// POST /api/portal/magic-link — request login link
router.post(
  "/magic-link",
  magicLinkLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = requestSchema.parse(req.body);
      const portalBaseUrl =
        dto.portalUrl ||
        `${req.protocol}://${req.get("host")}/portal/callback`;
      await PortalSvc.issueMagicLink(dto.email, portalBaseUrl);
      // Always return success to avoid email enumeration
      res.status(200).json({ success: true, data: { sent: true } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/verify — exchange magic token for session
router.post(
  "/verify",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = verifySchema.parse(req.body);
      const ip = (req.ip || req.socket.remoteAddress || "").slice(0, 64);
      const ua = (req.get("user-agent") || "").slice(0, 512);
      const result = await PortalSvc.verifyMagicToken(dto.token, ip, ua);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/portal/me — customer info
router.get(
  "/me",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer;
      res.status(200).json({ success: true, data: customer });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/portal/dashboard — customer's records
router.get(
  "/dashboard",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = (req as any).portalCustomer;
      const data = await PortalSvc.getCustomerDashboard(customer.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/portal/logout
router.post(
  "/logout",
  requireSession,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = (req as any).portalSessionToken as string;
      await PortalSvc.logout(token);
      res.status(200).json({ success: true, data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
