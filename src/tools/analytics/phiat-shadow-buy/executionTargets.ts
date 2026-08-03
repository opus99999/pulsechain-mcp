import type { DecodedIntent, ExecutionTargetsReport, PolicyCheck, RouterIntegrity } from "./types.js";
import { PITEAS_ROUTER } from "./constants.js";
import { requireCheck } from "./policyEvaluation.js";

export function buildExecutionTargets(
  router: RouterIntegrity,
  decoded: DecodedIntent,
): ExecutionTargetsReport {
  const unresolved = [...decoded.unresolvedTargets];
  if (!decoded.decodable) unresolved.push("calldata_selector");
  const targets = [
    {
      address: router.router ?? PITEAS_ROUTER,
      role: "router" as const,
      source: "transaction.to",
      approved: router.routerCodeHashApproved,
    },
    ...decoded.nestedTargets.map((address) => ({
      address,
      role: "nested_call_target" as const,
      source: "decoded_calldata",
      approved: null,
    })),
  ];
  return {
    executionTargets: targets,
    unresolvedExecutionTargets: unresolved,
    executionTargetConfidence:
      unresolved.length > 0 ? "low" : decoded.nestedTargets.length > 0 ? "medium" : "high",
  };
}

export function validateExecutionTargets(
  checks: Record<string, PolicyCheck>,
  reasons: string[],
  targets: ExecutionTargetsReport,
): void {
  requireCheck(
    checks,
    reasons,
    "execution_targets_resolved",
    targets.unresolvedExecutionTargets.length === 0,
    "Unresolved nested execution targets fail closed",
    targets as unknown as Record<string, unknown>,
  );
}
