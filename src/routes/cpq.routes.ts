import { Router } from "express";
import * as controller from "../controllers/cpq.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

// ============================================================================
// CPQ CATALOG ROUTES — /api/cpq/* (Sprint 9)
// Price books (+ entries), discount rules, bundles. Gated by the quotes
// feature flag (same feature surface as the quote builder).
// ============================================================================

const router = Router();

router.use(authenticateToken);
router.use(gateFeature("quotes"));

// Builder resolvers
router.get("/resolve-price-book", controller.resolvePriceBook);
router.get("/my-discount-rule", controller.myDiscountRule);

// Price books
router.get("/price-books", controller.listPriceBooks);
router.post("/price-books", controller.createPriceBook);
router.get("/price-books/:id", controller.getPriceBook);
router.patch("/price-books/:id", controller.updatePriceBook);
router.delete("/price-books/:id", controller.deletePriceBook);
router.post("/price-books/:id/entries", controller.setEntry);
router.delete("/price-books/:id/entries/:productId", controller.deleteEntry);

// Discount rules
router.get("/discount-rules", controller.listDiscountRules);
router.post("/discount-rules", controller.createDiscountRule);
router.patch("/discount-rules/:id", controller.updateDiscountRule);
router.delete("/discount-rules/:id", controller.deleteDiscountRule);

// Bundles
router.get("/bundles", controller.listBundles);
router.post("/bundles", controller.createBundle);
router.get("/bundles/:id", controller.getBundle);
router.patch("/bundles/:id", controller.updateBundle);
router.delete("/bundles/:id", controller.deleteBundle);

export default router;
