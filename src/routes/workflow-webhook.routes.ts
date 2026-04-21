import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../config/database";
import { enqueueExecution } from "../services/workflows.service";

// ============================================================================
// PUBLIC WORKFLOW WEBHOOK RECEIVER
// ----------------------------------------------------------------------------
// External systems POST here to trigger a workflow with trigger.type
// 'webhook.received'. The URL contains the workflow id — this is the only
// authentication (a UUID is hard to guess). For higher security users can
// add a condition on request headers, e.g. field="headers.x-api-key".
// ============================================================================

const router = Router();

// Per-workflow rate limit — 120 req/min. The key is the workflowId from
// the route param so one busy workflow doesn't starve others.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `wh:${req.params.workflowId}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many requests" },
  },
});

router.post(
  "/:workflowId",
  webhookLimiter,
  async (req: Request, res: Response) => {
    const workflowId = req.params.workflowId;
    if (!workflowId) {
      return res
        .status(400)
        .json({ success: false, error: { message: "workflowId required" } });
    }
    try {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT id, "companyId", trigger, "isEnabled"
         FROM workflows WHERE id = $1 LIMIT 1`,
        workflowId
      )) as any[];
      if (rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: { message: "Workflow not found" } });
      }
      const wf = rows[0];
      const trigger =
        typeof wf.trigger === "string" ? JSON.parse(wf.trigger) : wf.trigger;
      if (trigger.type !== "webhook.received") {
        return res.status(400).json({
          success: false,
          error: {
            message: "This workflow does not accept webhook triggers",
          },
        });
      }
      if (!wf.isEnabled) {
        // Return 202 so the caller doesn't think their setup is broken —
        // the workflow exists and accepts webhooks, it's just paused.
        return res
          .status(202)
          .json({ success: true, message: "Workflow is disabled" });
      }

      // Normalize headers to lowercase keys so {{headers.authorization}}
      // templating works regardless of how the sender cased them.
      const normalizedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") normalizedHeaders[k.toLowerCase()] = v;
      }

      const { executionId } = await enqueueExecution(
        wf.id,
        wf.companyId,
        {
          event: "webhook.received",
          timestamp: new Date().toISOString(),
          body: req.body,
          headers: normalizedHeaders,
          query: req.query,
        }
      );
      res.status(202).json({
        success: true,
        data: { executionId, queued: true },
      });
    } catch (err) {
      console.error("[webhook-trigger] error:", (err as Error).message);
      res
        .status(500)
        .json({ success: false, error: { message: "Internal error" } });
    }
  }
);

// Also accept GET so URL verification pings (common gateway pattern) pass
router.get("/:workflowId", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Workflow webhook endpoint ready — use POST to trigger",
  });
});

export default router;
