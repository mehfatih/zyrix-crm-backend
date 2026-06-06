import { Router } from "express";
import * as controller from "../controllers/customer.controller";
import { authenticateToken } from "../middleware/auth";
import { enforceLimit } from "../middleware/entitlement-gate";
import { countContacts } from "../middleware/entitlement-counters";

const router = Router();

router.use(authenticateToken);

router.get("/stats", controller.stats);
router.get("/", controller.list);
router.post("/", enforceLimit("limit_contacts", countContacts), controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

export default router;