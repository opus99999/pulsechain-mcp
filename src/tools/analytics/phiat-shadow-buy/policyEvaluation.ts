import type { PolicyCheck, ShadowBuyReason } from "./types.js";

export interface ReasonOptions {
  code?: string;
  stage?: string;
}

export function passCheck(
  checks: Record<string, PolicyCheck>,
  name: string,
  details?: Record<string, unknown>,
): void {
  checks[name] = { status: "pass", ...(details ? { details } : {}) };
}

export function warnCheck(
  checks: Record<string, PolicyCheck>,
  name: string,
  reason: string,
  details?: Record<string, unknown>,
): void {
  checks[name] = { status: "warning", reason, ...(details ? { details } : {}) };
}

export function failCheck(
  checks: Record<string, PolicyCheck>,
  reasons: ShadowBuyReason[],
  name: string,
  reason: string,
  details?: Record<string, unknown>,
  options: ReasonOptions = {},
): void {
  const code = options.code ?? defaultReasonCode(name);
  const stage = options.stage ?? defaultStage(name);
  checks[name] = {
    status: "fail",
    code,
    stage,
    reason,
    ...(details ? { details } : {}),
  };
  reasons.push({
    code,
    stage,
    message: reason,
    evidence: details ?? null,
  });
}

export function requireCheck(
  checks: Record<string, PolicyCheck>,
  reasons: ShadowBuyReason[],
  name: string,
  condition: boolean,
  reason: string,
  details?: Record<string, unknown>,
  options: ReasonOptions = {},
): void {
  if (condition) passCheck(checks, name, details);
  else failCheck(checks, reasons, name, reason, details, options);
}

export function hasFailures(checks: Record<string, PolicyCheck>): boolean {
  return Object.values(checks).some((check) => check.status === "fail");
}

function defaultReasonCode(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

function defaultStage(name: string): string {
  if (name.includes("quote") || name.includes("drift") || name.includes("deterioration")) {
    return "quote_batch";
  }
  if (name.includes("allowance")) return "allowance";
  if (name.includes("approval")) return "approval";
  if (name.includes("router")) return "router_integrity";
  if (name.includes("simulation") || name.includes("eth_call") || name.includes("estimate_gas")) {
    return "simulation";
  }
  if (name.includes("gas")) return "gas_policy";
  if (name.includes("balance")) return "balances";
  return "policy";
}
