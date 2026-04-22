import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateScim } from "../middleware/scimAuth";
import * as ctrl from "../controllers/scim.controller";

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();
router.use(limiter);
router.use(authenticateScim());

// Discovery
router.get("/ServiceProviderConfig", ctrl.providerConfig);

// Users
router.get("/Users", ctrl.listUsers);
router.get("/Users/:id", ctrl.getUser);
router.post("/Users", ctrl.createUser);
router.put("/Users/:id", ctrl.replaceUser);
router.patch("/Users/:id", ctrl.patchUser);
router.delete("/Users/:id", ctrl.deleteUser);

// Groups — minimal empty list for IdPs that insist on probing
router.get("/Groups", ctrl.listGroups);

export default router;
