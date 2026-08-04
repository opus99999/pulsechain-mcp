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
  const apiGuaranteedOutputRaw = guaranteedOutputRaw(quote);
  const decodedMin = stringToBigInt(decodedMinimumOutputRaw);
  const authoritativeMin = stringToBigInt(apiGuaranteedOutputRaw ?? decodedMinimumOutputRaw);
  const relationship =
    decodedMin === null || authoritativeMin === null
      ? "SEMANTICS_UNRESOLVED"
      : decodedMin === authoritativeMin
        ? "EXACT_MATCH"
        : decodedMin > authoritativeMin
          ? "CALLDATA_STRICTER"
          : "CALLDATA_WEAKER";
  const diagnosticComputedMinimumRelationship = compareBigints(
    decodedMin,
    stringToBigInt(apiMinimumOutputRaw),
  );
  const validationStatus =
    relationship === "EXACT_MATCH" || relationship === "CALLDATA_STRICTER"
      ? "PASSED"
      : "FAILED";

  return {
    apiExpectedOutputRaw: quote.amountOut,
    apiMinimumOutputRaw,
    apiGuaranteedOutputRaw,
    quoteRouteMinimumOutputRaw: routeMinimumOutputRaw(quote),
    methodParametersMinimumOutputRaw: decodedMinimumOutputRaw,
    decodedDestMinAmountRaw: decodedMinimumOutputRaw,
    decodedReturnConstraintRaw: decodedMinimumOutputRaw,
    decodedManagerConstraintRaw: null,
    allowedSlippagePercent: quote.allowedSlippage,
    sourceForEachValue: {
      apiExpectedOutputRaw: "Piteas response destAmount normalized as quote.amountOut",
      apiMinimumOutputRaw:
        "Local computed quote.amountOutMin review aid from destAmount and allowedSlippage when upstream does not expose a separate min field",
      apiGuaranteedOutputRaw:
        "Independent upstream guaranteed/minimum output field when provided; absent for the captured current Piteas response",
      quoteRouteMinimumOutputRaw:
        "Piteas route summary has no authoritative minimum-output field in the normalized quote",
      methodParametersMinimumOutputRaw:
        "ABI-decoded PiteasRouter.swap Detail.destMinAmount from exact methodParameters.calldata",
      decodedDestMinAmountRaw:
        "ABI-decoded PiteasRouter.swap Detail.destMinAmount from exact methodParameters.calldata",
      decodedReturnConstraintRaw:
        "Executable router return constraint; PiteasRouter reverts unless returnAmount >= Detail.destMinAmount",
      decodedManagerConstraintRaw:
        "No separate SwapManager minimum-output field is proven in the current route envelope; router Detail.destMinAmount is authoritative",
      allowedSlippagePercent: "Requested quote allowedSlippage retained with the candidate response",
    },
    fieldJsonPaths: {
      apiExpectedOutputRaw: "$.destAmount",
      apiMinimumOutputRaw:
        quote.amountOutMinSource === "computed_slippage_floor"
          ? "$.amountOutMin (local computed review aid)"
          : "$.amountOutMin",
      apiGuaranteedOutputRaw: guaranteedOutputPath(quote),
      quoteRouteMinimumOutputRaw: "$.route.minimumOutputRaw|$.route.amountOutMin|$.route.minAmountOut",
      methodParametersMinimumOutputRaw:
        "$.methodParameters.calldata -> PiteasRouter.swap.detail.destMinAmount",
      decodedDestMinAmountRaw:
        "$.methodParameters.calldata -> PiteasRouter.swap.detail.destMinAmount",
      decodedReturnConstraintRaw:
        "$.methodParameters.calldata -> PiteasRouter.swap.detail.destMinAmount",
      decodedManagerConstraintRaw: null,
      allowedSlippagePercent: "$.allowedSlippage",
    },
    fieldMeanings: {
      apiExpectedOutputRaw: "Expected output amount, not a minimum.",
      apiMinimumOutputRaw:
        quote.amountOutMinSource === "computed_slippage_floor"
          ? "Locally computed slippage floor for review diagnostics."
          : "Candidate quote minimum-output field.",
      apiGuaranteedOutputRaw: "Authoritative upstream guaranteed minimum when present.",
      quoteRouteMinimumOutputRaw: "Route-summary minimum-output field if one exists.",
      methodParametersMinimumOutputRaw: "Executable router minimum-output constraint.",
      decodedDestMinAmountRaw: "ABI-decoded Detail.destMinAmount.",
      decodedReturnConstraintRaw: "Router return-amount constraint.",
      decodedManagerConstraintRaw: "Separate manager route constraint; unresolved for current envelope.",
      allowedSlippagePercent: "Slippage requested from Piteas.",
    },
    fieldProvenance: {
      apiExpectedOutputRaw: "normalized Piteas API response",
      apiMinimumOutputRaw:
        quote.amountOutMinSource === "computed_slippage_floor"
          ? "local MCP normalization"
          : "normalized Piteas API response",
      apiGuaranteedOutputRaw: apiGuaranteedOutputRaw === null ? "absent" : "normalized Piteas API response",
      quoteRouteMinimumOutputRaw: "normalized Piteas route summary",
      methodParametersMinimumOutputRaw: "retained Piteas methodParameters calldata",
      decodedDestMinAmountRaw: "retained Piteas methodParameters calldata",
      decodedReturnConstraintRaw: "retained Piteas methodParameters calldata",
      decodedManagerConstraintRaw: "not established",
      allowedSlippagePercent: "shadow-buy request",
    },
    relationship,
    authoritativeQuoteField:
      apiGuaranteedOutputRaw === null
        ? "quote.methodParameters.calldata.detail.destMinAmount"
        : guaranteedOutputPath(quote),
    diagnosticComputedMinimumRelationship,
    validationStatus,
    explanation: explanation(relationship),
    evidenceFingerprint: fingerprint({
      quoteIdentifier: quote.quoteIdentifier ?? null,
      responseFingerprint: quote.responseFingerprint ?? null,
      methodParameters: quote.methodParameters,
      apiExpectedOutputRaw: quote.amountOut,
      apiMinimumOutputRaw,
      apiGuaranteedOutputRaw,
      decodedMinimumOutputRaw,
      allowedSlippagePercent: quote.allowedSlippage,
      relationship,
      diagnosticComputedMinimumRelationship,
    }),
  };
}

function guaranteedOutputRaw(quote: PiteasQuoteData): string | null {
  const rec = quote as PiteasQuoteData & Record<string, unknown>;
  const candidates = [
    ["guaranteedOutputRaw", rec.guaranteedOutputRaw],
    ["guaranteedOutput", rec.guaranteedOutput],
    ["minimumOutputRaw", rec.minimumOutputRaw],
    ["minAmountOutRaw", rec.minAmountOutRaw],
    ["minAmountOut", rec.minAmountOut],
    ["amountOutMin", quote.amountOutMinSource === "upstream" ? quote.amountOutMin : undefined],
  ] as const;
  for (const [, value] of candidates) {
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
  }
  return null;
}

function guaranteedOutputPath(quote: PiteasQuoteData): string | null {
  const rec = quote as PiteasQuoteData & Record<string, unknown>;
  const candidates = [
    ["$.guaranteedOutputRaw", rec.guaranteedOutputRaw],
    ["$.guaranteedOutput", rec.guaranteedOutput],
    ["$.minimumOutputRaw", rec.minimumOutputRaw],
    ["$.minAmountOutRaw", rec.minAmountOutRaw],
    ["$.minAmountOut", rec.minAmountOut],
    ["$.amountOutMin", quote.amountOutMinSource === "upstream" ? quote.amountOutMin : undefined],
  ] as const;
  for (const [path, value] of candidates) {
    if (typeof value === "string" && /^\d+$/.test(value)) return path;
  }
  return null;
}

function compareBigints(
  left: bigint | null,
  right: bigint | null,
): MinimumOutputValidation["relationship"] {
  if (left === null || right === null) return "SEMANTICS_UNRESOLVED";
  if (left === right) return "EXACT_MATCH";
  return left > right ? "CALLDATA_STRICTER" : "CALLDATA_WEAKER";
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
