import { Router } from "express";
import * as controller from "../controllers/advanced.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

// ──────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
// ──────────────────────────────────────────────────────────────────────
router.get("/templates", controller.listTemplates);
router.post("/templates", controller.createTemplate);
router.get("/templates/:id", controller.getTemplate);
router.put("/templates/:id", controller.updateTemplate);
router.delete("/templates/:id", controller.deleteTemplate);

// ──────────────────────────────────────────────────────────────────────
// CUSTOM FIELDS
// ──────────────────────────────────────────────────────────────────────
router.get("/custom-fields", controller.listFields);
router.post("/custom-fields", controller.createField);
router.put("/custom-fields/:id", controller.updateField);
router.delete("/custom-fields/:id", controller.deleteField);

// ──────────────────────────────────────────────────────────────────────
// BULK ACTIONS
// ──────────────────────────────────────────────────────────────────────
router.post("/bulk", controller.bulkAction);

// ──────────────────────────────────────────────────────────────────────
// IMPORT (CSV)
// ──────────────────────────────────────────────────────────────────────
router.post("/import/customers", controller.importCustomers);

// ──────────────────────────────────────────────────────────────────────
// EXPORT
// ──────────────────────────────────────────────────────────────────────
router.post("/export", controller.exportData);

// ──────────────────────────────────────────────────────────────────────
// TIMELINE
// ──────────────────────────────────────────────────────────────────────
router.get("/timeline/customer/:customerId", controller.getCustomerTimeline);

// ──────────────────────────────────────────────────────────────────────
// SHOPIFY INTEGRATION
// ──────────────────────────────────────────────────────────────────────
router.get("/shopify/stores", controller.shopifyListStores);
router.post("/shopify/connect", controller.shopifyConnect);
router.delete("/shopify/stores/:id", controller.shopifyDisconnect);
router.post("/shopify/stores/:id/sync", controller.shopifySync);

export default router;
