import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";
import * as ctrl from "../controllers/tax-invoices.controller";

const router = Router();
router.use(authenticateToken);
router.use(gateFeature("tax_invoices"));

router.get("/", ctrl.list);
router.post("/", ctrl.issue);
router.get("/:id", ctrl.detail);
router.get("/:id/xml", ctrl.downloadXml);
router.post("/:id/submit", ctrl.submit);
router.post("/:id/approve", ctrl.approve);
router.post("/:id/reject", ctrl.reject);

export default router;
