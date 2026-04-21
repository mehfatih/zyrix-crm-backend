import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import * as ctrl from "../controllers/comments.controller";
import { prisma } from "../config/database";
import type { AuthenticatedRequest } from "../types";

const router = Router();
router.use(authenticateToken);

router.get("/", ctrl.list);
router.post("/", ctrl.create);

// Mentionable users for the @picker — returns company users matching
// the prefix in ?q=. Limited to 10 results so the picker stays fast.
router.get("/mentionable", async (req, res, next) => {
  try {
    const { companyId } = (req as AuthenticatedRequest).user as any;
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    const where: any = {
      companyId,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const users = await prisma.user.findMany({
      where,
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: "asc" },
      take: 10,
    });
    res.status(200).json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", ctrl.detail);
router.patch("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);

export default router;
