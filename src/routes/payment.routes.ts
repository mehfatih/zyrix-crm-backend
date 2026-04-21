import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as PaymentCtrl from "../controllers/payment.controller";

// ============================================================================
// PAYMENT ROUTES — /api/payments/*
// Public (no auth) because hosted checkout is reached before sign-in is
// complete, and webhooks come from external gateways.
// ============================================================================

const router = Router();

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many checkout attempts. Please try again shortly.",
    },
  },
});

router.post(
  "/checkout/create-session",
  checkoutLimiter,
  PaymentCtrl.createCheckout
);

// Stub confirmation — used only in dev/QA when gateway credentials are absent
router.post("/checkout/confirm-stub", PaymentCtrl.confirmStub);

// Webhooks — POST from gateway, GET responds 200 for URL verification pings
// (some gateways probe the endpoint with GET before accepting the registration).
router.get("/webhooks/iyzico", (_req, res) => {
  res.status(200).json({ success: true, message: "Iyzico webhook endpoint ready" });
});
router.post("/webhooks/iyzico", PaymentCtrl.iyzicoWebhook);

router.get("/webhooks/hyperpay", (_req, res) => {
  res.status(200).json({ success: true, message: "HyperPay webhook endpoint ready" });
});
router.post("/webhooks/hyperpay", PaymentCtrl.hyperpayWebhook);

export default router;
