import { Router } from "express";
import * as controller from "../controllers/deal.controller";
import * as items from "../controllers/deal-items.controller";
import { authenticateToken } from "../middleware/auth";

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

export default router;