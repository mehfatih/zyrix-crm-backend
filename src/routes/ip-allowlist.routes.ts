import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import { gateFeature } from "../middleware/feature-gate";
import * as ctrl from "../controllers/ip-allowlist.controller";

// Mounted at /api/admin/ip-allowlist per handoff. `admin:*` is the
// closest permission match — we gate via settings:integrations since
// network rules are a merchant configuration surface.
const router = Router();
router.use(authenticateToken);
router.use(gateFeature("ip_allowlist"));
router.use(requirePermission("settings:integrations"));

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.delete("/:id", ctrl.remove);

export default router;
