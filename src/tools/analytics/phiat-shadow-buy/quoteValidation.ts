import { PULSECHAIN_CHAIN_ID } from "../../../constants.js";
import { type PiteasPrepareResult, type PiteasQuoteData } from "../../../data/index.js";
import { PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT, PITEAS_ROUTER } from "./constants.js";
import type { DecodedIntent, PolicyCheck } from "./types.js";
import { passCheck, requireCheck } from "./policyEvaluation.js";
import { isPositiveIntegerString, safeWei, sameAddress, stringToBigInt } from "./inputNormalization.js";

export function validatePreparedAndDecodedIntent(args: {
  policyChecks: Record<string, PolicyCheck>;
  reasons: string[];
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
  );
  requireCheck(
    policyChecks,
    reasons,
    "transaction_to_router",
    sameAddress(prepared.intent.to, PITEAS_ROUTER),
    "Prepared transaction target is not the official Piteas router",
    { to: prepared.intent.to, officialRouter: PITEAS_ROUTER },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_token_in",
    sameAddress(prepared.review.tokenIn, PHIAT_SHADOW_BUY_TOKEN_IN),
    "Prepared tokenIn is not verified eUSDC",
    { tokenIn: prepared.review.tokenIn },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_token_out",
    sameAddress(prepared.review.tokenOut, PHIAT_SHADOW_BUY_TOKEN_OUT),
    "Prepared tokenOut is not PHIAT",
    { tokenOut: prepared.review.tokenOut },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_recipient",
    sameAddress(prepared.review.recipient, args.walletAddress),
    "Prepared recipient does not match walletAddress",
    { recipient: prepared.review.recipient, walletAddress: args.walletAddress },
  );
  requireCheck(
    policyChecks,
    reasons,
    "prepared_amount_in",
    prepared.review.amountIn === args.amountInRaw,
    "Prepared amountIn does not match requested amount",
    { preparedAmountIn: prepared.review.amountIn, requestedAmountRaw: args.amountInRaw },
  );
  const methodValueWei = safeWei(prepared.methodParameters.value);
  requireCheck(
    policyChecks,
    reasons,
    "native_value",
    prepared.intent.valueWei === "0" && quote.valueWei === "0" && methodValueWei === "0",
    "Prepared transaction includes unexpected native value for eUSDC input",
    { intentValueWei: prepared.intent.valueWei, quoteValueWei: quote.valueWei, methodValueWei },
  );
  requireCheck(
    policyChecks,
    reasons,
    "minimum_output_present",
    isPositiveIntegerString(prepared.review.amountOutMin),
    "Prepared quote does not contain a positive minimum output",
    { minimumOutputRaw: prepared.review.amountOutMin ?? null },
  );
  requireCheck(
    policyChecks,
    reasons,
    "slippage_policy",
    quote.allowedSlippage <= args.maximumSlippagePercent,
    "Prepared quote slippage exceeds policy",
    { quoteSlippagePercent: quote.allowedSlippage, maximumSlippagePercent: args.maximumSlippagePercent },
  );
  requireCheck(
    policyChecks,
    reasons,
    "calldata_decodable",
    decodedIntent.decodable,
    decodedIntent.errors[0] ?? "Calldata is not decodable",
    { selector: decodedIntent.selector, errors: decodedIntent.errors },
  );
  requireCheck(
    policyChecks,
    reasons,
    "calldata_selector_allowlisted",
    decodedIntent.decodable && decodedIntent.method !== "approve",
    "Calldata selector is not explicitly allowlisted for PHIAT shadow buying",
    { selector: decodedIntent.selector, method: decodedIntent.method },
  );
  requireCheck(
    policyChecks,
    reasons,
    "no_hidden_approval",
    decodedIntent.method !== "approve" && decodedIntent.unlimitedApproval !== true,
    "Prepared swap calldata decodes as token approval or unlimited approval",
    { method: decodedIntent.method, unlimitedApproval: decodedIntent.unlimitedApproval ?? null },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_token_in",
    sameAddress(decodedIntent.tokenIn, PHIAT_SHADOW_BUY_TOKEN_IN),
    "Decoded tokenIn is not verified eUSDC",
    { decodedTokenIn: decodedIntent.tokenIn },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_token_out",
    sameAddress(decodedIntent.tokenOut, PHIAT_SHADOW_BUY_TOKEN_OUT),
    "Decoded tokenOut is not PHIAT",
    { decodedTokenOut: decodedIntent.tokenOut },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_recipient",
    sameAddress(decodedIntent.recipient, args.walletAddress),
    "Decoded recipient does not match walletAddress",
    { decodedRecipient: decodedIntent.recipient, walletAddress: args.walletAddress },
  );
  requireCheck(
    policyChecks,
    reasons,
    "decoded_amount_in",
    decodedIntent.amountInRaw === args.amountInRaw,
    "Decoded amountIn does not match requested amount",
    { decodedAmountInRaw: decodedIntent.amountInRaw, requestedAmountRaw: args.amountInRaw },
  );
  const decodedMin = stringToBigInt(decodedIntent.minimumAmountOutRaw);
  const quoteMin = stringToBigInt(quote.amountOutMin);
  requireCheck(
    policyChecks,
    reasons,
    "decoded_minimum_output",
    decodedMin !== null && quoteMin !== null && decodedMin >= quoteMin,
    "Decoded minimum output is below retained candidate quote minimum",
    { decodedMinimumOutputRaw: decodedIntent.minimumAmountOutRaw, candidateQuoteMinimumOutputRaw: quote.amountOutMin ?? null },
  );
  passCheck(policyChecks, "decoded_expected_output_constraint", {
    decodedExpectedOutputRaw: decodedIntent.decodedExpectedOutputRaw ?? null,
    candidateQuoteExpectedOutputRaw: quote.amountOut,
    note: "Supported swap calldata encodes minimum-output protection; expected output is retained from the exact candidate quote.",
  });
}
