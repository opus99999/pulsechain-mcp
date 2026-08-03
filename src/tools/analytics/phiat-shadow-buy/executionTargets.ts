import type { DecodedIntent, ExecutionTargetsReport, PolicyCheck, RouterIntegrity, ShadowBuyReason } from "./types.js";
import { PITEAS_ROUTER } from "./constants.js";
import { requireCheck } from "./policyEvaluation.js";

export function buildExecutionTargets(
  router: RouterIntegrity,
  decoded: DecodedIntent,
): ExecutionTargetsReport {
  const unresolved = [
    ...new Set([
      ...decoded.unresolvedTargets,
      ...decoded.unresolvedExecutionTargets,
    ]),
  ];
  if (!decoded.decodable) unresolved.push("calldata_selector");
  const targets = [
    {
      address: router.router ?? PITEAS_ROUTER,
      role: "router" as const,
      selector: decoded.selector,
      codeHash: router.routerBytecodeHash,
      source: "transaction.to",
      approved: router.routerCodeHashApproved,
    },
    ...decoded.executionTargets,
  ];
  return {
    executionTargets: targets,
    unresolvedExecutionTargets: [...new Set(unresolved)],
    executionTargetConfidence:
      unresolved.length > 0 ? "low" : decoded.executionTargets.length > 0 ? "medium" : "high",
  };
}

export function validateExecutionTargets(
  checks: Record<string, PolicyCheck>,
  reasons: ShadowBuyReason[],
  targets: ExecutionTargetsReport,
): void {
  requireCheck(
    checks,
    reasons,
    "execution_targets_resolved",
    targets.unresolvedExecutionTargets.length === 0,
    "Unresolved nested execution targets fail closed",
    targets as unknown as Record<string, unknown>,
    { code: "EXECUTION_TARGETS_UNRESOLVED", stage: "policy" },
  );
}
