import { PULSECHAIN_CHAIN_ID } from "../../../constants.js";
import { type PiteasPrepareResult, type PiteasQuoteData } from "../../../data/index.js";
import { PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT, PITEAS_ROUTER, PITEAS_SWAP_CANONICAL_SIGNATURE } from "./constants.js";
import type { DecodedIntent, PolicyCheck, ShadowBuyReason } from "./types.js";
import { failCheck, passCheck, requireCheck } from "./policyEvaluation.js";
import { fingerprint, isPositiveIntegerString, parseTimestampMs, safeWei, sameAddress, stringToBigInt } from "./inputNormalization.js";
import { evaluateMinimumOutputValidation } from "./minimumOutput.js";

export function validatePreparedAndDecodedIntent(args: {
  policyChecks: Record<string, PolicyCheck>;
  reasons: ShadowBuyReason[];
  quote: PiteasQuoteData;
  prepared: Extract<PiteasPrepareResult, { ok: true }>;
  decodedIntent: DecodedIntent;
  walletAddress: string;
  amountInRaw: string;
  maximumSlippagePercent: number;
}): void {
  const { policyChecks, reasons, quote, prepared, decodedIntent } = args;
  requireCheck(
    policyChecks,
    reasons,
    "chain_id",
    quote.chainId === PULSECHAIN_CHAIN_ID,
    "Prepared Piteas intent is not for PulseChain chain ID 369",
    { chainId: quote.chainId },
    { code: "CHAIN_ID_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "transaction_to_router",
    sameAddress(prepared.intent.to, PITEAS_ROUTER),
    "Prepared transaction target is not the official Piteas router",
    { to: prepared.intent.to, officialRouter: PITEAS_ROUTER },
    { code: "ROUTER_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_token_in",
    sameAddress(prepared.review.tokenIn, PHIAT_SHADOW_BUY_TOKEN_IN),
    "Prepared tokenIn is not verified eUSDC",
    { tokenIn: prepared.review.tokenIn },
    { code: "PREPARED_TOKEN_IN_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_token_out",
    sameAddress(prepared.review.tokenOut, PHIAT_SHADOW_BUY_TOKEN_OUT),
    "Prepared tokenOut is not PHIAT",
    { tokenOut: prepared.review.tokenOut },
    { code: "PREPARED_TOKEN_OUT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_recipient",
    sameAddress(prepared.review.recipient, args.walletAddress),
    "Prepared recipient does not match walletAddress",
    { recipient: prepared.review.recipient, walletAddress: args.walletAddress },
    { code: "PREPARED_RECIPIENT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_amount_in",
    prepared.review.amountIn === args.amountInRaw,
    "Prepared amountIn does not match requested amount",
    { preparedAmountIn: prepared.review.amountIn, requestedAmountRaw: args.amountInRaw },
    { code: "PREPARED_AMOUNT_IN_MISMATCH", stage: "policy" },
  );
  const methodValueWei = safeWei(prepared.methodParameters.value);
  requireCheck(
    policyChecks,
    reasons,
    "native_value",
    prepared.intent.valueWei === quote.valueWei &&
      prepared.intent.valueWei === (decodedIntent.nativeValueWei ?? "0") &&
      methodValueWei === quote.valueWei,
    "Prepared native value does not match retained quote and decoded calldata",
    {
      intentValueWei: prepared.intent.valueWei,
      quoteValueWei: quote.valueWei,
      decodedNativeValueWei: decodedIntent.nativeValueWei,
      methodValueWei,
    },
    { code: "NATIVE_VALUE_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "minimum_output_present",
    isPositiveIntegerString(prepared.review.amountOutMin),
    "Prepared quote does not contain a positive minimum output",
    { minimumOutputRaw: prepared.review.amountOutMin ?? null },
    { code: "MINIMUM_OUTPUT_MISSING", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "slippage_policy",
    quote.allowedSlippage <= args.maximumSlippagePercent,
    "Prepared quote slippage exceeds policy",
    { quoteSlippagePercent: quote.allowedSlippage, maximumSlippagePercent: args.maximumSlippagePercent },
    { code: "SLIPPAGE_POLICY_EXCEEDED", stage: "quote_batch" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "calldata_decodable",
    decodedIntent.decodable,
    decodedIntent.errors[0] ?? "Calldata is not decodable",
    { selector: decodedIntent.selector, errors: decodedIntent.errors },
    { code: "CALLDATA_NOT_DECODABLE", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "calldata_selector_allowlisted",
    decodedIntent.decodable &&
      decodedIntent.canonicalFunction === PITEAS_SWAP_CANONICAL_SIGNATURE,
    "Calldata selector is not explicitly allowlisted for PHIAT shadow buying",
    {
      selector: decodedIntent.selector,
      method: decodedIntent.method,
      canonicalFunction: decodedIntent.canonicalFunction,
    },
    { code: "CALLDATA_SELECTOR_NOT_ALLOWLISTED", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "no_hidden_approval",
    decodedIntent.method !== "approve" && decodedIntent.unlimitedApproval !== true,
    "Prepared swap calldata decodes as token approval or unlimited approval",
    { method: decodedIntent.method, unlimitedApproval: decodedIntent.unlimitedApproval ?? null },
    { code: "HIDDEN_APPROVAL_DETECTED", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "route_data_decodable",
    decodedIntent.routeData?.decodable === true,
    routeDataFailureMessage(decodedIntent.routeData?.status),
    {
      routeDataFingerprint: decodedIntent.routeDataFingerprint,
      validationErrors: decodedIntent.routeData?.validationErrors ?? decodedIntent.validationErrors,
      routeEnvelopeDecode: decodedIntent.routeData
        ? {
            status: decodedIntent.routeData.status ?? (decodedIntent.routeData.decodable ? "PASSED" : "FAILED"),
            consumedBytes: decodedIntent.routeData.consumedBytes ?? null,
            totalBytes: decodedIntent.routeData.totalBytes ?? null,
            trailingBytes: decodedIntent.routeData.trailingBytes ?? null,
            decoderVersion: decodedIntent.routeData.decoderVersion ?? null,
            managerHashBinding: decodedIntent.routeData.managerHashBinding ?? null,
          }
        : null,
    },
    { code: routeDataFailureCode(decodedIntent.routeData?.status), stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_token_in",
    sameAddress(decodedIntent.tokenIn, PHIAT_SHADOW_BUY_TOKEN_IN) &&
      sameAddress(decodedIntent.tokenIn, quote.srcToken.address),
    "Decoded tokenIn does not match verified eUSDC and retained quote",
    { decodedTokenIn: decodedIntent.tokenIn, quoteTokenIn: quote.srcToken.address },
    { code: "DECODED_TOKEN_IN_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_token_out",
    sameAddress(decodedIntent.tokenOut, PHIAT_SHADOW_BUY_TOKEN_OUT) &&
      sameAddress(decodedIntent.tokenOut, quote.destToken.address),
    "Decoded tokenOut does not match PHIAT and retained quote",
    { decodedTokenOut: decodedIntent.tokenOut, quoteTokenOut: quote.destToken.address },
    { code: "DECODED_TOKEN_OUT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_recipient",
    sameAddress(decodedIntent.recipient, args.walletAddress),
    "Decoded recipient does not match walletAddress",
    { decodedRecipient: decodedIntent.recipient, walletAddress: args.walletAddress },
    { code: "DECODED_RECIPIENT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_amount_in",
    decodedIntent.amountInRaw === args.amountInRaw && decodedIntent.amountInRaw === quote.amountIn,
    "Decoded amountIn does not match requested amount and retained quote",
    {
      decodedAmountInRaw: decodedIntent.amountInRaw,
      requestedAmountRaw: args.amountInRaw,
      quoteAmountInRaw: quote.amountIn,
    },
    { code: "DECODED_AMOUNT_IN_MISMATCH", stage: "policy" },
  );
  const minimumOutputValidation = evaluateMinimumOutputValidation({ quote, decodedIntent });
  decodedIntent.minimumOutputValidation = minimumOutputValidation;
  if (minimumOutputValidation.validationStatus === "PASSED") {
    passCheck(policyChecks, "decoded_minimum_output", minimumOutputValidation as unknown as Record<string, unknown>);
    if (minimumOutputValidation.relationship === "CALLDATA_STRICTER") {
      policyChecks.decoded_minimum_output_stricter = {
        status: "warning",
        reason: "Decoded calldata minimum output is stricter than the retained quote minimum.",
        details: minimumOutputValidation as unknown as Record<string, unknown>,
      };
    }
  } else {
    failCheck(
      policyChecks,
      reasons,
      "decoded_minimum_output",
      minimumOutputValidation.relationship === "CALLDATA_WEAKER"
        ? "Decoded minimum output is weaker than retained candidate quote minimum"
        : "Decoded minimum-output semantics are unresolved",
      minimumOutputValidation as unknown as Record<string, unknown>,
      {
        code:
          minimumOutputValidation.relationship === "CALLDATA_WEAKER"
            ? "MINIMUM_OUTPUT_CALLDATA_WEAKER"
            : "MINIMUM_OUTPUT_SEMANTICS_UNRESOLVED",
        stage: "policy",
      },
    );
  }
  const expectedOut = stringToBigInt(decodedIntent.routeExpectedOutputRaw);
  const quoteOut = stringToBigInt(quote.amountOut);
  requireCheck(
    policyChecks,
    reasons,
    "route_expected_output",
    expectedOut !== null && quoteOut !== null && expectedOut === quoteOut,
    "Route expected output does not exactly match retained candidate quote",
    {
      routeExpectedOutputRaw: decodedIntent.routeExpectedOutputRaw,
      candidateQuoteExpectedOutputRaw: quote.amountOut,
    },
    { code: "ROUTE_EXPECTED_OUTPUT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "route_destination_token",
    sameAddress(decodedIntent.routeData?.destinationToken, decodedIntent.tokenOut),
    "Route destination token does not match decoded output token",
    {
      routeDestinationToken: decodedIntent.routeData?.destinationToken ?? null,
      decodedTokenOut: decodedIntent.tokenOut,
    },
    { code: "ROUTE_DESTINATION_TOKEN_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "calldata_fingerprint_binding",
    decodedIntent.calldataFingerprint === fingerprint(prepared.intent.data) &&
      prepared.intent.data === quote.methodParameters.calldata,
    "Prepared calldata does not match retained candidate quote calldata",
    {
      decodedCalldataFingerprint: decodedIntent.calldataFingerprint,
      preparedCalldataFingerprint: fingerprint(prepared.intent.data),
      quoteCalldataFingerprint: fingerprint(quote.methodParameters.calldata),
    },
    { code: "CALLDATA_FINGERPRINT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "method_parameter_fingerprint_binding",
    fingerprint(prepared.methodParameters) === fingerprint(quote.methodParameters),
    "Prepared method parameters do not match retained candidate quote method parameters",
    {
      preparedMethodParametersFingerprint: fingerprint(prepared.methodParameters),
      quoteMethodParametersFingerprint: fingerprint(quote.methodParameters),
    },
    { code: "METHOD_PARAMETER_FINGERPRINT_MISMATCH", stage: "policy" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "expiry_binding",
    quote.expiresAt === null ||
      decodedIntent.deadline === null ||
      parseTimestampMs(quote.expiresAt) === parseTimestampMs(decodedIntent.deadline),
    "Decoded route deadline does not match retained candidate quote expiry",
    {
      decodedDeadline: decodedIntent.deadline,
      candidateQuoteExpiry: quote.expiresAt,
    },
    { code: "EXPIRY_MISMATCH", stage: "policy" },
  );
  passCheck(policyChecks, "decoded_expected_output_constraint", {
    decodedExpectedOutputRaw: decodedIntent.decodedExpectedOutputRaw ?? null,
    candidateQuoteExpectedOutputRaw: quote.amountOut,
    note: "Supported swap calldata encodes minimum-output protection; expected output is retained from the exact candidate quote.",
  });
}

type RouteDataStatus = NonNullable<DecodedIntent["routeData"]>["status"];

function routeDataFailureCode(status: RouteDataStatus): string {
  if (status === "UNSUPPORTED_VERSION") return "ROUTE_ENVELOPE_UNSUPPORTED";
  if (status === "PARTIAL") return "ROUTE_ENVELOPE_MALFORMED";
  if (status === "MALFORMED") return "ROUTE_ENVELOPE_MALFORMED";
  return "ROUTE_ENVELOPE_MALFORMED";
}

function routeDataFailureMessage(status: RouteDataStatus): string {
  if (status === "UNSUPPORTED_VERSION") return "Piteas route data envelope version is unsupported";
  if (status === "PARTIAL") return "Piteas route data envelope was only partially decoded";
  return "Piteas route data envelope is malformed";
}
