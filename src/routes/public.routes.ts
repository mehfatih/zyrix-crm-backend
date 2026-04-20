import { Router, type Request, type Response, type NextFunction } from "express";
import { getPublicPlans } from "../services/public-plans.service";
import { getActivePublicAnnouncements } from "../services/admin-announcements.service";

// ============================================================================
// PUBLIC ROUTES — /api/public/*
// No auth required — for pricing page & marketing site
// ============================================================================

const router = Router();

router.get("/plans", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await getPublicPlans();
    res.status(200).json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/announcements",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = (req.query.plan as string) || undefined;
      const companyId = (req.query.companyId as string) || undefined;
      const data = await getActivePublicAnnouncements({ plan, companyId });
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
