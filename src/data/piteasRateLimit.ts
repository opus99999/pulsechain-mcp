const PITEAS_ROLLING_LIMIT = 8;
const PITEAS_ROLLING_WINDOW_MS = 60_000;

type SlotState = "unused" | "attempted" | "completed";

interface ReservedSlot {
  leaseId: string;
  reservedAtMs: number;
  state: SlotState;
}

const reservedSlots: ReservedSlot[] = [];
let nextLeaseId = 1;

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
      leaseId: string;
      reservedSlots: number;
      attemptedSlots: number;
      completedSlots: number;
      releasedUnusedSlots: number;
      consumedSlots: number;
    })
  | (PiteasRateLimitBudget & {
      ok: false;
      reserved: 0;
      code: "RATE_LIMIT_REQUOTE_REQUIRED";
      reason: string;
    });

export interface PiteasRateLimitLeaseStatus extends PiteasRateLimitBudget {
  leaseId: string;
  reservedSlots: number;
  attemptedSlots: number;
  completedSlots: number;
  releasedUnusedSlots: number;
  consumedSlots: number;
  remainingBudget: number;
}

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
  const leaseId = `piteas_lease_${nextLeaseId++}`;
  for (let i = 0; i < requestCount; i += 1) {
    reservedSlots.push({ leaseId, reservedAtMs: nowMs, state: "unused" });
  }
  const updated = getPiteasRateLimitBudget(nowMs);
  return {
    ...updated,
    ok: true,
    reserved: requestCount,
    leaseId,
    reservedSlots: requestCount,
    attemptedSlots: 0,
    completedSlots: 0,
    releasedUnusedSlots: 0,
    consumedSlots: 0,
  };
}

export function getPiteasRateLimitBudget(nowMs = Date.now()): PiteasRateLimitBudget {
  prune(nowMs);
  const oldest = reservedSlots[0]?.reservedAtMs;
  const resetInMs =
    oldest === undefined
      ? null
      : Math.max(0, oldest + PITEAS_ROLLING_WINDOW_MS - nowMs);
  return {
    limit: PITEAS_ROLLING_LIMIT,
    windowMs: PITEAS_ROLLING_WINDOW_MS,
    used: reservedSlots.length,
    remaining: Math.max(0, PITEAS_ROLLING_LIMIT - reservedSlots.length),
    resetAt: resetInMs === null ? null : new Date(nowMs + resetInMs).toISOString(),
    resetInMs,
  };
}

export function markPiteasRateLimitSlotAttempted(
  leaseId: string,
  nowMs = Date.now(),
): PiteasRateLimitLeaseStatus {
  prune(nowMs);
  const slot = reservedSlots.find((entry) => entry.leaseId === leaseId && entry.state === "unused");
  if (!slot) {
    throw new Error("No unused Piteas rate-limit slot is available for this lease");
  }
  slot.state = "attempted";
  return getPiteasRateLimitLeaseStatus(leaseId, nowMs);
}

export function markPiteasRateLimitSlotCompleted(
  leaseId: string,
  nowMs = Date.now(),
): PiteasRateLimitLeaseStatus {
  prune(nowMs);
  const slot = reservedSlots.find((entry) => entry.leaseId === leaseId && entry.state === "attempted");
  if (!slot) {
    return getPiteasRateLimitLeaseStatus(leaseId, nowMs);
  }
  slot.state = "completed";
  return getPiteasRateLimitLeaseStatus(leaseId, nowMs);
}

export function releaseUnusedPiteasRateLimitSlots(
  leaseId: string,
  nowMs = Date.now(),
): PiteasRateLimitLeaseStatus {
  prune(nowMs);
  const before = reservedSlots.length;
  for (let i = reservedSlots.length - 1; i >= 0; i -= 1) {
    const slot = reservedSlots[i]!;
    if (slot.leaseId === leaseId && slot.state === "unused") {
      reservedSlots.splice(i, 1);
    }
  }
  const status = getPiteasRateLimitLeaseStatus(leaseId, nowMs);
  status.releasedUnusedSlots = before - reservedSlots.length;
  return status;
}

export function getPiteasRateLimitLeaseStatus(
  leaseId: string,
  nowMs = Date.now(),
): PiteasRateLimitLeaseStatus {
  prune(nowMs);
  const matching = reservedSlots.filter((slot) => slot.leaseId === leaseId);
  const attemptedSlots = matching.filter((slot) => slot.state === "attempted" || slot.state === "completed").length;
  const completedSlots = matching.filter((slot) => slot.state === "completed").length;
  const budget = getPiteasRateLimitBudget(nowMs);
  return {
    ...budget,
    leaseId,
    reservedSlots: matching.length,
    attemptedSlots,
    completedSlots,
    releasedUnusedSlots: 0,
    consumedSlots: attemptedSlots,
    remainingBudget: budget.remaining,
  };
}

export function resetPiteasRateLimitForTests(): void {
  reservedSlots.length = 0;
  nextLeaseId = 1;
}

function prune(nowMs: number): void {
  const cutoff = nowMs - PITEAS_ROLLING_WINDOW_MS;
  while (reservedSlots.length > 0 && reservedSlots[0]!.reservedAtMs <= cutoff) {
    reservedSlots.shift();
  }
}
