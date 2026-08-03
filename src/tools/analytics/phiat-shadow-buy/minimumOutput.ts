import type { PiteasQuoteData } from "../../../data/index.js";
import type { DecodedIntent, MinimumOutputValidation } from "./types.js";
import { fingerprint, stringToBigInt } from "./inputNormalization.js";

export function evaluateMinimumOutputValidation(args: {
  quote: PiteasQuoteData;
  decodedIntent: DecodedIntent;
}): MinimumOutputValidation {
  const { quote, decodedIntent } = args;
  const decodedMinimumOutputRaw =
    decodedIntent.minimumOutputRaw ?? decodedIntent.minimumAmountOutRaw ?? null;
  const apiMinimumOutputRaw = quote.amountOutMin ?? null;
  const decodedMin = stringToBigInt(decodedMinimumOutputRaw);
  const quoteMin = stringToBigInt(apiMinimumOutputRaw);
  const relationship =
    decodedMin === null || quoteMin === null
      ? "SEMANTICS_UNRESOLVED"
      : decodedMin === quoteMin
        ? "EXACT_MATCH"
        : decodedMin > quoteMin
          ? "CALLDATA_STRICTER"
          : "CALLDATA_WEAKER";
  const validationStatus =
    relationship === "EXACT_MATCH" || relationship === "CALLDATA_STRICTER"
      ? "PASSED"
      : "FAILED";

  return {
    apiExpectedOutputRaw: quote.amountOut,
    apiMinimumOutputRaw,
    quoteRouteMinimumOutputRaw: routeMinimumOutputRaw(quote),
    methodParametersMinimumOutputRaw: decodedMinimumOutputRaw,
    decodedDestMinAmountRaw: decodedMinimumOutputRaw,
    decodedReturnConstraintRaw: decodedMinimumOutputRaw,
    allowedSlippagePercent: quote.allowedSlippage,
    sourceForEachValue: {
      apiExpectedOutputRaw: "Piteas response destAmount normalized as quote.amountOut",
      apiMinimumOutputRaw:
        "Retained quote amountOutMin, computed from destAmount and allowedSlippage when upstream does not expose a separate min field",
      quoteRouteMinimumOutputRaw:
        "Piteas route summary has no authoritative minimum-output field in the normalized quote",
      methodParametersMinimumOutputRaw:
        "ABI-decoded PiteasRouter.swap Detail.destMinAmount from exact methodParameters.calldata",
      decodedDestMinAmountRaw:
        "ABI-decoded PiteasRouter.swap Detail.destMinAmount from exact methodParameters.calldata",
      decodedReturnConstraintRaw:
        "Executable router return constraint; PiteasRouter reverts unless returnAmount >= Detail.destMinAmount",
      allowedSlippagePercent: "Requested quote allowedSlippage retained with the candidate response",
    },
    relationship,
    authoritativeQuoteField: "quote.amountOutMin",
    validationStatus,
    explanation: explanation(relationship),
    evidenceFingerprint: fingerprint({
      quoteIdentifier: quote.quoteIdentifier ?? null,
      responseFingerprint: quote.responseFingerprint ?? null,
      methodParameters: quote.methodParameters,
      apiExpectedOutputRaw: quote.amountOut,
      apiMinimumOutputRaw,
      decodedMinimumOutputRaw,
      allowedSlippagePercent: quote.allowedSlippage,
      relationship,
    }),
  };
}

function routeMinimumOutputRaw(quote: PiteasQuoteData): string | null {
  const route = quote.route as (PiteasQuoteData["route"] & {
    minimumOutputRaw?: unknown;
    amountOutMin?: unknown;
    minAmountOut?: unknown;
  }) | null | undefined;
  const value = route?.minimumOutputRaw ?? route?.amountOutMin ?? route?.minAmountOut;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function explanation(relationship: MinimumOutputValidation["relationship"]): string {
  if (relationship === "EXACT_MATCH") {
    return "Decoded calldata minimum exactly matches the retained quote minimum.";
  }
  if (relationship === "CALLDATA_STRICTER") {
    return "Decoded calldata minimum is greater than the retained quote minimum, so the executable transaction provides stricter output protection.";
  }
  if (relationship === "CALLDATA_WEAKER") {
    return "Decoded calldata minimum is lower than the retained quote minimum, so the executable transaction provides weaker output protection.";
  }
  return "Minimum-output semantics could not be resolved from the retained quote and decoded calldata.";
}
