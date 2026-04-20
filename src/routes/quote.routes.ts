import { Router } from "express";
import * as controller from "../controllers/quote.controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();

router.use(authenticateToken);

router.get("/stats", controller.stats);
router.get("/", controller.list);
router.post("/", controller.create);
router.get("/:id", controller.getOne);
router.patch("/:id", controller.update);
router.post("/:id/send", controller.send);
router.post("/:id/accept", controller.accept);
router.post("/:id/reject", controller.reject);
router.delete("/:id", controller.remove);

export default router;
