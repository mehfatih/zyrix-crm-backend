// ============================================================================
// BONUS CONTROLLER (B1-B10)
// ============================================================================

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import * as BonusSvc from "../services/bonus.service";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

// ──────────────────────────────────────────────────────────────────────
// B1 — detect duplicates
// ──────────────────────────────────────────────────────────────────────

const dupSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
});

export async function detectDuplicates(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = dupSchema.parse(req.body) as any;
    const data = await BonusSvc.detectDuplicateCustomer(companyId, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B2 — conversation classify
// ──────────────────────────────────────────────────────────────────────

const convSchema = z.object({ text: z.string().min(1).max(8000) });

export async function classifyConversation(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = convSchema.parse(req.body) as any;
    const data = await BonusSvc.classifyConversation(dto.text);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B3 — lead score recompute
// ──────────────────────────────────────────────────────────────────────

export async function recomputeLeadScores(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const processed = await BonusSvc.recomputeLeadScoresForCompany(companyId);
    res.status(200).json({ success: true, data: { processed } });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B4 — territories
// ──────────────────────────────────────────────────────────────────────

export async function listTerritories(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.listTerritories(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const territorySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  criteria: z.record(z.string(), z.any()),
  ownerId: z.string().nullable().optional(),
});

export async function upsertTerritory(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = territorySchema.parse(req.body) as any;
    const data = await BonusSvc.upsertTerritory(companyId, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function assignTerritories(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.assignTerritories(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B5 — quotas
// ──────────────────────────────────────────────────────────────────────

export async function listQuotas(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.listQuotas(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const quotaSchema = z.object({
  userId: z.string(),
  period: z.string(),
  target: z.coerce.number().min(0),
});

export async function upsertQuota(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const dto = quotaSchema.parse(req.body) as any;
    const data = await BonusSvc.upsertQuota(companyId, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function quotaAttainment(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const userId = req.query.userId as string;
    const period = req.query.period as string;
    const data = await BonusSvc.quotaAttainment(companyId, userId, period);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B6 — meetings
// ──────────────────────────────────────────────────────────────────────

const meetingSchema = z.object({
  title: z.string().min(1),
  transcript: z.string().min(1),
  customerId: z.string().optional(),
  dealId: z.string().optional(),
  meetingAt: z.string().optional(),
});

export async function ingestMeeting(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = meetingSchema.parse(req.body) as any;
    const data = await BonusSvc.ingestMeeting(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function listMeetings(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.listMeetings(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B7 — contract signatures
// ──────────────────────────────────────────────────────────────────────

const sigRequestSchema = z.object({
  contractId: z.string().uuid(),
  signerEmail: z.string().email(),
  signerName: z.string().optional(),
});

export async function requestSignature(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = sigRequestSchema.parse(req.body) as any;
    const data = await BonusSvc.requestContractSignature(companyId, userId, dto);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const sigCompleteSchema = z.object({
  token: z.string(),
  signatureDataUrl: z.string().min(10),
});

export async function completeSignature(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = sigCompleteSchema.parse(req.body) as any;
    const data = await BonusSvc.completeContractSignature(
      dto.token,
      dto.signatureDataUrl
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function listSignatures(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.listContractSignatures(
      companyId,
      req.params.contractId as string
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B8 — health score recompute
// ──────────────────────────────────────────────────────────────────────

export async function recomputeHealthScores(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const processed = await BonusSvc.refreshHealthScoresForCompany(companyId);
    res.status(200).json({ success: true, data: { processed } });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// B10 — Slack webhook
// ──────────────────────────────────────────────────────────────────────

export async function getSlack(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.getSlackWebhook(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const slackSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string()).default([]),
});

export async function upsertSlack(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId } = auth(req);
    const dto = slackSchema.parse(req.body) as any;
    const data = await BonusSvc.upsertSlackWebhook(companyId, userId, dto);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function removeSlack(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await BonusSvc.removeSlackWebhook(companyId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
