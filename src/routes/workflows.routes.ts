import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/workflows.controller";

const router = Router();
router.use(authenticateToken);

// Spec catalog for the visual builder (triggers, actions, condition operators)
router.get("/catalog", ctrl.catalog);

// Executions — more specific routes BEFORE the :id param route so
// /executions doesn't get interpreted as a workflow id.
router.get("/executions", ctrl.executions);
router.get("/executions/:id", ctrl.executionDetail);

// Workflow CRUD
router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.get("/:id", ctrl.detail);
router.patch("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);

// Test run
router.post("/:id/test", ctrl.testRun);

export default router;
