import type { AppConfig } from "../../../types.js";
import type { PiteasQuoteData, PiteasQuoteResult } from "../../../data/index.js";
import { PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT, PHIAT_DECIMALS } from "./constants.js";
import type { PhiatShadowBuyDeps, ShadowQuoteSummary, QuoteFreshness } from "./types.js";
import { averagePriceDecimal } from "./deterioration.js";
import { fingerprint, formatRawToken, nonEmptyDifferent, parseTimestampMs, quoteFingerprint } from "./inputNormalization.js";

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
  startedMs: number;
  completedMs: number;
  deadlineMs: number;
  maximumQuoteAgeMs: number;
  candidateAgeBeforePreparationMs?: number | null;
  candidateAgeBeforeSimulationMs?: number | null;
  candidateAgeAfterSimulationMs?: number | null;
}): QuoteFreshness {
  const before = quoteFreshnessOk(args.referenceBefore, args.completedMs, args.maximumQuoteAgeMs);
  const candidate = quoteFreshnessOk(args.candidateQuote, args.completedMs, args.maximumQuoteAgeMs);
  const after = quoteFreshnessOk(args.referenceAfter, args.completedMs, args.maximumQuoteAgeMs);
  const sandwichComplete = args.referenceBefore.ok && args.candidateQuote.ok && args.referenceAfter.ok;
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
  const confidence: QuoteFreshness["freshnessConfidence"] = possibleCacheDetected
    ? "low"
    : !sandwichComplete
      ? "unavailable"
      : independentEvidence
      ? "high"
      : "medium";
  const reason = !before.acceptable
    ? before.reason
    : !candidate.acceptable
      ? candidate.reason
      : !after.acceptable
        ? after.reason
        : possibleCacheDetected
          ? "Reference quotes were byte-identical without independent freshness metadata"
          : null;
  const freshnessAcceptable =
    sandwichComplete && before.acceptable && candidate.acceptable && after.acceptable && !possibleCacheDetected;
  return {
    referenceBeforeAcceptable: before.acceptable,
    candidateAcceptable: candidate.acceptable,
    referenceAfterAcceptable: after.acceptable,
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
    batchDurationMs: args.completedMs - args.startedMs,
    batchDeadlineMs: args.deadlineMs,
    reason,
  };
}

function quoteFreshnessOk(
  quote: ShadowQuoteSummary,
  nowMs: number,
  maximumQuoteAgeMs: number,
): { acceptable: boolean; ageMs: number | null; reason: string | null } {
  if (!quote.ok) return { acceptable: false, ageMs: null, reason: `${quote.label} failed` };
  const expiresAtMs = parseTimestampMs(quote.expiresAt);
  const responseMs = Date.parse(quote.responseReceivedAt);
  const ageMs = Number.isFinite(responseMs) ? nowMs - responseMs : null;
  if (expiresAtMs !== null && expiresAtMs <= nowMs) {
    return { acceptable: false, ageMs, reason: `${quote.label} quote expired` };
  }
  if (ageMs === null || ageMs < 0 || ageMs > maximumQuoteAgeMs) {
    return { acceptable: false, ageMs, reason: `${quote.label} quote is stale` };
  }
  return { acceptable: true, ageMs, reason: null };
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
