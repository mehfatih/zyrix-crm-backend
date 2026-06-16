import { Router } from "express";
import * as controller from "../controllers/deal.controller";
import * as items from "../controllers/deal-items.controller";
import * as economics from "../controllers/deal-economics.controller";
import * as attribution from "../controllers/deal-attribution.controller";
import { authenticateToken } from "../middleware/auth";
import { requireFeature } from "../middleware/entitlement-gate";

const router = Router();

router.use(authenticateToken);

router.get("/stats", controller.stats);
router.get("/pipeline", controller.pipeline);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

// Line items (Sprint 8)
router.get("/:id/items", items.list);
router.post("/:id/items", items.create);
router.patch("/:id/items/:itemId", items.update);
router.delete("/:id/items/:itemId", items.remove);
router.post("/:id/deduct-stock", items.deductStock);

// Deal Economics (Sprint 23) — per-deal profitability surface, gated by the
// `deal_economics` entitlement (BUSINESS_UP). The FX stamp + cost snapshots are
// captured on every close regardless; only these read/edit surfaces are gated.
const gateEconomics = requireFeature("deal_economics");
router.get("/:id/economics", gateEconomics, economics.getEconomics);
router.patch("/:id/economics/costs", gateEconomics, economics.updateCosts);
router.post("/:id/economics/recompute", gateEconomics, economics.recompute);

// Source Attribution (Sprint 25) — manual "where did this deal come from?" stamp,
// gated by the `source_attribution` entitlement (STARTER_UP). Auto-capture
// (Phases C/D/E) writes the same columns server-side, respecting manual precedence.
const gateAttribution = requireFeature("source_attribution");
router.get("/:id/attribution", gateAttribution, attribution.getAttribution);
router.put("/:id/attribution", gateAttribution, attribution.setAttribution);

export default router;