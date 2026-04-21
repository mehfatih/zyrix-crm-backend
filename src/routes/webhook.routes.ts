import { Router, raw } from "express";
import * as controller from "../controllers/webhook.controller";
import { authenticateToken } from "../middleware/auth";

// ============================================================================
// TWO ROUTERS
// ----------------------------------------------------------------------------
// `receiverRouter`  — public, raw-body, mounted BEFORE express.json() in
//                     index.ts. Signature verification needs the exact bytes.
// `adminRouter`     — standard auth + JSON. Mounted after express.json().
// ============================================================================

// ─── PUBLIC RECEIVER ──────────────────────────────────────────────────
export const webhookReceiverRouter = Router();

// raw() gives us req.body as a Buffer. Limit is generous (2MB) because some
// Shopify "orders/updated" deliveries carry large line-item lists.
webhookReceiverRouter.post(
  "/:platform/:companyId",
  raw({ type: "*/*", limit: "2mb" }),
  controller.receive
);

// ─── AUTHENTICATED ADMIN ──────────────────────────────────────────────
const admin = Router();
admin.use(authenticateToken);

admin.get("/platforms", controller.getSupportedPlatforms);

admin.get("/subscriptions", controller.listSubscriptions);
admin.post("/subscriptions", controller.createSubscription);
admin.patch("/subscriptions/:id", controller.updateSubscription);
admin.delete("/subscriptions/:id", controller.deleteSubscription);
admin.post("/subscriptions/:id/rotate-secret", controller.rotateSecret);

admin.get("/events", controller.listEvents);
admin.post("/events/:id/retry", controller.retryEvent);

export const webhookAdminRouter = admin;
