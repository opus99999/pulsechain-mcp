const PITEAS_ROLLING_LIMIT = 8;
const PITEAS_ROLLING_WINDOW_MS = 60_000;

const reservedAtMs: number[] = [];

export interface PiteasRateLimitBudget {
  limit: number;
  windowMs: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  resetInMs: number | null;
}

export type PiteasRateLimitReservation =
  | (PiteasRateLimitBudget & {
      ok: true;
      reserved: number;
    })
  | (PiteasRateLimitBudget & {
      ok: false;
      reserved: 0;
      code: "RATE_LIMIT_REQUOTE_REQUIRED";
      reason: string;
    });

export function reservePiteasRateLimitSlots(
  requestCount: number,
  nowMs = Date.now(),
): PiteasRateLimitReservation {
  if (!Number.isInteger(requestCount) || requestCount < 1) {
    throw new Error("requestCount must be a positive integer");
  }
  prune(nowMs);
  const budget = getPiteasRateLimitBudget(nowMs);
  if (budget.remaining < requestCount) {
    return {
      ...budget,
      ok: false,
      reserved: 0,
      code: "RATE_LIMIT_REQUOTE_REQUIRED",
      reason:
        "Piteas rolling request budget cannot reserve the entire shadow-buy batch.",
    };
  }
  for (let i = 0; i < requestCount; i += 1) reservedAtMs.push(nowMs);
  return {
    ...getPiteasRateLimitBudget(nowMs),
    ok: true,
    reserved: requestCount,
  };
}

export function getPiteasRateLimitBudget(nowMs = Date.now()): PiteasRateLimitBudget {
  prune(nowMs);
  const oldest = reservedAtMs[0];
  const resetInMs =
    oldest === undefined
      ? null
      : Math.max(0, oldest + PITEAS_ROLLING_WINDOW_MS - nowMs);
  return {
    limit: PITEAS_ROLLING_LIMIT,
    windowMs: PITEAS_ROLLING_WINDOW_MS,
    used: reservedAtMs.length,
    remaining: Math.max(0, PITEAS_ROLLING_LIMIT - reservedAtMs.length),
    resetAt: resetInMs === null ? null : new Date(nowMs + resetInMs).toISOString(),
    resetInMs,
  };
}

export function resetPiteasRateLimitForTests(): void {
  reservedAtMs.length = 0;
}

function prune(nowMs: number): void {
  const cutoff = nowMs - PITEAS_ROLLING_WINDOW_MS;
  while (reservedAtMs.length > 0 && reservedAtMs[0]! <= cutoff) {
    reservedAtMs.shift();
  }
}
