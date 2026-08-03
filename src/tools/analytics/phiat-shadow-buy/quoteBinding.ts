import type { PiteasPrepareResult, PiteasQuoteData } from "../../../data/index.js";
import { PHIAT_DECIMALS } from "./constants.js";
import type { CandidateBinding, PreparedIntent, ShadowQuoteSummary } from "./types.js";
import { fingerprint, formatRawToken, quoteFingerprint, selectorOf } from "./inputNormalization.js";

export function bindCandidateQuote(candidate: ShadowQuoteSummary): CandidateBinding {
  if (!candidate.data) throw new Error("Cannot bind failed candidate quote");
  return {
    candidateQuoteFingerprint: quoteFingerprint(candidate.data),
    candidateResponseReceivedAt: candidate.responseReceivedAt,
    candidateQuoteIdentifier: candidate.data.quoteIdentifier ?? null,
    candidateExpiry: candidate.data.expiresAt ?? null,
    candidateRouteSignature: candidate.data.route?.signature ?? null,
    candidateMethodParametersFingerprint: fingerprint(candidate.data.methodParameters),
  };
}

export function buildPreparedIntent(
  quote: PiteasQuoteData,
  prepared: Extract<PiteasPrepareResult, { ok: true }>,
  amountInHuman: string,
): PreparedIntent {
  return {
    chainId: quote.chainId,
    router: prepared.intent.to,
    recipient: prepared.review.recipient ?? null,
    tokenIn: prepared.review.tokenIn,
    tokenOut: prepared.review.tokenOut,
    amountInRaw: prepared.review.amountIn,
    amountInHuman,
    expectedAmountOutRaw: prepared.review.amountOut,
    expectedAmountOutHuman: formatRawToken(prepared.review.amountOut, PHIAT_DECIMALS),
    minimumAmountOutRaw: prepared.review.amountOutMin ?? null,
    minimumAmountOutHuman: formatRawToken(prepared.review.amountOutMin, PHIAT_DECIMALS),
    calldata: prepared.intent.data,
    calldataSelector: selectorOf(prepared.intent.data),
    valueWei: prepared.intent.valueWei,
    valuePls: prepared.intent.valuePls,
    deadlineOrExpiry: quote.expiresAt ?? null,
    gasEstimateFromQuote: quote.gasUseEstimate ?? null,
    routeProtocols: quote.route?.protocols ?? [],
    routePools: quote.route?.pools ?? [],
  };
}
