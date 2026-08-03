import type { AppConfig } from "../../../types.js";
import type { PiteasQuoteData, PiteasQuoteResult } from "../../../data/index.js";
import { PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT, PHIAT_DECIMALS } from "./constants.js";
import type { PhiatShadowBuyDeps, ShadowQuoteSummary, QuoteFreshness } from "./types.js";
import { averagePriceDecimal } from "./deterioration.js";
import { fingerprint, formatRawToken, nonEmptyDifferent, parseTimestampMs, quoteFingerprint } from "./inputNormalization.js";

export async function readMarketContext(
  config: AppConfig,
  deps: Pick<PhiatShadowBuyDeps, "buildPhiatDashboard">,
): Promise<Record<string, unknown>> {
  try {
    const dashboard = await deps.buildPhiatDashboard(config, {
      tokenAddress: PHIAT_SHADOW_BUY_TOKEN_OUT,
      includePiteasDepth: false,
      recentSwapLimit: 20,
    });
    return {
      ok: true,
      includePiteasDepth: false,
      token: (dashboard as Record<string, unknown>).token ?? null,
      market: (dashboard as Record<string, unknown>).market ?? null,
      liquidity: (dashboard as Record<string, unknown>).liquidity ?? null,
      dataQuality: (dashboard as Record<string, unknown>).dataQuality ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      includePiteasDepth: false,
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
  deadlineMs: number;
}): Promise<ShadowQuoteSummary> {
  const requestStartedMs = args.deps.nowMs?.() ?? Date.now();
  const timeoutMs = Math.max(1_000, args.deadlineMs - requestStartedMs);
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
      { timeoutMs },
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
  },
  requestStartedMs: number,
  responseReceivedMs: number,
  data: PiteasQuoteData,
): ShadowQuoteSummary {
  return {
    label: args.label,
    inputHuman: args.inputHuman,
    inputRaw: args.inputRaw,
    account: args.account,
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
  },
  requestStartedMs: number,
  responseReceivedMs: number,
  err: unknown,
): ShadowQuoteSummary {
  return {
    label: args.label,
    inputHuman: args.inputHuman,
    inputRaw: args.inputRaw,
    account: args.account,
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


export function analyzeQuoteFreshness(args: {
  referenceBefore: ShadowQuoteSummary;
  candidateQuote: ShadowQuoteSummary;
  referenceAfter: ShadowQuoteSummary;
  startedMs: number;
  completedMs: number;
  deadlineMs: number;
  maximumQuoteAgeMs: number;
}): QuoteFreshness {
  const before = quoteFreshnessOk(args.referenceBefore, args.completedMs, args.maximumQuoteAgeMs);
  const candidate = quoteFreshnessOk(args.candidateQuote, args.completedMs, args.maximumQuoteAgeMs);
  const after = quoteFreshnessOk(args.referenceAfter, args.completedMs, args.maximumQuoteAgeMs);
  const referencesByteIdentical =
    args.referenceBefore.responseFingerprint !== null &&
    args.referenceBefore.responseFingerprint === args.referenceAfter.responseFingerprint;
  const independentEvidence =
    nonEmptyDifferent(args.referenceBefore.quoteIdentifier, args.referenceAfter.quoteIdentifier) ||
    nonEmptyDifferent(args.referenceBefore.quoteTimestamp, args.referenceAfter.quoteTimestamp) ||
    nonEmptyDifferent(args.referenceBefore.expiresAt, args.referenceAfter.expiresAt) ||
    nonEmptyDifferent(args.referenceBefore.blockNumber, args.referenceAfter.blockNumber);
  const possibleCacheDetected = referencesByteIdentical && !independentEvidence;
  const confidence: QuoteFreshness["freshnessConfidence"] = possibleCacheDetected
    ? "low"
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
  return {
    referenceBeforeAcceptable: before.acceptable,
    candidateAcceptable: candidate.acceptable,
    referenceAfterAcceptable: after.acceptable,
    referencesByteIdentical,
    possibleCacheDetected,
    freshnessConfidence: confidence,
    candidateQuoteAgeMs: candidate.ageMs,
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
  const timestampMs = parseTimestampMs(quote.quoteTimestamp);
  const expiresAtMs = parseTimestampMs(quote.expiresAt);
  const responseMs = Date.parse(quote.responseReceivedAt);
  const anchorMs = timestampMs ?? responseMs;
  const ageMs = Number.isFinite(anchorMs) ? nowMs - anchorMs : null;
  if (expiresAtMs !== null && expiresAtMs <= nowMs) {
    return { acceptable: false, ageMs, reason: `${quote.label} quote expired` };
  }
  if (ageMs === null || ageMs < 0 || ageMs > maximumQuoteAgeMs) {
    return { acceptable: false, ageMs, reason: `${quote.label} quote is stale` };
  }
  return { acceptable: true, ageMs, reason: null };
}
