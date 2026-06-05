// ============================================================================
// CPQ DISCOUNT GOVERNANCE — Sprint 9
// ----------------------------------------------------------------------------
// Resolves the discount_rule that applies to a user (user-scope rule wins over
// role-scope) and evaluates a requested discount against it. Shared by the
// builder's cap indicator (Phase C) and the approval enforcement (Phase D).
//
//   requested ≤ maxPct                          → 'ok'      (send directly)
//   maxPct < requested ≤ approvalAbovePct        → 'approval'(needs approval)
//   requested > approvalAbovePct (or no ceiling) → 'blocked'
//   no rule at all                               → 'ok'     (ungoverned)
// ============================================================================

import { prisma } from "../config/database";

export interface ResolvedDiscountRule {
  maxPct: number;
  approvalAbovePct: number | null;
}

export type DiscountDecision = "ok" | "approval" | "blocked";

export interface DiscountEvaluation {
  decision: DiscountDecision;
  requestedPct: number;
  maxPct: number | null;
  approvalAbovePct: number | null;
}

// User-scope rule (scopeValue = userId) takes precedence over the role rule.
export async function resolveDiscountRuleForUser(
  companyId: string,
  userId: string,
  role: string
): Promise<ResolvedDiscountRule | null> {
  const rules = await prisma.discountRule.findMany({
    where: {
      companyId,
      OR: [
        { scope: "user", scopeValue: userId },
        { scope: "role", scopeValue: role },
      ],
    },
  });
  if (!rules.length) return null;
  const userRule = rules.find((r) => r.scope === "user");
  const chosen = userRule ?? rules.find((r) => r.scope === "role") ?? rules[0];
  return {
    maxPct: Number(chosen.maxPct),
    approvalAbovePct:
      chosen.approvalAbovePct == null ? null : Number(chosen.approvalAbovePct),
  };
}

export function evaluateDiscount(
  rule: ResolvedDiscountRule | null,
  requestedPct: number
): DiscountEvaluation {
  const requested = Number(requestedPct) || 0;
  if (!rule) {
    return { decision: "ok", requestedPct: requested, maxPct: null, approvalAbovePct: null };
  }
  let decision: DiscountDecision;
  if (requested <= rule.maxPct) {
    decision = "ok";
  } else if (rule.approvalAbovePct != null && requested <= rule.approvalAbovePct) {
    decision = "approval";
  } else {
    decision = "blocked";
  }
  return {
    decision,
    requestedPct: requested,
    maxPct: rule.maxPct,
    approvalAbovePct: rule.approvalAbovePct,
  };
}
