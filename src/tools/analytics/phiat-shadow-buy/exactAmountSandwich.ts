import type { AppConfig } from "../../../types.js";
import type { PiteasQuoteData, PiteasQuoteResult } from "../../../data/index.js";
import { PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT, PHIAT_DECIMALS } from "./constants.js";
import type { PhiatShadowBuyDeps, ShadowQuoteSummary, QuoteFreshness, ReferenceFreshness, CandidateFreshness, SandwichTemporalCoherence } from "./types.js";
import { averagePriceDecimal } from "./deterioration.js";
import { fingerprint, formatRawToken, isPositiveIntegerString, nonEmptyDifferent, parseTimestampMs, quoteFingerprint } from "./inputNormalization.js";

export async function readMarketContext(
  config: AppConfig,
  deps: Pick<PhiatShadowBuyDeps, "buildPhiatDashboard" | "nowMs">,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const startedMs = deps.nowMs?.() ?? Date.now();
  try {
    const dashboard = await withRealTimeout(
      deps.buildPhiatDashboard(config, {
        tokenAddress: PHIAT_SHADOW_BUY_TOKEN_OUT,
        includePiteasDepth: false,
        recentSwapLimit: 20,
      }),
      timeoutMs,
      "market context timed out",
    );
    const completedMs = deps.nowMs?.() ?? Date.now();
    return {
      ok: true,
      includePiteasDepth: false,
      marketContextStartedAt: new Date(startedMs).toISOString(),
      marketContextCompletedAt: new Date(completedMs).toISOString(),
      marketContextDurationMs: completedMs - startedMs,
      token: (dashboard as Record<string, unknown>).token ?? null,
      market: (dashboard as Record<string, unknown>).market ?? null,
      liquidity: (dashboard as Record<string, unknown>).liquidity ?? null,
      dataQuality: (dashboard as Record<string, unknown>).dataQuality ?? null,
    };
  } catch (err) {
    const completedMs = deps.nowMs?.() ?? Date.now();
    return {
      ok: false,
      includePiteasDepth: false,
      marketContextStartedAt: new Date(startedMs).toISOString(),
      marketContextCompletedAt: new Date(completedMs).toISOString(),
      marketContextDurationMs: completedMs - startedMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function requestShadowQuote(args: {
  config: AppConfig;
  deps: Pick<PhiatShadowBuyDeps, "getPiteasQuote" | "nowMs">;
  label: ShadowQuoteSummary["label"];
  inputRaw: string;
  inputHuman: string;
  account: string | null;
  maximumSlippagePercent: number;
  timeoutMs: number;
}): Promise<ShadowQuoteSummary> {
  const requestStartedMs = args.deps.nowMs?.() ?? Date.now();
  let result: PiteasQuoteResult;
  try {
    result = await args.deps.getPiteasQuote(
      args.config,
      {
        tokenIn: PHIAT_SHADOW_BUY_TOKEN_IN,
        tokenOut: PHIAT_SHADOW_BUY_TOKEN_OUT,
        amount: args.inputRaw,
        allowedSlippage: args.maximumSlippagePercent,
        ...(args.account ? { account: args.account } : {}),
      },
      { timeoutMs: args.timeoutMs },
    );
  } catch (err) {
    const receivedMs = args.deps.nowMs?.() ?? Date.now();
    return failedQuoteSummary(args, requestStartedMs, receivedMs, err);
  }
  const responseReceivedMs = args.deps.nowMs?.() ?? Date.now();
  if (!result.ok) return failedQuoteSummary(args, requestStartedMs, responseReceivedMs, result.reason);
  return quoteSummary(args, requestStartedMs, responseReceivedMs, result.data);
}

function quoteSummary(
  args: {
    label: ShadowQuoteSummary["label"];
    inputRaw: string;
    inputHuman: string;
    account: string | null;
    timeoutMs: number;
  },
  requestStartedMs: number,
  responseReceivedMs: number,
  data: PiteasQuoteData,
): ShadowQuoteSummary {
  return {
    label: args.label,
    attempted: true,
    inputHuman: args.inputHuman,
    inputRaw: args.inputRaw,
    account: args.account,
    timeoutMs: args.timeoutMs,
    requestStartedAt: new Date(requestStartedMs).toISOString(),
    responseReceivedAt: new Date(responseReceivedMs).toISOString(),
    latencyMs: responseReceivedMs - requestStartedMs,
    ok: true,
    error: null,
    outputRaw: data.amountOut,
    outputHuman: formatRawToken(data.amountOut, PHIAT_DECIMALS),
    minimumOutputRaw: data.amountOutMin ?? null,
    minimumOutputHuman: formatRawToken(data.amountOutMin, PHIAT_DECIMALS),
    averagePrice: averagePriceDecimal(data),
    quoteIdentifier: data.quoteIdentifier ?? null,
    quoteTimestamp: data.quoteTimestamp ?? null,
    expiresAt: data.expiresAt ?? null,
    blockNumber: data.blockNumber ?? null,
    endpoint: data.endpoint ?? null,
    routeSignature: data.route?.signature ?? null,
    responseFingerprint: quoteFingerprint(data),
    methodParametersFingerprint: fingerprint(data.methodParameters),
    data,
  };
}

function failedQuoteSummary(
  args: {
    label: ShadowQuoteSummary["label"];
    inputRaw: string;
    inputHuman: string;
    account: string | null;
    timeoutMs: number;
  },
  requestStartedMs: number,
  responseReceivedMs: number,
  err: unknown,
): ShadowQuoteSummary {
  return {
    label: args.label,
    attempted: true,
    inputHuman: args.inputHuman,
    inputRaw: args.inputRaw,
    account: args.account,
    timeoutMs: args.timeoutMs,
    requestStartedAt: new Date(requestStartedMs).toISOString(),
    responseReceivedAt: new Date(responseReceivedMs).toISOString(),
    latencyMs: responseReceivedMs - requestStartedMs,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    outputRaw: null,
    outputHuman: null,
    minimumOutputRaw: null,
    minimumOutputHuman: null,
    averagePrice: null,
    quoteIdentifier: null,
    quoteTimestamp: null,
    expiresAt: null,
    blockNumber: null,
    endpoint: null,
    routeSignature: null,
    responseFingerprint: null,
    methodParametersFingerprint: null,
  };
}

export function skippedQuoteSummary(args: {
  label: ShadowQuoteSummary["label"];
  inputRaw: string;
  inputHuman: string;
  account: string | null;
  atMs: number;
  reason: string;
}): ShadowQuoteSummary {
  return {
    label: args.label,
    attempted: false,
    inputHuman: args.inputHuman,
    inputRaw: args.inputRaw,
    account: args.account,
    timeoutMs: null,
    requestStartedAt: new Date(args.atMs).toISOString(),
    responseReceivedAt: new Date(args.atMs).toISOString(),
    latencyMs: 0,
    ok: false,
    error: args.reason,
    outputRaw: null,
    outputHuman: null,
    minimumOutputRaw: null,
    minimumOutputHuman: null,
    averagePrice: null,
    quoteIdentifier: null,
    quoteTimestamp: null,
    expiresAt: null,
    blockNumber: null,
    endpoint: null,
    routeSignature: null,
    responseFingerprint: null,
    methodParametersFingerprint: null,
  };
}


export function analyzeQuoteFreshness(args: {
  referenceBefore: ShadowQuoteSummary;
  candidateQuote: ShadowQuoteSummary;
  referenceAfter: ShadowQuoteSummary;
  quoteBatchStatus: string;
  startedMs: number;
  completedMs: number;
  deadlineMs: number;
  maximumBatchDurationMs: number;
  maximumQuoteAgeMs: number;
  referenceInputRaw: string;
  referenceDriftPercent: number | null;
  maximumReferenceDriftPercent: number;
  candidateAgeBeforePreparationMs?: number | null;
  candidateAgeBeforeSimulationMs?: number | null;
  candidateAgeAfterSimulationMs?: number | null;
}): QuoteFreshness {
  const before = referenceValidity(args.referenceBefore, args.referenceInputRaw, args.maximumBatchDurationMs);
  const candidate = candidateFreshnessOk(args.candidateQuote, args.completedMs, args.maximumQuoteAgeMs);
  const after = referenceValidity(args.referenceAfter, args.referenceInputRaw, args.maximumBatchDurationMs);
  const sandwichComplete = args.referenceBefore.ok && args.candidateQuote.ok && args.referenceAfter.ok;
  const batchDurationMs = args.completedMs - args.startedMs;
  const referencesByteIdentical =
    sandwichComplete &&
    args.referenceBefore.responseFingerprint !== null &&
    args.referenceBefore.responseFingerprint === args.referenceAfter.responseFingerprint;
  const independentEvidence =
    nonEmptyDifferent(args.referenceBefore.quoteIdentifier, args.referenceAfter.quoteIdentifier) ||
    nonEmptyDifferent(args.referenceBefore.quoteTimestamp, args.referenceAfter.quoteTimestamp) ||
    nonEmptyDifferent(args.referenceBefore.expiresAt, args.referenceAfter.expiresAt) ||
    nonEmptyDifferent(args.referenceBefore.blockNumber, args.referenceAfter.blockNumber);
  const possibleCacheDetected = sandwichComplete && referencesByteIdentical && !independentEvidence;
  const confidence: ReferenceFreshness["confidence"] = possibleCacheDetected
    ? "low"
    : !sandwichComplete
      ? "unavailable"
      : independentEvidence
      ? "high"
      : "medium";
  const driftInvalid =
    args.referenceDriftPercent === null ||
    args.referenceDriftPercent > args.maximumReferenceDriftPercent;
  const temporalStatus: SandwichTemporalCoherence["status"] = !sandwichComplete
    ? "INCOMPLETE"
    : batchDurationMs > args.maximumBatchDurationMs
      ? "TOO_SLOW"
      : before.status === "VALID" &&
          candidate.status === "FRESH" &&
          after.status === "VALID" &&
          !possibleCacheDetected &&
          !driftInvalid
        ? "COHERENT"
        : "INCOMPLETE";
  const referenceWarnings = [
    ...before.warnings,
    ...after.warnings,
    ...(possibleCacheDetected
      ? ["Reference quotes were byte-identical without independent freshness metadata"]
      : []),
  ];
  const candidateFreshness: CandidateFreshness = {
    status: candidate.status,
    candidateResponseReceivedAt: args.candidateQuote.ok
      ? args.candidateQuote.responseReceivedAt
      : null,
    explicitQuoteTimestamp: args.candidateQuote.quoteTimestamp ?? null,
    explicitExpiry: args.candidateQuote.expiresAt ?? null,
    ageBeforePreparationMs: args.candidateAgeBeforePreparationMs ?? null,
    ageBeforeSimulationMs: args.candidateAgeBeforeSimulationMs ?? null,
    ageAfterSimulationMs: args.candidateAgeAfterSimulationMs ?? null,
    maximumQuoteAgeMs: args.maximumQuoteAgeMs,
    warnings: candidate.reason ? [candidate.reason] : [],
  };
  const referenceFreshness: ReferenceFreshness = {
    beforeStatus: before.status,
    afterStatus: after.status,
    possibleCacheDetected,
    confidence,
    warnings: referenceWarnings,
  };
  const sandwichTemporalCoherence: SandwichTemporalCoherence = {
    status: temporalStatus,
    quoteBatchStartedAt: new Date(args.startedMs).toISOString(),
    quoteBatchCompletedAt: new Date(args.completedMs).toISOString(),
    quoteBatchDurationMs: batchDurationMs,
    maximumBatchDurationMs: args.maximumBatchDurationMs,
  };
  const reason = before.status === "INVALID"
    ? before.reason
    : after.status === "INVALID"
      ? after.reason
      : candidate.status === "EXPIRED" || candidate.status === "STALE"
        ? candidate.reason
        : possibleCacheDetected
          ? "Reference quotes were byte-identical without independent freshness metadata"
          : temporalStatus === "TOO_SLOW"
            ? "Exact shadow-buy quote sandwich exceeded maximumBatchDurationMs"
            : temporalStatus === "INCOMPLETE"
              ? "Quote batch incomplete"
              : driftInvalid
                ? "Reference drift is unavailable or exceeds policy"
                : null;
  const freshnessAcceptable =
    sandwichComplete &&
    before.status === "VALID" &&
    candidate.status === "FRESH" &&
    after.status === "VALID" &&
    !possibleCacheDetected &&
    temporalStatus === "COHERENT" &&
    !driftInvalid;
  return {
    referenceBeforeAcceptable: before.status === "VALID",
    candidateAcceptable: candidate.status === "FRESH",
    referenceAfterAcceptable: after.status === "VALID",
    freshnessAcceptable,
    referencesByteIdentical,
    possibleCacheDetected,
    freshnessConfidence: confidence,
    candidateQuoteAgeMs: candidate.ageMs,
    candidateAgeBeforePreparationMs: args.candidateAgeBeforePreparationMs ?? null,
    candidateAgeBeforeSimulationMs: args.candidateAgeBeforeSimulationMs ?? null,
    candidateAgeAfterSimulationMs: args.candidateAgeAfterSimulationMs ?? null,
    maximumQuoteAgeMs: args.maximumQuoteAgeMs,
    batchStartedAt: new Date(args.startedMs).toISOString(),
    batchCompletedAt: new Date(args.completedMs).toISOString(),
    batchDurationMs,
    batchDeadlineMs: args.deadlineMs,
    referenceBeforeValidityStatus: before.status,
    referenceAfterValidityStatus: after.status,
    sandwichTemporalStatus: temporalStatus,
    referenceFreshness,
    candidateFreshness,
    sandwichTemporalCoherence,
    reason,
  };
}

function referenceValidity(
  quote: ShadowQuoteSummary,
  expectedInputRaw: string,
  maximumTimestampAgeAtReceiptMs: number,
): { status: ReferenceFreshness["beforeStatus"]; reason: string | null; warnings: string[] } {
  if (!quote.ok) return { status: "UNAVAILABLE", reason: `${quote.label} failed`, warnings: [] };
  const warnings: string[] = [];
  if (quote.inputRaw !== expectedInputRaw) {
    return {
      status: "INVALID",
      reason: `${quote.label} input amount did not match requested reference amount`,
      warnings,
    };
  }
  if (!isPositiveIntegerString(quote.outputRaw) || !isPositiveIntegerString(quote.minimumOutputRaw)) {
    return {
      status: "INVALID",
      reason: `${quote.label} output or minimum output is unavailable or non-positive`,
      warnings,
    };
  }
  const responseMs = Date.parse(quote.responseReceivedAt);
  if (!Number.isFinite(responseMs)) {
    return { status: "INVALID", reason: `${quote.label} response timestamp is invalid`, warnings };
  }
  const quoteTimestampMs = parseTimestampMs(quote.quoteTimestamp);
  if (quoteTimestampMs !== null && responseMs - quoteTimestampMs > maximumTimestampAgeAtReceiptMs) {
    return { status: "INVALID", reason: `${quote.label} quote timestamp was stale when received`, warnings };
  }
  const expiresAtMs = parseTimestampMs(quote.expiresAt);
  if (expiresAtMs !== null && expiresAtMs <= responseMs) {
    return { status: "INVALID", reason: `${quote.label} quote was expired when received`, warnings };
  }
  return { status: "VALID", reason: null, warnings };
}

function candidateFreshnessOk(
  quote: ShadowQuoteSummary,
  nowMs: number,
  maximumQuoteAgeMs: number,
): { status: CandidateFreshness["status"]; ageMs: number | null; reason: string | null } {
  if (!quote.ok) return { status: "UNAVAILABLE", ageMs: null, reason: `${quote.label} failed` };
  const expiresAtMs = parseTimestampMs(quote.expiresAt);
  const responseMs = Date.parse(quote.responseReceivedAt);
  const ageMs = Number.isFinite(responseMs) ? nowMs - responseMs : null;
  if (expiresAtMs !== null && expiresAtMs <= nowMs) {
    return { status: "EXPIRED", ageMs, reason: `${quote.label} quote expired` };
  }
  if (ageMs === null || ageMs < 0 || ageMs > maximumQuoteAgeMs) {
    return { status: "STALE", ageMs, reason: `${quote.label} quote is stale` };
  }
  return { status: "FRESH", ageMs, reason: null };
}

function withRealTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
