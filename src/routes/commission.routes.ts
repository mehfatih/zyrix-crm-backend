import { Router } from "express";
import * as controller from "../controllers/commission.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

// Rules
router.get("/rules", controller.listRules);
router.post("/rules", controller.createRule);
router.patch("/rules/:id", controller.updateRule);
router.delete("/rules/:id", controller.deleteRule);

// Entries
router.get("/entries", controller.listEntries);
router.patch("/entries/:id/status", controller.updateEntryStatus);
router.delete("/entries/:id", controller.deleteEntry);

// Recompute + stats
router.post("/recompute", controller.recompute);
router.get("/stats", controller.stats);

export default router;
