import type { McpServer } from "@modelcontextprotocol/server";
import { formatUnits } from "viem";
import { isAddress, assertAddress } from "../../../utils/safety.js";
import { ok } from "../../../utils/result.js";
import type { AppConfig } from "../../../types.js";
import { estimateGas, ethCall, getFeeData, getPiteasQuote, preparePiteasSwap, reservePiteasRateLimitSlots } from "../../../data/index.js";
import { registerTool } from "../../define.js";
import { buildPhiatDashboard } from "../phiatDashboard.js";
import { phiatShadowBuyInputSchema } from "./schema.js";
import { DEFAULT_ANALYTICAL_THRESHOLD_PERCENT, DEFAULT_GAS_SAFETY_FACTOR, DEFAULT_MAX_BATCH_DURATION_MS, DEFAULT_MAX_QUOTE_AGE_MS, DEFAULT_OPERATIONAL_THRESHOLD_PERCENT, DEFAULT_REFERENCE_AMOUNT_HUMAN, DEFAULT_REFERENCE_DRIFT_PERCENT, DEFAULT_SLIPPAGE_PERCENT, EUSDC_DECIMALS, MARKET_CONTEXT_TIMEOUT_MS, MAX_BATCH_DURATION_MS, MINIMUM_VIABLE_PITEAS_REQUEST_TIMEOUT_MS, PHIAT_SHADOW_BUY_TOKEN_IN, PITEAS_PER_REQUEST_TIMEOUT_MS, POST_CANDIDATE_VALIDATION_RESERVE_MS, REFERENCE_AFTER_RESERVE_MS, SHADOW_PITEAS_REQUEST_COUNT } from "./constants.js";
import type { PhiatShadowBuyCertificate, PhiatShadowBuyDeps, PhiatShadowBuyInput, Decision, PolicyCheck, ShadowBuyReason, QuoteBatchStatus, AllowanceStatus, ApprovalStatus, RouterIntegrityStatus, SimulationStatus, ShadowQuoteSummary, QuoteFreshness, CandidateFreshness } from "./types.js";
import { readEusdcAllowance, readAllowance } from "./allowance.js";
import { readEusdcBalance, readNativeBalance, readBalances } from "./balances.js";
import { readRouterIntegrity, validateRouterIntegrity } from "./routerIntegrity.js";
import { emptyAllowance, emptyApprovalIntent, emptyBalances, emptyExecutionTargets, emptyGasPolicy, emptyRouterIntegrity, emptySimulation, buildCertificate, sanitizeQuote } from "./certificate.js";
import { failCheck, hasFailures, passCheck, requireCheck, warnCheck } from "./policyEvaluation.js";
import { parseHumanUnitsStrict, quoteFingerprint, fingerprint, isPositiveIntegerString, parseTimestampMs } from "./inputNormalization.js";
import { readMarketContext, requestShadowQuote, analyzeQuoteFreshness, skippedQuoteSummary } from "./exactAmountSandwich.js";
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
  const reasons: ShadowBuyReason[] = [];
  const policyChecks: Record<string, PolicyCheck> = {};
  const now = () => deps.nowMs?.() ?? Date.now();
  const maximumQuoteAgeMs = input.maximumQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const maximumBatchDurationMs = Math.min(
    input.maximumBatchDurationMs ?? DEFAULT_MAX_BATCH_DURATION_MS,
    MAX_BATCH_DURATION_MS,
  );
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
  let quoteBatchStatus: QuoteBatchStatus = "DEADLINE_INSUFFICIENT";
  let allowanceStatus: AllowanceStatus = "NOT_EVALUATED";
  let approvalStatus: ApprovalStatus = "NOT_EVALUATED";
  let routerIntegrityStatus: RouterIntegrityStatus = "NOT_EVALUATED";
  let simulationStatus: SimulationStatus = "NOT_RUN";

  if (!isAddress(input.walletAddress)) {
    failCheck(policyChecks, reasons, "wallet_address", "Invalid walletAddress", undefined, {
      code: "INVALID_WALLET_ADDRESS",
      stage: "input_validation",
    });
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
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
      undefined,
      { code: "INVALID_AMOUNT_IN", stage: "input_validation" },
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
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
      undefined,
      { code: "INVALID_REFERENCE_AMOUNT", stage: "input_validation" },
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
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
    maximumBatchDurationMs,
    marketContextTimeoutMs: MARKET_CONTEXT_TIMEOUT_MS,
    piteasPerRequestTimeoutMs: PITEAS_PER_REQUEST_TIMEOUT_MS,
    referenceAfterReserveMs: REFERENCE_AFTER_RESERVE_MS,
    postCandidateValidationReserveMs: POST_CANDIDATE_VALIDATION_RESERVE_MS,
    minimumViablePiteasRequestTimeoutMs: MINIMUM_VIABLE_PITEAS_REQUEST_TIMEOUT_MS,
    piteasRequestCountRequired: SHADOW_PITEAS_REQUEST_COUNT,
    piteasRequestCountAttempted: 0,
    warning:
      "This is a shadow-execution certificate only. It is not a signed transaction and is not reusable after any approval or market-state change.",
  };

  const marketContext = await readMarketContext(config, deps, MARKET_CONTEXT_TIMEOUT_MS);
  exactAmountEvidence.marketContextStartedAt = marketContext.marketContextStartedAt ?? null;
  exactAmountEvidence.marketContextCompletedAt = marketContext.marketContextCompletedAt ?? null;
  exactAmountEvidence.marketContextDurationMs = marketContext.marketContextDurationMs ?? null;
  if (marketContext.ok === false) {
    policyChecks.market_context = {
      status: "warning",
      code: "MARKET_CONTEXT_PARTIAL_FAILURE",
      stage: "market_context",
      reason: "Market context failed or timed out; exact quote certification continued.",
      details: marketContext,
    };
  }

  if (!batchBudgetCanStart(maximumBatchDurationMs)) {
    failCheck(
      policyChecks,
      reasons,
      "batch_deadline",
      "Configured maximumBatchDurationMs cannot fit the required three-quote sandwich reserves",
      {
        maximumBatchDurationMs,
        requiredMinimumMs: requiredInitialBatchBudgetMs(),
      },
      { code: "INSUFFICIENT_BATCH_DEADLINE", stage: "quote_batch" },
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
      marketContext,
      exactAmountEvidence,
      rateLimitBudget: null,
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

  const quoteBatchStartedMs = now();
  const quoteBatchDeadlineMs = quoteBatchStartedMs + maximumBatchDurationMs;
  exactAmountEvidence.quoteBatchStartedAt = new Date(quoteBatchStartedMs).toISOString();
  exactAmountEvidence.quoteBatchDeadlineAt = new Date(quoteBatchDeadlineMs).toISOString();

  const rateLimitBudget = deps.reservePiteasRateLimitSlots(
    SHADOW_PITEAS_REQUEST_COUNT,
    quoteBatchStartedMs,
  );
  if (!rateLimitBudget.ok) {
    quoteBatchStatus = "RATE_LIMITED";
    failCheck(
      policyChecks,
      reasons,
      "piteas_rate_limit",
      "RATE_LIMIT_REQUOTE_REQUIRED",
      rateLimitBudget as unknown as Record<string, unknown>,
      { code: "RATE_LIMIT_REQUOTE_REQUIRED", stage: "quote_batch" },
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
      marketContext,
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

  let referenceBefore: ShadowQuoteSummary;
  let candidateQuote: ShadowQuoteSummary;
  let referenceAfter: ShadowQuoteSummary;
  let deadlineInsufficient = false;

  const referenceBeforeTimeoutMs = quoteRequestTimeout({
    nowMs: now(),
    batchDeadlineMs: quoteBatchDeadlineMs,
    reservesMs:
      MINIMUM_VIABLE_PITEAS_REQUEST_TIMEOUT_MS +
      REFERENCE_AFTER_RESERVE_MS +
      POST_CANDIDATE_VALIDATION_RESERVE_MS,
  });
  if (referenceBeforeTimeoutMs === null) {
    deadlineInsufficient = true;
    referenceBefore = skippedQuoteSummary({
      label: "reference_before",
      inputRaw: referenceRaw,
      inputHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
      account: null,
      atMs: now(),
      reason: "INSUFFICIENT_BATCH_DEADLINE",
    });
  } else {
    referenceBefore = await requestShadowQuote({
      config,
      deps,
      label: "reference_before",
      inputRaw: referenceRaw,
      inputHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
      account: null,
      maximumSlippagePercent,
      timeoutMs: referenceBeforeTimeoutMs,
    });
  }

  const candidateTimeoutMs = deadlineInsufficient
    ? null
    : quoteRequestTimeout({
        nowMs: now(),
        batchDeadlineMs: quoteBatchDeadlineMs,
        reservesMs: REFERENCE_AFTER_RESERVE_MS + POST_CANDIDATE_VALIDATION_RESERVE_MS,
      });
  if (candidateTimeoutMs === null) {
    deadlineInsufficient = true;
    candidateQuote = skippedQuoteSummary({
      label: "candidate",
      inputRaw: amountInRaw,
      inputHuman: amountInHuman,
      account: walletAddress,
      atMs: now(),
      reason: "INSUFFICIENT_BATCH_DEADLINE",
    });
  } else {
    candidateQuote = await requestShadowQuote({
      config,
      deps,
      label: "candidate",
      inputRaw: amountInRaw,
      inputHuman: amountInHuman,
      account: walletAddress,
      maximumSlippagePercent,
      timeoutMs: candidateTimeoutMs,
    });
  }

  const referenceAfterTimeoutMs = deadlineInsufficient
    ? null
    : quoteRequestTimeout({
        nowMs: now(),
        batchDeadlineMs: quoteBatchDeadlineMs,
        reservesMs: POST_CANDIDATE_VALIDATION_RESERVE_MS,
        candidateQuote,
        maximumQuoteAgeMs,
      });
  if (referenceAfterTimeoutMs === null) {
    deadlineInsufficient = true;
    referenceAfter = skippedQuoteSummary({
      label: "reference_after",
      inputRaw: referenceRaw,
      inputHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
      account: null,
      atMs: now(),
      reason: "INSUFFICIENT_BATCH_DEADLINE",
    });
  } else {
    referenceAfter = await requestShadowQuote({
      config,
      deps,
      label: "reference_after",
      inputRaw: referenceRaw,
      inputHuman: formatUnits(referenceRawBig, EUSDC_DECIMALS),
      account: null,
      maximumSlippagePercent,
      timeoutMs: referenceAfterTimeoutMs,
    });
  }

  const batchCompletedMs = now();
  const batchDurationMs = batchCompletedMs - quoteBatchStartedMs;
  exactAmountEvidence.quoteBatchCompletedAt = new Date(batchCompletedMs).toISOString();
  exactAmountEvidence.quoteBatchDurationMs = batchDurationMs;
  exactAmountEvidence.batchStartedAt = new Date(quoteBatchStartedMs).toISOString();
  exactAmountEvidence.batchCompletedAt = new Date(batchCompletedMs).toISOString();
  exactAmountEvidence.batchDurationMs = batchDurationMs;
  exactAmountEvidence.piteasRequestCountAttempted = [
    referenceBefore,
    candidateQuote,
    referenceAfter,
  ].filter((quote) => quote.attempted).length;

  quoteBatchStatus = deadlineInsufficient
    ? "DEADLINE_INSUFFICIENT"
    : !referenceBefore.ok
      ? "REFERENCE_BEFORE_FAILED"
      : !candidateQuote.ok
        ? "CANDIDATE_FAILED"
        : !referenceAfter.ok
          ? "REFERENCE_AFTER_FAILED"
          : "COMPLETE";

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

  const quoteFreshness = analyzeQuoteFreshness({
    referenceBefore,
    candidateQuote,
    referenceAfter,
    quoteBatchStatus,
    startedMs: quoteBatchStartedMs,
    completedMs: batchCompletedMs,
    deadlineMs: quoteBatchDeadlineMs,
    maximumBatchDurationMs,
    maximumQuoteAgeMs,
    referenceInputRaw: referenceRaw,
    referenceDriftPercent,
    maximumReferenceDriftPercent,
  });
  const referenceFreshness = quoteFreshness.referenceFreshness;
  const candidateFreshness = quoteFreshness.candidateFreshness;
  const sandwichTemporalCoherence = quoteFreshness.sandwichTemporalCoherence;

  requireCheck(
    policyChecks,
    reasons,
    "reference_before_quote",
    referenceBefore.ok,
    "Reference-before Piteas quote failed",
    sanitizeQuote(referenceBefore) ?? undefined,
    { code: "REFERENCE_BEFORE_FAILED", stage: "quote_batch" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "candidate_quote",
    candidateQuote.ok,
    "Exact requested-amount Piteas quote failed",
    sanitizeQuote(candidateQuote) ?? undefined,
    { code: "CANDIDATE_QUOTE_FAILED", stage: "quote_batch" },
  );
  requireCheck(
    policyChecks,
    reasons,
    "reference_after_quote",
    referenceAfter.ok,
    "Reference-after Piteas quote failed",
    sanitizeQuote(referenceAfter) ?? undefined,
    { code: "REFERENCE_AFTER_FAILED", stage: "quote_batch" },
  );
  if (deadlineInsufficient) {
    failCheck(
      policyChecks,
      reasons,
      "batch_deadline",
      "Insufficient quote-batch deadline for required Piteas request reserves",
      { batchDurationMs, maximumBatchDurationMs, quoteBatchStatus },
      { code: "INSUFFICIENT_BATCH_DEADLINE", stage: "quote_batch" },
    );
  } else if (batchDurationMs > maximumBatchDurationMs) {
    failCheck(
      policyChecks,
      reasons,
      "batch_deadline",
      "Exact shadow-buy quote sandwich exceeded maximumBatchDurationMs",
      { batchDurationMs, maximumBatchDurationMs, quoteBatchStatus },
      { code: "SANDWICH_TOO_SLOW", stage: "quote_batch" },
    );
  } else {
    passCheck(policyChecks, "batch_deadline", {
      batchDurationMs,
      maximumBatchDurationMs,
      quoteBatchStatus,
    });
  }

  if (quoteBatchStatus !== "COMPLETE") {
    policyChecks.quote_freshness = {
      status: "fail",
      code: "QUOTE_BATCH_INCOMPLETE",
      stage: "quote_freshness",
      reason: quoteFreshness.reason ?? "Quote batch incomplete",
      details: quoteFreshness as unknown as Record<string, unknown>,
    };
  } else if (referenceFreshness.beforeStatus === "INVALID") {
    failCheck(
      policyChecks,
      reasons,
      "quote_freshness",
      quoteFreshness.reason ?? "Reference-before quote is invalid",
      quoteFreshness as unknown as Record<string, unknown>,
      { code: "REFERENCE_BEFORE_INVALID", stage: "quote_freshness" },
    );
  } else if (referenceFreshness.afterStatus === "INVALID") {
    failCheck(
      policyChecks,
      reasons,
      "quote_freshness",
      quoteFreshness.reason ?? "Reference-after quote is invalid",
      quoteFreshness as unknown as Record<string, unknown>,
      { code: "REFERENCE_AFTER_INVALID", stage: "quote_freshness" },
    );
  } else if (candidateFreshness.status === "EXPIRED") {
    failCheck(
      policyChecks,
      reasons,
      "quote_freshness",
      quoteFreshness.reason ?? "Candidate quote expired",
      quoteFreshness as unknown as Record<string, unknown>,
      { code: "CANDIDATE_EXPIRED", stage: "quote_freshness" },
    );
  } else if (candidateFreshness.status === "STALE") {
    failCheck(
      policyChecks,
      reasons,
      "quote_freshness",
      quoteFreshness.reason ?? "Candidate quote is stale",
      quoteFreshness as unknown as Record<string, unknown>,
      { code: "CANDIDATE_QUOTE_STALE", stage: "quote_freshness" },
    );
  } else if (sandwichTemporalCoherence.status === "TOO_SLOW") {
    failCheck(
      policyChecks,
      reasons,
      "quote_freshness",
      quoteFreshness.reason ?? "Exact shadow-buy quote sandwich exceeded maximumBatchDurationMs",
      quoteFreshness as unknown as Record<string, unknown>,
      { code: "SANDWICH_TOO_SLOW", stage: "quote_batch" },
    );
  } else if (quoteFreshness.possibleCacheDetected) {
    warnCheck(
      policyChecks,
      "quote_freshness",
      "Reference cache concern is evaluated by the fail-closed reference_cache gate",
      quoteFreshness as unknown as Record<string, unknown>,
    );
  } else if (quoteFreshness.freshnessAcceptable) {
    passCheck(policyChecks, "quote_freshness", quoteFreshness as unknown as Record<string, unknown>);
  } else {
    warnCheck(
      policyChecks,
      "quote_freshness",
      quoteFreshness.reason ?? "Quote freshness depends on separately reported policy gates",
      quoteFreshness as unknown as Record<string, unknown>,
    );
  }

  if (quoteBatchStatus === "COMPLETE") {
    requireCheck(
      policyChecks,
      reasons,
      "reference_cache",
      !quoteFreshness.possibleCacheDetected,
      "Unresolved possible-cache concern between reference quotes",
      quoteFreshness as unknown as Record<string, unknown>,
      { code: "REFERENCE_CACHE_UNRESOLVED", stage: "quote_freshness" },
    );
  }

  if (referenceDriftPercent === null) {
    failCheck(
      policyChecks,
      reasons,
      "reference_drift",
      "Reference drift is unavailable because both reference quotes were not available",
      { referenceDriftPercent, maximumReferenceDriftPercent },
      { code: "REFERENCE_DRIFT_UNAVAILABLE", stage: "quote_batch" },
    );
  } else if (referenceDriftPercent > maximumReferenceDriftPercent) {
    failCheck(
      policyChecks,
      reasons,
      "reference_drift",
      "Reference drift exceeds policy",
      { referenceDriftPercent, maximumReferenceDriftPercent },
      { code: "REFERENCE_DRIFT_EXCEEDED", stage: "quote_batch" },
    );
  } else {
    passCheck(policyChecks, "reference_drift", { referenceDriftPercent, maximumReferenceDriftPercent });
  }

  if (candidateDeteriorationPercent === null) {
    failCheck(
      policyChecks,
      reasons,
      "candidate_deterioration",
      "Candidate deterioration is unavailable because reference or candidate quote data is unavailable",
      { candidateDeteriorationPercent, operationalThresholdPercent },
      { code: "CANDIDATE_DETERIORATION_UNAVAILABLE", stage: "quote_batch" },
    );
  } else if (candidateDeteriorationPercent > operationalThresholdPercent) {
    failCheck(
      policyChecks,
      reasons,
      "candidate_deterioration",
      "Exact requested amount exceeds the operational deterioration threshold",
      { candidateDeteriorationPercent, operationalThresholdPercent },
      { code: "CANDIDATE_DETERIORATION_EXCEEDED", stage: "quote_batch" },
    );
  } else {
    passCheck(policyChecks, "candidate_deterioration", {
      candidateDeteriorationPercent,
      operationalThresholdPercent,
    });
  }

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
    { code: "CANDIDATE_OUTPUT_UNAVAILABLE", stage: "quote_batch" },
  );

  if (quoteBatchStatus !== "COMPLETE" || hasFailures(policyChecks)) {
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
      marketContext,
      exactAmountEvidence,
      referenceBefore,
      candidateQuote,
      referenceAfter,
      referenceDriftPercent,
      candidateDeteriorationPercent,
      referenceFreshness,
      candidateFreshness,
      sandwichTemporalCoherence,
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

  const retainedCandidateQuote = candidateQuote.data!;
  const binding = bindCandidateQuote(candidateQuote);
  Object.assign(exactAmountEvidence, binding);
  const candidateAgeBeforePreparationMs = candidateAgeMs(candidateQuote, now());
  exactAmountEvidence.candidateAgeBeforePreparationMs = candidateAgeBeforePreparationMs;
  candidateFreshness.ageBeforePreparationMs = candidateAgeBeforePreparationMs;
  quoteFreshness.candidateAgeBeforePreparationMs = candidateAgeBeforePreparationMs;
  if (candidateExpired(candidateQuote, now())) {
    markCandidateFreshnessFailure(
      quoteFreshness,
      candidateFreshness,
      "EXPIRED",
      "Candidate quote expired before unsigned preparation",
    );
    failCheck(
      policyChecks,
      reasons,
      "candidate_quote_age_before_preparation",
      "CANDIDATE_EXPIRED",
      { candidateAgeBeforePreparationMs, maximumQuoteAgeMs, explicitExpiry: candidateQuote.expiresAt },
      { code: "CANDIDATE_EXPIRED", stage: "quote_freshness" },
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
      marketContext,
      exactAmountEvidence,
      referenceBefore,
      candidateQuote,
      referenceAfter,
      referenceDriftPercent,
      candidateDeteriorationPercent,
      referenceFreshness,
      candidateFreshness,
      sandwichTemporalCoherence,
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
  if (candidateAgeBeforePreparationMs === null || candidateAgeBeforePreparationMs > maximumQuoteAgeMs) {
    markCandidateFreshnessFailure(
      quoteFreshness,
      candidateFreshness,
      "STALE",
      "Candidate quote stale before unsigned preparation",
    );
    failCheck(
      policyChecks,
      reasons,
      "candidate_quote_age_before_preparation",
      "CANDIDATE_QUOTE_STALE",
      { candidateAgeBeforePreparationMs, maximumQuoteAgeMs },
      { code: "CANDIDATE_QUOTE_STALE", stage: "quote_freshness" },
    );
    return buildCertificate({
      decision: "REJECT",
      reasons,
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
      marketContext,
      exactAmountEvidence,
      referenceBefore,
      candidateQuote,
      referenceAfter,
      referenceDriftPercent,
      candidateDeteriorationPercent,
      referenceFreshness,
      candidateFreshness,
      sandwichTemporalCoherence,
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

  const prepared = deps.preparePiteasSwap(retainedCandidateQuote, {
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
      quoteBatchStatus,
      allowanceStatus,
      approvalStatus,
      routerIntegrityStatus,
      simulationStatus,
      marketContext,
      exactAmountEvidence,
      referenceBefore,
      candidateQuote,
      referenceAfter,
      referenceDriftPercent,
      candidateDeteriorationPercent,
      referenceFreshness,
      candidateFreshness,
      sandwichTemporalCoherence,
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
    retainedCandidateQuote,
    prepared,
    amountInHuman,
  );
  const preparedMethodFingerprint = fingerprint(prepared.methodParameters);
  requireCheck(
    policyChecks,
    reasons,
    "candidate_quote_binding",
    binding.candidateQuoteFingerprint === quoteFingerprint(retainedCandidateQuote) &&
      binding.candidateMethodParametersFingerprint === preparedMethodFingerprint &&
      prepared.intent.data === retainedCandidateQuote.methodParameters.calldata,
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
    quote: retainedCandidateQuote,
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
  routerIntegrityStatus = routerStatusFromChecks(policyChecks, routerReport.bytecodePresent);
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
    { code: "INSUFFICIENT_INPUT_BALANCE", stage: "balances" },
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
    allowanceStatus = "SUFFICIENT";
    approvalStatus = "NOT_REQUIRED";
    approvalIntent.status = "NOT_REQUIRED";
    passCheck(policyChecks, "allowance", {
      allowanceRaw: allowance.allowanceRaw,
      requiredAmountRaw: amountInRaw,
    });
  } else if (allowanceInsufficient) {
    allowanceStatus = "INSUFFICIENT";
    warnCheck(policyChecks, "allowance", "INSUFFICIENT_ALLOWANCE", {
      allowanceRaw: allowance.allowanceRaw,
      requiredAmountRaw: amountInRaw,
    });
  } else {
    allowanceStatus = "UNAVAILABLE";
    failCheck(policyChecks, reasons, "allowance", "Allowance is unavailable", {
      error: allowance.error,
    }, { code: "ALLOWANCE_UNAVAILABLE", stage: "allowance" });
  }

  const candidateGasUseEstimate = retainedCandidateQuote.gasUseEstimate;
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
      { gasUseEstimate: retainedCandidateQuote.gasUseEstimate ?? null },
    );
    requireCheck(
      policyChecks,
      reasons,
      "gas_balance",
      gasPolicy.nativeBalanceCoversSafetyAdjustedGas === true,
      "INSUFFICIENT_GAS_BALANCE",
      gasPolicy as unknown as Record<string, unknown>,
      { code: "INSUFFICIENT_GAS_BALANCE", stage: "gas_policy" },
    );
    if (input.maximumGasPls !== undefined) {
      requireCheck(
        policyChecks,
        reasons,
        "maximum_gas_pls",
        gasPolicy.withinMaximumGasPolicy === true,
        "Estimated gas cost exceeds maximumGasPls policy",
        gasPolicy as unknown as Record<string, unknown>,
        { code: "INSUFFICIENT_GAS_BALANCE", stage: "gas_policy" },
      );
    }
  }

  if (allowanceInsufficient && !hasFailures(policyChecks)) {
    approvalStatus = "NEEDS_APPROVAL";
    approval = buildApprovalIntent(prepared.intent.to, amountInRaw);
    const candidateAgeBeforeSimulationMs = candidateAgeMs(candidateQuote, now());
    exactAmountEvidence.candidateAgeBeforeSimulationMs = candidateAgeBeforeSimulationMs;
    candidateFreshness.ageBeforeSimulationMs = candidateAgeBeforeSimulationMs;
    quoteFreshness.candidateAgeBeforeSimulationMs = candidateAgeBeforeSimulationMs;
    if (candidateExpired(candidateQuote, now())) {
      markCandidateFreshnessFailure(
        quoteFreshness,
        candidateFreshness,
        "EXPIRED",
        "Candidate quote expired before approval simulation",
      );
      failCheck(
        policyChecks,
        reasons,
        "candidate_quote_age_before_simulation",
        "CANDIDATE_EXPIRED",
        { candidateAgeBeforeSimulationMs, maximumQuoteAgeMs, explicitExpiry: candidateQuote.expiresAt },
        { code: "CANDIDATE_EXPIRED", stage: "quote_freshness" },
      );
    } else if (candidateAgeBeforeSimulationMs === null || candidateAgeBeforeSimulationMs > maximumQuoteAgeMs) {
      markCandidateFreshnessFailure(
        quoteFreshness,
        candidateFreshness,
        "STALE",
        "Candidate quote stale before approval simulation",
      );
      failCheck(
        policyChecks,
        reasons,
        "candidate_quote_age_before_simulation",
        "CANDIDATE_QUOTE_STALE",
        { candidateAgeBeforeSimulationMs, maximumQuoteAgeMs },
        { code: "CANDIDATE_QUOTE_STALE", stage: "quote_freshness" },
      );
    }
  }

  if (allowanceInsufficient && !hasFailures(policyChecks) && approval.status === "APPROVAL_REQUIRED") {
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
      approvalStatus = "SIMULATION_FAILED";
    } else {
      passCheck(policyChecks, "approval_simulation", {
        gasEstimate: approvalSimulation.gasEstimate,
      });
    }
  } else if (allowanceInsufficient) {
    approvalStatus = hasFailures(policyChecks) ? "INVALID" : approvalStatus;
    approval = {
      ...approvalIntent,
      status: "UNAVAILABLE",
      spender: prepared.intent.to,
      error: "Approval intent withheld because mandatory shadow-buy checks failed.",
    };
  }

  if (!allowanceInsufficient && !hasFailures(policyChecks)) {
    const candidateAgeBeforeSimulationMs = candidateAgeMs(candidateQuote, now());
    exactAmountEvidence.candidateAgeBeforeSimulationMs = candidateAgeBeforeSimulationMs;
    candidateFreshness.ageBeforeSimulationMs = candidateAgeBeforeSimulationMs;
    quoteFreshness.candidateAgeBeforeSimulationMs = candidateAgeBeforeSimulationMs;
    if (candidateExpired(candidateQuote, now())) {
      markCandidateFreshnessFailure(
        quoteFreshness,
        candidateFreshness,
        "EXPIRED",
        "Candidate quote expired before swap simulation",
      );
      failCheck(
        policyChecks,
        reasons,
        "candidate_quote_age_before_simulation",
        "CANDIDATE_EXPIRED",
        { candidateAgeBeforeSimulationMs, maximumQuoteAgeMs, explicitExpiry: candidateQuote.expiresAt },
        { code: "CANDIDATE_EXPIRED", stage: "quote_freshness" },
      );
    } else if (candidateAgeBeforeSimulationMs === null || candidateAgeBeforeSimulationMs > maximumQuoteAgeMs) {
      markCandidateFreshnessFailure(
        quoteFreshness,
        candidateFreshness,
        "STALE",
        "Candidate quote stale before swap simulation",
      );
      failCheck(
        policyChecks,
        reasons,
        "candidate_quote_age_before_simulation",
        "CANDIDATE_QUOTE_STALE",
        { candidateAgeBeforeSimulationMs, maximumQuoteAgeMs },
        { code: "CANDIDATE_QUOTE_STALE", stage: "quote_freshness" },
      );
    }
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
      { code: "SIMULATION_ETH_CALL_FAILED", stage: "simulation" },
    );
    requireCheck(
      policyChecks,
      reasons,
      "estimate_gas",
      swapSimulation.estimateGasOk,
      "Gas cannot be estimated",
      swapSimulation as unknown as Record<string, unknown>,
      { code: "SIMULATION_GAS_ESTIMATION_FAILED", stage: "simulation" },
    );
    simulationStatus = !swapSimulation.ethCallOk
      ? "ETH_CALL_FAILED"
      : !swapSimulation.estimateGasOk
        ? "GAS_ESTIMATION_FAILED"
        : "PASSED";
  }

  const candidateAgeAfterSimulationMs = candidateAgeMs(candidateQuote, now());
  exactAmountEvidence.candidateAgeAfterSimulationMs = candidateAgeAfterSimulationMs;
  candidateFreshness.ageAfterSimulationMs = candidateAgeAfterSimulationMs;
  quoteFreshness.candidateAgeAfterSimulationMs = candidateAgeAfterSimulationMs;
  if (!hasFailures(policyChecks) && (allowanceInsufficient || simulationStatus === "PASSED") && candidateExpired(candidateQuote, now())) {
    markCandidateFreshnessFailure(
      quoteFreshness,
      candidateFreshness,
      "EXPIRED",
      "Candidate quote expired after simulation",
    );
    failCheck(
      policyChecks,
      reasons,
      "candidate_quote_age_after_simulation",
      "CANDIDATE_EXPIRED",
      { candidateAgeAfterSimulationMs, maximumQuoteAgeMs, explicitExpiry: candidateQuote.expiresAt },
      { code: "CANDIDATE_EXPIRED", stage: "quote_freshness" },
    );
  } else if (
    !hasFailures(policyChecks) &&
    (allowanceInsufficient || simulationStatus === "PASSED") &&
    (candidateAgeAfterSimulationMs === null || candidateAgeAfterSimulationMs > maximumQuoteAgeMs)
  ) {
    markCandidateFreshnessFailure(
      quoteFreshness,
      candidateFreshness,
      "STALE",
      "Candidate quote stale after simulation",
    );
    failCheck(
      policyChecks,
      reasons,
      "candidate_quote_age_after_simulation",
      "CANDIDATE_QUOTE_STALE",
      { candidateAgeAfterSimulationMs, maximumQuoteAgeMs },
      { code: "CANDIDATE_QUOTE_STALE", stage: "quote_freshness" },
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
      { code: "INSUFFICIENT_GAS_BALANCE", stage: "gas_policy" },
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

  const candidateAgeBeforeDecisionMs = candidateAgeMs(candidateQuote, now());
  exactAmountEvidence.candidateAgeBeforeDecisionMs = candidateAgeBeforeDecisionMs;
  if (!hasFailures(policyChecks) && (allowanceInsufficient || simulationStatus === "PASSED") && candidateExpired(candidateQuote, now())) {
    markCandidateFreshnessFailure(
      quoteFreshness,
      candidateFreshness,
      "EXPIRED",
      "Candidate quote expired before final shadow-buy decision",
    );
    failCheck(
      policyChecks,
      reasons,
      "candidate_quote_age_before_decision",
      "CANDIDATE_EXPIRED",
      { candidateAgeBeforeDecisionMs, maximumQuoteAgeMs, explicitExpiry: candidateQuote.expiresAt },
      { code: "CANDIDATE_EXPIRED", stage: "quote_freshness" },
    );
  } else if (
    !hasFailures(policyChecks) &&
    (allowanceInsufficient || simulationStatus === "PASSED") &&
    (candidateAgeBeforeDecisionMs === null || candidateAgeBeforeDecisionMs > maximumQuoteAgeMs)
  ) {
    markCandidateFreshnessFailure(
      quoteFreshness,
      candidateFreshness,
      "STALE",
      "Candidate quote stale before final shadow-buy decision",
    );
    failCheck(
      policyChecks,
      reasons,
      "candidate_quote_age_before_decision",
      "CANDIDATE_QUOTE_STALE",
      { candidateAgeBeforeDecisionMs, maximumQuoteAgeMs },
      { code: "CANDIDATE_QUOTE_STALE", stage: "quote_freshness" },
    );
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
      ? []
      : decision === "NEEDS_APPROVAL"
        ? [
            {
              code: "INSUFFICIENT_ALLOWANCE",
              stage: "allowance",
              message: "Approval is required before any swap could be reconsidered.",
              evidence: {
                allowanceRaw: allowance.allowanceRaw,
                requiredAmountRaw: amountInRaw,
                swapEvidenceInvalidAfterApproval: true,
              },
            },
          ]
        : reasons;

  return buildCertificate({
    decision,
    reasons: finalReasons,
    quoteBatchStatus,
    allowanceStatus,
    approvalStatus,
    routerIntegrityStatus,
    simulationStatus,
    marketContext,
    exactAmountEvidence,
    referenceBefore,
    candidateQuote,
    referenceAfter,
    referenceDriftPercent,
    candidateDeteriorationPercent,
    referenceFreshness,
    candidateFreshness,
    sandwichTemporalCoherence,
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

function requiredInitialBatchBudgetMs(): number {
  return (
    PITEAS_PER_REQUEST_TIMEOUT_MS * 2 +
    REFERENCE_AFTER_RESERVE_MS +
    POST_CANDIDATE_VALIDATION_RESERVE_MS
  );
}

function batchBudgetCanStart(maximumBatchDurationMs: number): boolean {
  return maximumBatchDurationMs >= requiredInitialBatchBudgetMs();
}

function quoteRequestTimeout(args: {
  nowMs: number;
  batchDeadlineMs: number;
  reservesMs: number;
  candidateQuote?: ShadowQuoteSummary;
  maximumQuoteAgeMs?: number;
}): number | null {
  const batchRemainingMs = args.batchDeadlineMs - args.nowMs;
  const candidateRemainingMs =
    args.candidateQuote?.ok === true && args.maximumQuoteAgeMs !== undefined
      ? args.maximumQuoteAgeMs - (candidateAgeMs(args.candidateQuote, args.nowMs) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  const availableMs = Math.min(batchRemainingMs, candidateRemainingMs) - args.reservesMs;
  if (availableMs < MINIMUM_VIABLE_PITEAS_REQUEST_TIMEOUT_MS) return null;
  return Math.min(PITEAS_PER_REQUEST_TIMEOUT_MS, availableMs);
}

function candidateAgeMs(candidateQuote: ShadowQuoteSummary, nowMs: number): number | null {
  if (!candidateQuote.ok) return null;
  const responseMs = Date.parse(candidateQuote.responseReceivedAt);
  if (!Number.isFinite(responseMs)) return null;
  return nowMs - responseMs;
}

function candidateExpired(candidateQuote: ShadowQuoteSummary, nowMs: number): boolean {
  if (!candidateQuote.ok) return false;
  const expiresAtMs = parseTimestampMs(candidateQuote.expiresAt);
  return expiresAtMs !== null && expiresAtMs <= nowMs;
}

function markCandidateFreshnessFailure(
  quoteFreshness: QuoteFreshness,
  candidateFreshness: CandidateFreshness,
  status: "STALE" | "EXPIRED",
  message: string,
): void {
  candidateFreshness.status = status;
  candidateFreshness.warnings.push(message);
  quoteFreshness.candidateAcceptable = false;
  quoteFreshness.freshnessAcceptable = false;
  quoteFreshness.reason = message;
}

function routerStatusFromChecks(
  checks: Record<string, PolicyCheck>,
  bytecodePresent: boolean | null,
): RouterIntegrityStatus {
  const routerFailures = [
    "router_allowlist",
    "router_bytecode_present",
    "router_code_hash_agreement",
  ].some((name) => checks[name]?.status === "fail");
  if (routerFailures) return "FAILED";
  if (bytecodePresent !== true) return "UNAVAILABLE";
  return "PASSED";
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
