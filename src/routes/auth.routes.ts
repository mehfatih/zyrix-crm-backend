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
// Rate limiters
// ─────────────────────────────────────────────────────────────────────────
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
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
  windowMs: 15 * 60 * 1000,
  max: 10,
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

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many password reset attempts. Please try again later.",
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
router.post("/google", signinLimiter, authController.googleAuth);
router.post("/refresh", generalLimiter, authController.refresh);
router.post("/logout", generalLimiter, authController.logout);

// Email verification
router.post("/verify-email", generalLimiter, authController.verifyEmail);
router.post(
  "/resend-verification",
  passwordResetLimiter,
  authController.resendVerification
);

// Password reset
router.post(
  "/request-password-reset",
  passwordResetLimiter,
  authController.requestPasswordReset
);
router.post("/reset-password", generalLimiter, authController.resetPassword);

// ─────────────────────────────────────────────────────────────────────────
// Protected routes
// ─────────────────────────────────────────────────────────────────────────
router.get("/me", authenticateToken, authController.me);

export default router;
