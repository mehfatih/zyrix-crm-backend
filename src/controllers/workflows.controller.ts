import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  createTestExecution,
  listExecutions,
  getExecution,
} from "../services/workflows.service";
import { TRIGGERS, ACTIONS, CONDITION_OPERATORS } from "../services/workflows-catalog";
import { recordAudit, extractRequestMeta } from "../utils/audit";

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return {
    userId: r.user.userId,
    companyId: r.user.companyId,
    role: r.user.role,
  };
}

// ──────────────────────────────────────────────────────────────────────
// CATALOG — returns the trigger/action specs so the frontend can render
// the visual builder without hardcoding the list.
// ──────────────────────────────────────────────────────────────────────

export async function catalog(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    data: {
      triggers: TRIGGERS,
      actions: ACTIONS,
      conditionOperators: CONDITION_OPERATORS,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// WORKFLOW CRUD
// ──────────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  isEnabled: z.enum(["true", "false"]).optional(),
  triggerType: z.string().optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const q = listQuerySchema.parse(req.query);
    const data = await listWorkflows(companyId, {
      isEnabled:
        q.isEnabled === undefined ? undefined : q.isEnabled === "true",
      triggerType: q.triggerType,
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function detail(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await getWorkflow(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  trigger: z.object({
    type: z.string(),
    config: z.record(z.any()).optional(),
  }),
  actions: z.array(z.any()).max(20).optional(),
  conditions: z.array(z.any()).max(10).optional(),
  isEnabled: z.boolean().optional(),
});

export async function create(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    // Members can't create workflows — they create pipeline changes,
    // task assignments, external webhooks. Admins and owners only.
    if (role !== "owner" && role !== "admin" && role !== "manager") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners, admins, and managers can create workflows.",
        },
      });
    }
    const dto = createSchema.parse(req.body);
    const data = await createWorkflow(companyId, userId, dto as any);
    await recordAudit({
      userId,
      companyId,
      action: "workflow.created",
      entityType: "workflow",
      entityId: data.id,
      metadata: { name: data.name, triggerType: data.trigger.type },
      ...extractRequestMeta(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  trigger: z
    .object({
      type: z.string(),
      config: z.record(z.any()).optional(),
    })
    .optional(),
  actions: z.array(z.any()).max(20).optional(),
  conditions: z.array(z.any()).max(10).optional(),
  isEnabled: z.boolean().optional(),
});

export async function update(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    if (role !== "owner" && role !== "admin" && role !== "manager") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners, admins, and managers can modify workflows.",
        },
      });
    }
    const dto = updateSchema.parse(req.body);
    const data = await updateWorkflow(
      companyId,
      req.params.id as string,
      dto as any
    );
    await recordAudit({
      userId,
      companyId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: data.id,
      metadata: { name: data.name },
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function remove(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners and admins can delete workflows.",
        },
      });
    }
    const data = await deleteWorkflow(companyId, req.params.id as string);
    await recordAudit({
      userId,
      companyId,
      action: "workflow.deleted",
      entityType: "workflow",
      entityId: req.params.id as string,
      ...extractRequestMeta(req),
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// TEST RUN
// ──────────────────────────────────────────────────────────────────────

const testRunSchema = z.object({
  payload: z.record(z.any()).optional(),
});

export async function testRun(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, companyId, role } = auth(req);
    if (role !== "owner" && role !== "admin" && role !== "manager") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only owners, admins, and managers can test workflows.",
        },
      });
    }
    const { payload } = testRunSchema.parse(req.body);
    const data = await createTestExecution(
      companyId,
      req.params.id as string,
      payload ?? {}
    );
    await recordAudit({
      userId,
      companyId,
      action: "workflow.test_run",
      entityType: "workflow",
      entityId: req.params.id as string,
      metadata: { executionId: data.executionId },
      ...extractRequestMeta(req),
    });
    res.status(202).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// EXECUTION HISTORY
// ──────────────────────────────────────────────────────────────────────

const executionsQuerySchema = z.object({
  workflowId: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export async function executions(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const q = executionsQuerySchema.parse(req.query);
    const data = await listExecutions(companyId, q);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function executionDetail(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = auth(req);
    const data = await getExecution(companyId, req.params.id as string);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
