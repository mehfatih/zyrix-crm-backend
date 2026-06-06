import { Router } from "express";
import * as controller from "../controllers/product.controller";
import { authenticateToken } from "../middleware/auth";
import { enforceLimit } from "../middleware/entitlement-gate";
import { countProducts } from "../middleware/entitlement-counters";

const router = Router();

router.use(authenticateToken);

router.get("/", controller.list);
router.post("/", enforceLimit("limit_products", countProducts), controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.patch("/:id/status", controller.setStatus);
router.delete("/:id", controller.remove);

// Stock
router.get("/:id/movements", controller.listMovements);
router.post("/:id/movements", controller.createMovement);
router.patch("/:id/stock", controller.setThreshold);

export default router;
