import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/documents.controller";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.post("/link", ctrl.link);
router.delete("/:id", ctrl.remove);

export default router;
