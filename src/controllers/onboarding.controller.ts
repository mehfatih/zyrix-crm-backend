import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as OnboardingSvc from "../services/onboarding.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { companyId: r.user.companyId, userId: r.user.userId };
}

export async function status(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const data = await OnboardingSvc.getOnboardingStatus(companyId, userId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const completeSchema = z.object({
  companyName: z.string().min(1).max(200).optional(),
  country: z.string().min(2).max(80).optional(),
  baseCurrency: z.string().min(2).max(8).optional(),
  preferredLocale: z.enum(["en", "ar", "tr"]).optional(),
});

export async function complete(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const body = completeSchema.parse(req.body ?? {});
    const data = await OnboardingSvc.completeOnboarding(companyId, userId, body);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["manager", "member"]),
  fullName: z.string().min(1).max(120).optional(),
});

export async function invite(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, userId } = auth(req);
    const body = inviteSchema.parse(
      req.body ?? {}
    ) as OnboardingSvc.InviteColleagueInput;
    const data = await OnboardingSvc.inviteColleague(companyId, userId, body);
    // Inviting someone marks the invitedTeam step so the wizard reflects
    // reality without a separate PATCH call.
    await OnboardingSvc.updateOnboardingProgress(companyId, {
      invitedTeam: true,
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const progressSchema = z.object({
  profile: z.boolean().optional(),
  country: z.boolean().optional(),
  firstCustomer: z.boolean().optional(),
  invitedTeam: z.boolean().optional(),
  firstDeal: z.boolean().optional(),
});

export async function patchProgress(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const body = progressSchema.parse(req.body ?? {});
    const data = await OnboardingSvc.updateOnboardingProgress(companyId, body);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
