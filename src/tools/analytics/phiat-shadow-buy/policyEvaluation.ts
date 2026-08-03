import type { PolicyCheck } from "./types.js";

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
  reasons: string[],
  name: string,
  reason: string,
  details?: Record<string, unknown>,
): void {
  checks[name] = { status: "fail", reason, ...(details ? { details } : {}) };
  reasons.push(reason);
}

export function requireCheck(
  checks: Record<string, PolicyCheck>,
  reasons: string[],
  name: string,
  condition: boolean,
  reason: string,
  details?: Record<string, unknown>,
): void {
  if (condition) passCheck(checks, name, details);
  else failCheck(checks, reasons, name, reason, details);
}

export function hasFailures(checks: Record<string, PolicyCheck>): boolean {
  return Object.values(checks).some((check) => check.status === "fail");
}
