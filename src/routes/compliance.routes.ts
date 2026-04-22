import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateCompliance } from "../middleware/complianceAuth";
import * as ctrl from "../controllers/compliance.controller";

// Aggressive rate limit: compliance exports are expensive + infrequent.
// 10 requests per 15 min per IP is plenty for an auditor; automated
// leakage stops dead quickly.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many compliance requests. Wait 15 min and try again.",
    },
  },
});

const router = Router();
router.use(limiter);
router.use(authenticateCompliance());

// Tokens — only usable via JWT (admin:compliance). A token can manage
// other tokens, which is a footgun we avoid by checking role here.
router.get("/tokens", (req, res, next) => {
  if ((req as any).user?.role === "compliance_token") {
    return res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message:
          "Compliance tokens cannot manage other compliance tokens. Use the dashboard.",
      },
    });
  }
  ctrl.listTokens(req, res, next);
});
router.post("/tokens", (req, res, next) => {
  if ((req as any).user?.role === "compliance_token") {
    return res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Compliance tokens cannot issue other compliance tokens.",
      },
    });
  }
  ctrl.issueToken(req, res, next);
});
router.delete("/tokens/:id", (req, res, next) => {
  if ((req as any).user?.role === "compliance_token") {
    return res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Compliance tokens cannot revoke other compliance tokens.",
      },
    });
  }
  ctrl.revokeToken(req, res, next);
});

// Data access — available to both auth methods.
router.get("/data-export/:userId", ctrl.exportUser);
router.post("/data-deletion/:userId", ctrl.deleteUser);
router.get("/audit-report", ctrl.report);

export default router;
