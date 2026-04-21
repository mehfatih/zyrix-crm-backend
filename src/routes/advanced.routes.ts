import { Router } from "express";
import * as controller from "../controllers/advanced.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

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
router.post("/shopify/connect", controller.shopifyConnect);
router.delete("/shopify/stores/:id", controller.shopifyDisconnect);
router.post("/shopify/stores/:id/sync", controller.shopifySync);

// ──────────────────────────────────────────────────────────────────────
// E-COMMERCE GENERAL (multi-platform: Shopify, Salla, Zid, YouCan, Ticimax, etc.)
// ──────────────────────────────────────────────────────────────────────
router.get("/ecommerce/stores", controller.ecommerceListStores);
router.post("/ecommerce/connect", controller.ecommerceConnect);
router.delete("/ecommerce/stores/:id", controller.ecommerceDisconnect);
router.post("/ecommerce/stores/:id/sync", controller.ecommerceSync);

// ──────────────────────────────────────────────────────────────────────
// ADVANCED SEARCH & FILTERS
// ──────────────────────────────────────────────────────────────────────
router.get("/search", controller.globalSearch);
router.post("/filter", controller.advancedFilter);
router.get("/filter/fields", controller.getAllowedFields);

export default router;
