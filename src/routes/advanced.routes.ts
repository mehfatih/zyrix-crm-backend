import { Router } from "express";
import * as controller from "../controllers/advanced.controller";
import { authenticateToken } from "../middleware/auth";
import { requireFeature, enforceLimit } from "../middleware/entitlement-gate";
import { countStores } from "../middleware/entitlement-counters";

const router = Router();
// Sprint 16B: store-connect is gated by the `ecommerce_sync` feature + the
// `limit_ecommerce_stores` count (both flag-gated). Applied per-route below so
// the rest of /api/advanced is unaffected.
const gateStoreConnect = [
  requireFeature("ecommerce_sync"),
  enforceLimit("limit_ecommerce_stores", countStores),
];

// ──────────────────────────────────────────────────────────────────────
// PUBLIC — no auth required (for marketing page)
// ──────────────────────────────────────────────────────────────────────
router.get("/ecommerce/catalog", controller.ecommerceListCatalog);

// All routes below require authentication
router.use(authenticateToken);

// ──────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
// ──────────────────────────────────────────────────────────────────────
router.get("/templates", controller.listTemplates);
router.post("/templates", controller.createTemplate);
router.get("/templates/:id", controller.getTemplate);
router.put("/templates/:id", controller.updateTemplate);
router.delete("/templates/:id", controller.deleteTemplate);
router.post("/templates/:id/use", controller.markTemplateUsed);

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
router.post("/shopify/connect", ...gateStoreConnect, controller.shopifyConnect);
router.delete("/shopify/stores/:id", controller.shopifyDisconnect);
router.post("/shopify/stores/:id/sync", controller.shopifySync);

// ──────────────────────────────────────────────────────────────────────
// E-COMMERCE GENERAL (multi-platform: Shopify, Salla, Zid, YouCan, Ticimax, etc.)
// ──────────────────────────────────────────────────────────────────────
router.get("/ecommerce/stores", controller.ecommerceListStores);
router.post("/ecommerce/connect", ...gateStoreConnect, controller.ecommerceConnect);
router.delete("/ecommerce/stores/:id", controller.ecommerceDisconnect);
router.post("/ecommerce/stores/:id/sync", controller.ecommerceSync);
router.get("/ecommerce/stores/:id/status", controller.ecommerceSyncStatus);

// ──────────────────────────────────────────────────────────────────────
// ADVANCED SEARCH & FILTERS
// ──────────────────────────────────────────────────────────────────────
router.get("/search", controller.globalSearch);
router.post("/filter", controller.advancedFilter);
router.get("/filter/fields", controller.getAllowedFields);

export default router;
