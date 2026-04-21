import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/tax-invoices.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.post("/", ctrl.issue);
router.get("/:id", ctrl.detail);
router.get("/:id/xml", ctrl.downloadXml);
router.post("/:id/submit", ctrl.submit);
router.post("/:id/approve", ctrl.approve);
router.post("/:id/reject", ctrl.reject);

export default router;
