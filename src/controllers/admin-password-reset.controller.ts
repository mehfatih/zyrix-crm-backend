import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  requestAdminPasswordReset,
  confirmAdminPasswordReset,
} from "../services/admin-password-reset.service";
import { extractRequestMeta } from "../utils/audit";

const requestSchema = z.object({
  email: z.string().email(),
});

const confirmSchema = z.object({
  token: z.string().min(32),
  newPassword: z.string().min(12),
});

export async function requestReset(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = requestSchema.parse(req.body);
    const { ipAddress, userAgent } = extractRequestMeta(req);
    await requestAdminPasswordReset(dto.email, ipAddress, userAgent);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function confirmReset(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const dto = confirmSchema.parse(req.body);
    const { ipAddress, userAgent } = extractRequestMeta(req);
    await confirmAdminPasswordReset(
      dto.token,
      dto.newPassword,
      ipAddress,
      userAgent
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
