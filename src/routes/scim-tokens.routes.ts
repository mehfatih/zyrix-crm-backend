import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/scim-tokens.controller";

const router = Router();
router.use(authenticateToken);
router.use(requirePermission("settings:integrations"));

router.get("/", ctrl.list);
router.post("/", ctrl.issue);
router.delete("/:id", ctrl.revoke);

export default router;
