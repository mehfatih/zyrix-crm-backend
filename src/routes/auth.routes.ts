import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as authController from "../controllers/auth.controller";
import { authenticateToken } from "../middleware/auth";
import { env } from "../config/env";

// ============================================================================
// AUTH ROUTES
// ============================================================================

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Rate limiters (stricter for auth endpoints)
// ─────────────────────────────────────────────────────────────────────────
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // max 5 signups per hour per IP
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many signup attempts. Please try again later.",
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10, // max 10 signin attempts per 15min per IP
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many login attempts. Please try again later.",
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
});

// ─────────────────────────────────────────────────────────────────────────
// Public routes
// ─────────────────────────────────────────────────────────────────────────
router.post("/signup", signupLimiter, authController.signup);
router.post("/signin", signinLimiter, authController.signin);
router.post("/refresh", generalLimiter, authController.refresh);
router.post("/logout", generalLimiter, authController.logout);

// ─────────────────────────────────────────────────────────────────────────
// Protected routes
// ─────────────────────────────────────────────────────────────────────────
router.get("/me", authenticateToken, authController.me);

export default router;