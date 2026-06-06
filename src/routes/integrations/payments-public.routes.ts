import { Router } from "express";
import * as controller from "../../controllers/payments-collect.controller";

// ============================================================================
// PUBLIC PAYMENT CALLBACKS — /api/public/pay/* (Sprint 15E). No auth (the
// customer's browser / gateway hits these).
// ============================================================================
const router = Router();

// iyzico CheckoutForm callback (POST, form-encoded token).
router.post("/iyzico/:requestId/callback", controller.iyzicoCallback);
// HyperPay Copy&Pay widget page + shopper result.
router.get("/hyperpay/:requestId", controller.hyperpayPage);
router.get("/hyperpay/:requestId/result", controller.hyperpayResult);

export default router;
