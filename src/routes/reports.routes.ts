import { Router } from "express";
import * as controller from "../controllers/reports.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

// Exchange rates
router.get("/rates", controller.listRates);
router.post("/rates", controller.upsertRate);
router.delete("/rates/:id", controller.deleteRate);

// Reports
router.get("/revenue", controller.revenue);
router.get("/pipeline", controller.pipeline);
router.get("/summary", controller.summary);
router.get("/ecommerce", controller.ecommerce);
router.get("/ecommerce/export", controller.ecommerceExport);

export default router;
