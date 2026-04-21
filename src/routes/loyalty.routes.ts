import { Router } from "express";
import * as controller from "../controllers/loyalty.controller";
import { authenticateToken } from "../middleware/auth";
import { gateFeature } from "../middleware/feature-gate";

const router = Router();

router.use(authenticateToken);
router.use(gateFeature("loyalty"));

// Program config
router.get("/program", controller.getProgram);
router.put("/program", controller.upsertProgram);

// Stats
router.get("/stats", controller.stats);
router.get("/top-members", controller.topMembers);

// Customer view
router.get("/customer/:customerId", controller.getCustomerLoyalty);

// Transactions
router.get("/transactions", controller.listTransactions);
router.post("/transactions", controller.createTransaction);
router.delete("/transactions/:id", controller.deleteTransaction);

export default router;
