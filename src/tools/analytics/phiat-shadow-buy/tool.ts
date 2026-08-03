import type { McpServer } from "@modelcontextprotocol/server";
import { formatUnits } from "viem";
import { isAddress, assertAddress } from "../../../utils/safety.js";
import { ok } from "../../../utils/result.js";
import type { AppConfig } from "../../../types.js";
import { estimateGas, ethCall, getFeeData, getPiteasQuote, preparePiteasSwap, reservePiteasRateLimitSlots } from "../../../data/index.js";
import { registerTool } from "../../define.js";
import { buildPhiatDashboard } from "../phiatDashboard.js";
import { phiatShadowBuyInputSchema } from "./schema.js";
import { DEFAULT_ANALYTICAL_THRESHOLD_PERCENT, DEFAULT_GAS_SAFETY_FACTOR, DEFAULT_MAX_QUOTE_AGE_MS, DEFAULT_OPERATIONAL_THRESHOLD_PERCENT, DEFAULT_REFERENCE_AMOUNT_HUMAN, DEFAULT_REFERENCE_DRIFT_PERCENT, DEFAULT_SLIPPAGE_PERCENT, EUSDC_DECIMALS, PHIAT_SHADOW_BUY_TOKEN_IN, SHADOW_PITEAS_REQUEST_COUNT } from "./constants.js";
import type { PhiatShadowBuyCertificate, PhiatShadowBuyDeps, PhiatShadowBuyInput, Decision, PolicyCheck } from "./types.js";
import { readEusdcAllowance, readAllowance } from "./allowance.js";
import { readEusdcBalance, readNativeBalance, readBalances } from "./balances.js";
import { readRouterIntegrity, validateRouterIntegrity } from "./routerIntegrity.js";
import { emptyAllowance, emptyApprovalIntent, emptyBalances, emptyExecutionTargets, emptyGasPolicy, emptyRouterIntegrity, emptySimulation, buildCertificate, sanitizeQuote } from "./certificate.js";
import { failCheck, hasFailures, passCheck, requireCheck, warnCheck } from "./policyEvaluation.js";
import { parseHumanUnitsStrict, quoteFingerprint, fingerprint, isPositiveIntegerString } from "./inputNormalization.js";
import { readMarketContext, requestShadowQuote, analyzeQuoteFreshness } from "./exactAmountSandwich.js";
import { calculateCandidateDeteriorationPercent, calculateReferenceDriftPercent } from "./deterioration.js";
import { bindCandidateQuote, buildPreparedIntent } from "./quoteBinding.js";
import { decodeShadowBuyCalldata } from "./calldataDecode.js";
import { validatePreparedAndDecodedIntent } from "./quoteValidation.js";
import { buildExecutionTargets, validateExecutionTargets } from "./executionTargets.js";
import { buildApprovalIntent } from "./approvalIntent.js";
import { simulateTransaction } from "./simulation.js";
import { buildGasPolicy } from "./gasPolicy.js";

const defaultDeps: PhiatShadowBuyDeps = {
  buildPhiatDashboard,
  getPiteasQuote,
  preparePiteasSwap,
  ethCall,
  estimateGas,
  getFeeData,
  reservePiteasRateLimitSlots,
  getAllowance: readEusdcAllowance,
  getInputBalance: readEusdcBalance,
  getNativeBalanceWei: readNativeBalance,
  getRouterIntegrity: readRouterIntegrity,
};

export async function buildPhiatShadowBuy(
  config: AppConfig,
  input: PhiatShadowBuyInput,
  deps: PhiatShadowBuyDeps = defaultDeps,
): Promise<PhiatShadowBuyCertificate> {
  const reasons: string[] = [];
  const policyChecks: Record<string, PolicyCheck> = {};
  const now = () => deps.nowMs?.() ?? Date.now();
  const startedMs = now();
  const maximumQuoteAgeMs = input.maximumQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const deadlineMs = startedMs + maximumQuoteAgeMs;
  const analyticalThresholdPercent =
    input.analyticalThresholdPercent ?? DEFAULT_ANALYTICAL_THRESHOLD_PERCENT;
  const operationalThresholdPercent =
    input.operationalThresholdPercent ?? DEFAULT_OPERATIONAL_THRESHOLD_PERCENT;
  const maximumReferenceDriftPercent =
    input.maximumReferenceDriftPercent ?? DEFAULT_REFERENCE_DRIFT_PERCENT;
  const maximumSlippagePercent =
    input.maximumSlippagePercent ?? DEFAULT_SLIPPAGE_PERCENT;
  const referenceAmountHuman =
    input.referenceAmountHuman ?? DEFAULT_REFERENCE_AMOUNT_HUMAN;
  const gasSafetyFactor = input.gasSafetyFactor ?? DEFAULT_GAS_SAFETY_FACTOR;
  const approvedRouterCodeHashes = (input.approvedRouterCodeHashes ?? []).map((h) =>
    h.toLowerCase(),
  );

  const simulation = emptySimulation();
  const balances = emptyBalances(input.walletAddress);
  const allowance = emptyAllowance(input.walletAddress, "0");
  const approvalIntent = emptyApprovalIntent();
  const routerIntegrity = emptyRouterIntegrity();
  const executionTargets = emptyExecutionTargets();
  const gasPolicy = emptyGasPolicy(gasSafetyFactor, input.maximumGasPls);

  if (!isAddress(input.walletAddress)) {
    failCheck(policyChecks, reasons, "wallet_address", "Invalid walletAddress");
    return buildCertificate({
      decision: "REJECT",
      reasons,
      marketContext: {},
      exactAmountEvidence: {},
      rateLimitBudget: null,
      balances,
      allowance,
      approvalIntent,
      routerIntegrity,
      executionTargets,
      simulation,
      gasPolicy,
      policyChecks,
    });
  }

  const walletAddress = assertAddress(input.walletAddress).toLowerCase();
  balances.walletAddress = walletAddress;
  allowance.owner = walletAddress;
  const amountInRawBig = parseHumanUnitsStrict(input.amountInHuman, EUSDC_DECIMALS);
  const referenceRawBig = parseHumanUnitsStrict(referenceAmountHuman, EUSDC_DECIMALS);
  if (amountInRawBig === null || amountInRawBig <= 0n) {
    failCheck(
      policyChecks,
      reasons,
      "amount_in",
      "amountInHuman must be a positive exact eUSDC decimal amount",
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      marketContext: {},
      exactAmountEvidence: {},
      rateLimitBudget: null,
      balances,
      allowance: { ...allowance, requiredAmountRaw: "0" },
      approvalIntent,
      routerIntegrity,
      executionTargets,
      simulation,
      gasPolicy,
      policyChecks,
    });
  }
  if (referenceRawBig === null || referenceRawBig <= 0n) {
    failCheck(
      policyChecks,
      reasons,
      "reference_amount",
      "referenceAmountHuman must be a positive exact eUSDC decimal amount",
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      marketContext: {},
      exactAmountEvidence: {},
      rateLimitBudget: null,
      balances,
      allowance: { ...allowance, requiredAmountRaw: amountInRawBig.toString() },
      approvalIntent,
      routerIntegrity,
      executionTargets,
      simulation,
      gasPolicy,
      policyChecks,
    });
  }

  const amountInRaw = amountInRawBig.toString();
  const amountInHuman = formatUnits(amountInRawBig, EUSDC_DECIMALS);
  const referenceRaw = referenceRawBig.toString();
  const exactAmountEvidence: Record<string, unknown> = {
    amountInHuman,
    amountInRaw,
    referenceAmountHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
    referenceAmountRaw: referenceRaw,
    analyticalThresholdPercent,
    operationalThresholdPercent,
    maximumReferenceDriftPercent,
    maximumSlippagePercent,
    maximumQuoteAgeMs,
    piteasRequestCountRequired: SHADOW_PITEAS_REQUEST_COUNT,
    warning:
      "This is a shadow-execution certificate only. It is not a signed transaction and is not reusable after any approval or market-state change.",
  };

  const rateLimitBudget = deps.reservePiteasRateLimitSlots(
    SHADOW_PITEAS_REQUEST_COUNT,
    startedMs,
  );
  if (!rateLimitBudget.ok) {
    failCheck(
      policyChecks,
      reasons,
      "piteas_rate_limit",
      "RATE_LIMIT_REQUOTE_REQUIRED",
      rateLimitBudget as unknown as Record<string, unknown>,
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      marketContext: {},
      exactAmountEvidence,
      rateLimitBudget,
      balances,
      allowance: { ...allowance, requiredAmountRaw: amountInRaw },
      approvalIntent,
      routerIntegrity,
      executionTargets,
      simulation,
      gasPolicy,
      policyChecks,
    });
  }
  passCheck(policyChecks, "piteas_rate_limit", {
    reserved: SHADOW_PITEAS_REQUEST_COUNT,
    remaining: rateLimitBudget.remaining,
    resetAt: rateLimitBudget.resetAt,
  });

  const marketContext = await readMarketContext(config, deps);

  const referenceBefore = await requestShadowQuote({
    config,
    deps,
    label: "reference_before",
    inputRaw: referenceRaw,
    inputHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
    account: null,
    maximumSlippagePercent,
    deadlineMs,
  });
  const candidateQuote = await requestShadowQuote({
    config,
    deps,
    label: "candidate",
    inputRaw: amountInRaw,
    inputHuman: amountInHuman,
    account: walletAddress,
    maximumSlippagePercent,
    deadlineMs,
  });
  const referenceAfter = await requestShadowQuote({
    config,
    deps,
    label: "reference_after",
    inputRaw: referenceRaw,
    inputHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
    account: null,
    maximumSlippagePercent,
    deadlineMs,
  });

  const batchCompletedMs = now();
  const batchDurationMs = batchCompletedMs - startedMs;
  const quoteFreshness = analyzeQuoteFreshness({
    referenceBefore,
    candidateQuote,
    referenceAfter,
    startedMs,
    completedMs: batchCompletedMs,
    deadlineMs,
    maximumQuoteAgeMs,
  });
  exactAmountEvidence.batchStartedAt = new Date(startedMs).toISOString();
  exactAmountEvidence.batchCompletedAt = new Date(batchCompletedMs).toISOString();
  exactAmountEvidence.batchDurationMs = batchDurationMs;

  const referenceDriftPercent =
    referenceBefore.data && referenceAfter.data
      ? calculateReferenceDriftPercent(referenceBefore.data, referenceAfter.data)
      : null;
  const candidateDeteriorationPercent =
    referenceBefore.data && candidateQuote.data && referenceAfter.data
      ? calculateCandidateDeteriorationPercent(
          referenceBefore.data,
          candidateQuote.data,
          referenceAfter.data,
        )
      : null;

  requireCheck(
    policyChecks,
    reasons,
    "reference_before_quote",
    referenceBefore.ok,
    "Reference-before Piteas quote failed",
    sanitizeQuote(referenceBefore) ?? undefined,
  );
  requireCheck(
    policyChecks,
    reasons,
    "candidate_quote",
    candidateQuote.ok,
    "Exact requested-amount Piteas quote failed",
    sanitizeQuote(candidateQuote) ?? undefined,
  );
  requireCheck(
    policyChecks,
    reasons,
    "reference_after_quote",
    referenceAfter.ok,
    "Reference-after Piteas quote failed",
    sanitizeQuote(referenceAfter) ?? undefined,
  );
  requireCheck(
    policyChecks,
    reasons,
    "batch_deadline",
    batchDurationMs <= maximumQuoteAgeMs,
    "Exact shadow-buy quote batch exceeded the configured deadline",
    { batchDurationMs, maximumQuoteAgeMs },
  );
  requireCheck(
    policyChecks,
    reasons,
    "quote_freshness",
    quoteFreshness.referenceBeforeAcceptable &&
      quoteFreshness.candidateAcceptable &&
      quoteFreshness.referenceAfterAcceptable,
    quoteFreshness.reason ?? "One or more quotes are stale or expired",
    quoteFreshness as unknown as Record<string, unknown>,
  );
  requireCheck(
    policyChecks,
    reasons,
    "reference_cache",
    !quoteFreshness.possibleCacheDetected,
    "Unresolved possible-cache concern between reference quotes",
    quoteFreshness as unknown as Record<string, unknown>,
  );
  requireCheck(
    policyChecks,
    reasons,
    "reference_drift",
    referenceDriftPercent !== null &&
      referenceDriftPercent <= maximumReferenceDriftPercent,
    "Reference drift exceeds policy or is unavailable",
    { referenceDriftPercent, maximumReferenceDriftPercent },
  );
  requireCheck(
    policyChecks,
    reasons,
    "candidate_deterioration",
    candidateDeteriorationPercent !== null &&
      candidateDeteriorationPercent <= operationalThresholdPercent,
    "Exact requested amount exceeds the operational deterioration threshold",
    { candidateDeteriorationPercent, operationalThresholdPercent },
  );
  requireCheck(
    policyChecks,
    reasons,
    "candidate_positive_output",
    candidateQuote.data !== undefined &&
      isPositiveIntegerString(candidateQuote.data.amountOut) &&
      isPositiveIntegerString(candidateQuote.data.amountOutMin),
    "Candidate quote output or minimum output is unavailable or non-positive",
    {
      amountOut: candidateQuote.data?.amountOut ?? null,
      amountOutMin: candidateQuote.data?.amountOutMin ?? null,
    },
  );

  if (!candidateQuote.data) {
    return buildCertificate({
      decision: "REJECT",
      reasons,
      marketContext,
      exactAmountEvidence,
      referenceBefore,
      candidateQuote,
      referenceAfter,
      referenceDriftPercent,
      candidateDeteriorationPercent,
      quoteFreshness,
      rateLimitBudget,
      balances,
      allowance: { ...allowance, requiredAmountRaw: amountInRaw },
      approvalIntent,
      routerIntegrity,
      executionTargets,
      simulation,
      gasPolicy,
      policyChecks,
    });
  }

  const binding = bindCandidateQuote(candidateQuote);
  Object.assign(exactAmountEvidence, binding);

  const prepared = deps.preparePiteasSwap(candidateQuote.data, {
    account: walletAddress,
  });
  if (!prepared.ok) {
    failCheck(
      policyChecks,
      reasons,
      "prepare_intent",
      `Piteas transaction preparation failed: ${prepared.reason}`,
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      marketContext,
      exactAmountEvidence,
      referenceBefore,
      candidateQuote,
      referenceAfter,
      referenceDriftPercent,
      candidateDeteriorationPercent,
      quoteFreshness,
      rateLimitBudget,
      balances,
      allowance: { ...allowance, requiredAmountRaw: amountInRaw },
      approvalIntent,
      routerIntegrity,
      executionTargets,
      simulation,
      gasPolicy,
      policyChecks,
    });
  }

  const preparedIntent = buildPreparedIntent(
    candidateQuote.data,
    prepared,
    amountInHuman,
  );
  const preparedMethodFingerprint = fingerprint(prepared.methodParameters);
  requireCheck(
    policyChecks,
    reasons,
    "candidate_quote_binding",
    binding.candidateQuoteFingerprint === quoteFingerprint(candidateQuote.data) &&
      binding.candidateMethodParametersFingerprint === preparedMethodFingerprint &&
      prepared.intent.data === candidateQuote.data.methodParameters.calldata,
    "Prepared intent did not derive from the retained exact candidate quote",
    {
      candidateQuoteFingerprint: binding.candidateQuoteFingerprint,
      candidateMethodParametersFingerprint: binding.candidateMethodParametersFingerprint,
      preparedMethodParametersFingerprint: preparedMethodFingerprint,
    },
  );

  const decodedIntent = decodeShadowBuyCalldata(prepared.intent.data);
  validatePreparedAndDecodedIntent({
    policyChecks,
    reasons,
    quote: candidateQuote.data,
    prepared,
    decodedIntent,
    walletAddress,
    amountInRaw,
    maximumSlippagePercent,
  });

  const routerReport = await deps.getRouterIntegrity(
    config,
    prepared.intent.to,
    approvedRouterCodeHashes,
  );
  validateRouterIntegrity(policyChecks, reasons, routerReport);
  const executionTargetReport = buildExecutionTargets(
    routerReport,
    decodedIntent,
  );
  validateExecutionTargets(policyChecks, reasons, executionTargetReport);

  const balanceReport = await readBalances({
    config,
    deps,
    walletAddress,
    amountInRaw,
  });
  Object.assign(balances, balanceReport);
  requireCheck(
    policyChecks,
    reasons,
    "input_balance",
    balances.inputBalanceSufficient === true,
    "INSUFFICIENT_INPUT_BALANCE",
    balances as unknown as Record<string, unknown>,
  );

  const allowanceReport = await readAllowance({
    config,
    deps,
    owner: walletAddress,
    spender: prepared.intent.to,
    requiredAmountRaw: amountInRaw,
  });
  Object.assign(allowance, allowanceReport);
  const allowanceInsufficient = allowance.sufficient === false;
  if (allowance.sufficient === true) {
    passCheck(policyChecks, "allowance", {
      allowanceRaw: allowance.allowanceRaw,
      requiredAmountRaw: amountInRaw,
    });
  } else if (allowanceInsufficient) {
    warnCheck(policyChecks, "allowance", "INSUFFICIENT_ALLOWANCE", {
      allowanceRaw: allowance.allowanceRaw,
      requiredAmountRaw: amountInRaw,
    });
  } else {
    failCheck(policyChecks, reasons, "allowance", "Allowance is unavailable", {
      error: allowance.error,
    });
  }

  const candidateGasUseEstimate = candidateQuote.data.gasUseEstimate;
  const quoteGasEstimate =
    typeof candidateGasUseEstimate === "number" &&
    Number.isSafeInteger(candidateGasUseEstimate) &&
    candidateGasUseEstimate > 0
      ? String(candidateGasUseEstimate)
      : null;

  let approval = approvalIntent;
  if (allowanceInsufficient) {
    const gasReport = await buildGasPolicy({
      config,
      deps,
      gasEstimate: quoteGasEstimate,
      nativeBalanceWei: balances.nativeBalanceWei,
      maximumGasPls: input.maximumGasPls,
      gasSafetyFactor,
    });
    Object.assign(gasPolicy, gasReport);
    balances.gasBalanceSufficient = gasPolicy.nativeBalanceCoversSafetyAdjustedGas;
    requireCheck(
      policyChecks,
      reasons,
      "quote_gas_estimate",
      quoteGasEstimate !== null,
      "Retained candidate quote does not contain a usable positive gas estimate",
      { gasUseEstimate: candidateQuote.data.gasUseEstimate ?? null },
    );
    requireCheck(
      policyChecks,
      reasons,
      "gas_balance",
      gasPolicy.nativeBalanceCoversSafetyAdjustedGas === true,
      "INSUFFICIENT_GAS_BALANCE",
      gasPolicy as unknown as Record<string, unknown>,
    );
    if (input.maximumGasPls !== undefined) {
      requireCheck(
        policyChecks,
        reasons,
        "maximum_gas_pls",
        gasPolicy.withinMaximumGasPolicy === true,
        "Estimated gas cost exceeds maximumGasPls policy",
        gasPolicy as unknown as Record<string, unknown>,
      );
    }
  }

  if (allowanceInsufficient && !hasFailures(policyChecks)) {
    approval = buildApprovalIntent(prepared.intent.to, amountInRaw);
    const approvalSimulation = await simulateTransaction({
      config,
      deps,
      to: PHIAT_SHADOW_BUY_TOKEN_IN,
      from: walletAddress,
      data: approval.calldata!,
      value: "0",
    });
    approval.simulation = approvalSimulation;
    simulation.approval = approvalSimulation;
    if (!approvalSimulation.ethCallOk || !approvalSimulation.estimateGasOk) {
      failCheck(
        policyChecks,
        reasons,
        "approval_simulation",
        "Approval simulation failed",
        approvalSimulation as unknown as Record<string, unknown>,
      );
    } else {
      passCheck(policyChecks, "approval_simulation", {
        gasEstimate: approvalSimulation.gasEstimate,
      });
    }
  } else if (allowanceInsufficient) {
    approval = {
      ...approvalIntent,
      status: "UNAVAILABLE",
      spender: prepared.intent.to,
      error: "Approval intent withheld because mandatory shadow-buy checks failed.",
    };
  }

  if (!allowanceInsufficient && !hasFailures(policyChecks)) {
    const swapSimulation = await simulateTransaction({
      config,
      deps,
      to: prepared.intent.to,
      from: walletAddress,
      data: prepared.intent.data,
      value: prepared.intent.valueWei,
    });
    simulation.swap = swapSimulation;
    requireCheck(
      policyChecks,
      reasons,
      "eth_call",
      swapSimulation.ethCallOk,
      "Simulation reverted",
      swapSimulation as unknown as Record<string, unknown>,
    );
    requireCheck(
      policyChecks,
      reasons,
      "estimate_gas",
      swapSimulation.estimateGasOk,
      "Gas cannot be estimated",
      swapSimulation as unknown as Record<string, unknown>,
    );
  }

  if (!allowanceInsufficient && simulation.swap.estimateGasOk) {
    const gasReport = await buildGasPolicy({
      config,
      deps,
      gasEstimate: simulation.swap.gasEstimate,
      nativeBalanceWei: balances.nativeBalanceWei,
      maximumGasPls: input.maximumGasPls,
      gasSafetyFactor,
    });
    Object.assign(gasPolicy, gasReport);
    balances.gasBalanceSufficient = gasPolicy.nativeBalanceCoversSafetyAdjustedGas;
    requireCheck(
      policyChecks,
      reasons,
      "gas_balance",
      gasPolicy.nativeBalanceCoversSafetyAdjustedGas === true,
      "INSUFFICIENT_GAS_BALANCE",
      gasPolicy as unknown as Record<string, unknown>,
    );
    if (input.maximumGasPls !== undefined) {
      requireCheck(
        policyChecks,
        reasons,
        "maximum_gas_pls",
        gasPolicy.withinMaximumGasPolicy === true,
        "Estimated gas cost exceeds maximumGasPls policy",
        gasPolicy as unknown as Record<string, unknown>,
      );
    }
  }

  const automaticExecutionEligible =
    !hasFailures(policyChecks) &&
    !allowanceInsufficient &&
    routerReport.routerCodeHashApproved === true &&
    routerReport.codeHashAgreement !== "disagrees" &&
    executionTargetReport.unresolvedExecutionTargets.length === 0;
  const decision: Decision = hasFailures(policyChecks)
    ? "REJECT"
    : allowanceInsufficient
      ? "NEEDS_APPROVAL"
      : "WOULD_BUY";
  const finalReasons =
    decision === "WOULD_BUY"
      ? [
          automaticExecutionEligible
            ? "All shadow-buy checks passed; no signing or broadcast was performed."
            : "Shadow-buy checks passed, but automatic execution is not eligible until router code hash and targets are operator-approved.",
        ]
      : decision === "NEEDS_APPROVAL"
        ? [
            "INSUFFICIENT_ALLOWANCE",
            "Approval is required before any swap could be reconsidered.",
            "The current swap evidence is invalid after approval; run phiat_shadow_buy again after approval confirmation.",
          ]
        : reasons;

  return buildCertificate({
    decision,
    reasons: finalReasons,
    marketContext,
    exactAmountEvidence,
    referenceBefore,
    candidateQuote,
    referenceAfter,
    referenceDriftPercent,
    candidateDeteriorationPercent,
    quoteFreshness,
    rateLimitBudget,
    balances,
    allowance,
    approvalIntent: approval,
    routerIntegrity: routerReport,
    executionTargets: executionTargetReport,
    preparedIntent,
    decodedIntent,
    simulation,
    gasPolicy,
    policyChecks,
    automaticExecutionEligible,
    swapEvidenceInvalidAfterApproval: decision === "NEEDS_APPROVAL",
    transactionPrepared: true,
  });
}

export function registerPhiatShadowBuyTool(
  server: McpServer,
  config: AppConfig,
  deps: PhiatShadowBuyDeps = defaultDeps,
): void {
  registerTool(server, config, {
    name: "phiat_shadow_buy",
    description:
      "Research-only exact-amount PHIAT shadow buyer. Reserves a three-quote Piteas sandwich, prepares one unsigned candidate intent, decodes, validates, and simulates with eth_call/estimateGas. Never signs, submits, broadcasts, executes, or accesses wallet secrets.",
    category: "analytics",
    inputSchema: phiatShadowBuyInputSchema,
    write: false,
    handler: async (args, cfg) =>
      ok(await buildPhiatShadowBuy(cfg, args as unknown as PhiatShadowBuyInput, deps)),
  });
}
