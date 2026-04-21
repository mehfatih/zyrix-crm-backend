import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/api-keys.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.delete("/:id", ctrl.revoke);

export default router;
