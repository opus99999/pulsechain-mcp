import type { PhiatShadowBuyCertificate, ShadowQuoteSummary, BalanceEvidence, AllowanceEvidence, ApprovalIntent, RouterIntegrity, ExecutionTargetsReport, SimulationResult, SimulationCall, GasPolicy, Decision, PolicyCheck, PreparedIntent, DecodedIntent, QuoteFreshness, ShadowBuyReason, QuoteBatchStatus, AllowanceStatus, ApprovalStatus, RouterIntegrityStatus, SimulationStatus, ReferenceFreshness, CandidateFreshness, SandwichTemporalCoherence, DecisionClass, FailedCheck } from "./types.js";
import type { PiteasRateLimitLeaseStatus, PiteasRateLimitReservation } from "../../../data/index.js";
import { PHIAT_SHADOW_BUY_TOKEN_IN, PITEAS_ROUTER } from "./constants.js";
import { parseHumanUnitsStrict } from "./inputNormalization.js";

export function buildCertificate(args: {
  decision: Decision;
  decisionClass?: PhiatShadowBuyCertificate["decisionClass"];
  economicDecisionReached?: boolean;
  retryable?: boolean;
  retryDisposition?: PhiatShadowBuyCertificate["retryDisposition"];
  reasons: ShadowBuyReason[];
  quoteBatchStatus?: QuoteBatchStatus;
  allowanceStatus?: AllowanceStatus;
  approvalStatus?: ApprovalStatus;
  routerIntegrityStatus?: RouterIntegrityStatus;
  simulationStatus?: SimulationStatus;
  marketContext: Record<string, unknown>;
  exactAmountEvidence: Record<string, unknown>;
  referenceBefore?: ShadowQuoteSummary | null;
  candidateQuote?: ShadowQuoteSummary | null;
  referenceAfter?: ShadowQuoteSummary | null;
  referenceDriftPercent?: number | null;
  candidateDeteriorationPercent?: number | null;
  actualQuoteCallCount?: number;
  rateLimitLease?: PiteasRateLimitLeaseStatus | null;
  referenceFreshness?: ReferenceFreshness | null;
  candidateFreshness?: CandidateFreshness | null;
  sandwichTemporalCoherence?: SandwichTemporalCoherence | null;
  quoteFreshness?: QuoteFreshness | null;
  rateLimitBudget: PiteasRateLimitReservation | null;
  balances: BalanceEvidence;
  allowance: AllowanceEvidence;
  approvalIntent: ApprovalIntent;
  routerIntegrity: RouterIntegrity;
  executionTargets: ExecutionTargetsReport;
  preparedIntent?: PreparedIntent | null;
  decodedIntent?: DecodedIntent | null;
  simulation: SimulationResult;
  gasPolicy: GasPolicy;
  policyChecks: Record<string, PolicyCheck>;
  automaticExecutionEligible?: boolean;
  swapEvidenceInvalidAfterApproval?: boolean;
  transactionPrepared?: boolean;
}): PhiatShadowBuyCertificate {
  const primaryDecisionClass = args.decisionClass ?? classifyDecision(args.decision, args.reasons);
  const secondaryDecisionClasses = secondaryClasses(args.decision, args.reasons, primaryDecisionClass);
  const failedChecks = failedChecksFromReasons(args.reasons);
  const warnings = warningsFromChecks(args.policyChecks);
  const passedChecks = passedChecksFromPolicy(args.policyChecks, failedChecks);
  return {
    decision: args.decision,
    decisionClass: primaryDecisionClass,
    primaryDecisionClass,
    secondaryDecisionClasses,
    economicDecisionReached:
      args.economicDecisionReached ?? defaultEconomicDecisionReached(primaryDecisionClass),
    transactionIntegrityDecisionReached:
      primaryDecisionClass === "TRANSACTION_INTEGRITY_REJECT" ||
      secondaryDecisionClasses.includes("TRANSACTION_INTEGRITY_REJECT"),
    retryable: args.retryable ?? defaultRetryable(args.reasons),
    retryDisposition: args.retryDisposition ?? defaultRetryDisposition(args.decision, args.reasons),
    reasons: args.reasons,
    passedChecks,
    failedChecks,
    warnings,
    reasonSummaries: args.reasons.map((reason) => reason.message),
    quoteBatchStatus: args.quoteBatchStatus ?? "DEADLINE_INSUFFICIENT",
    allowanceStatus: args.allowanceStatus ?? "NOT_EVALUATED",
    approvalStatus: args.approvalStatus ?? "NOT_EVALUATED",
    routerIntegrityStatus: args.routerIntegrityStatus ?? "NOT_EVALUATED",
    simulationStatus: args.simulationStatus ?? "NOT_RUN",
    marketContext: args.marketContext,
    exactAmountEvidence: args.exactAmountEvidence,
    referenceBefore: sanitizeQuote(args.referenceBefore ?? null),
    candidateQuote: sanitizeQuote(args.candidateQuote ?? null),
    referenceAfter: sanitizeQuote(args.referenceAfter ?? null),
    referenceDriftPercent: args.referenceDriftPercent ?? null,
    candidateDeteriorationPercent: args.candidateDeteriorationPercent ?? null,
    actualQuoteCallCount: args.actualQuoteCallCount ?? countAttemptedQuotes([
      args.referenceBefore ?? null,
      args.candidateQuote ?? null,
      args.referenceAfter ?? null,
    ]),
    rateLimitLease: args.rateLimitLease ?? null,
    referenceBeforeValidityStatus: args.referenceFreshness?.beforeStatus ?? "UNAVAILABLE",
    referenceAfterValidityStatus: args.referenceFreshness?.afterStatus ?? "UNAVAILABLE",
    candidateFreshnessStatus: args.candidateFreshness?.status ?? "UNAVAILABLE",
    sandwichTemporalStatus: args.sandwichTemporalCoherence?.status ?? "INCOMPLETE",
    referenceFreshness: args.referenceFreshness ?? null,
    candidateFreshness: args.candidateFreshness ?? null,
    sandwichTemporalCoherence: args.sandwichTemporalCoherence ?? null,
    quoteFreshness: args.quoteFreshness ?? null,
    rateLimitBudget: args.rateLimitBudget,
    balances: args.balances,
    allowance: args.allowance,
    approvalIntent: args.approvalIntent,
    routerIntegrity: args.routerIntegrity,
    executionTargets: args.executionTargets,
    preparedIntent: args.preparedIntent ?? null,
    decodedIntent: args.decodedIntent ?? null,
    simulation: args.simulation,
    gasPolicy: args.gasPolicy,
    policyChecks: args.policyChecks,
    automaticExecutionEligible: args.automaticExecutionEligible ?? false,
    swapEvidenceInvalidAfterApproval: args.swapEvidenceInvalidAfterApproval ?? false,
    transactionPrepared: args.transactionPrepared ?? false,
    transactionSigned: false,
    transactionSubmitted: false,
    transactionBroadcast: false,
    transactionExecuted: false,
  };
}

export function sanitizeQuote(quote: ShadowQuoteSummary | null): Record<string, unknown> | null {
  if (!quote) return null;
  const { data: _data, ...safe } = quote;
  return safe;
}

function countAttemptedQuotes(quotes: Array<ShadowQuoteSummary | null>): number {
  return quotes.filter((quote) => quote?.attempted === true).length;
}

function classifyDecision(
  decision: Decision,
  reasons: ShadowBuyReason[],
): PhiatShadowBuyCertificate["decisionClass"] {
  if (decision === "WOULD_BUY") return "WOULD_BUY";
  if (decision === "NEEDS_APPROVAL") return "NEEDS_APPROVAL";
  return orderedClassesForReasons(reasons)[0] ?? "TRANSACTION_INTEGRITY_REJECT";
}

function defaultEconomicDecisionReached(primaryDecisionClass: DecisionClass): boolean {
  return primaryDecisionClass !== "INFRASTRUCTURE_REQUOTE_REQUIRED";
}

function defaultRetryable(reasons: ShadowBuyReason[]): boolean {
  return classifyDecision("REJECT", reasons) === "INFRASTRUCTURE_REQUOTE_REQUIRED";
}

function defaultRetryDisposition(
  decision: Decision,
  reasons: ShadowBuyReason[],
): PhiatShadowBuyCertificate["retryDisposition"] {
  if (decision === "NEEDS_APPROVAL") return "NEW_BATCH_AFTER_APPROVAL_CONFIRMATION";
  const codes = new Set(reasons.map((reason) => reason.code));
  if (codes.has("RATE_LIMIT_REQUOTE_REQUIRED") || codes.has("PITEAS_HTTP_429")) {
    return "NEW_BATCH_AFTER_RATE_LIMIT_RESET";
  }
  if ([...codes].some((code) => code.startsWith("PITEAS_")) || codes.has("QUOTE_BATCH_INCOMPLETE")) {
    return "NEW_BATCH_WHEN_UPSTREAM_RECOVERS";
  }
  return "NONE";
}

function secondaryClasses(
  decision: Decision,
  reasons: ShadowBuyReason[],
  primary: DecisionClass,
): DecisionClass[] {
  if (decision === "WOULD_BUY" || decision === "NEEDS_APPROVAL") return [];
  return orderedClassesForReasons(reasons).filter((klass) => klass !== primary);
}

function orderedClassesForReasons(reasons: ShadowBuyReason[]): DecisionClass[] {
  const classes = new Set(reasons.map(classForReason).filter(Boolean) as DecisionClass[]);
  const precedence: DecisionClass[] = [
    "INFRASTRUCTURE_REQUOTE_REQUIRED",
    "TRANSACTION_INTEGRITY_REJECT",
    "MARKET_POLICY_REJECT",
    "INSUFFICIENT_FUNDS",
    "NEEDS_APPROVAL",
    "WOULD_BUY",
  ];
  return precedence.filter((klass) => classes.has(klass));
}

function classForReason(reason: ShadowBuyReason): DecisionClass | null {
  const code = reason.code;
  if (
    code.startsWith("PITEAS_") ||
    code === "RATE_LIMIT_REQUOTE_REQUIRED" ||
    code === "QUOTE_BATCH_INCOMPLETE"
  ) {
    return "INFRASTRUCTURE_REQUOTE_REQUIRED";
  }
  if (code === "REFERENCE_DRIFT_EXCEEDED" || code === "CANDIDATE_DETERIORATION_EXCEEDED") {
    return "MARKET_POLICY_REJECT";
  }
  if (code === "INSUFFICIENT_INPUT_BALANCE" || code === "INSUFFICIENT_GAS_BALANCE") {
    return "INSUFFICIENT_FUNDS";
  }
  if (code === "INSUFFICIENT_ALLOWANCE") return "NEEDS_APPROVAL";
  return "TRANSACTION_INTEGRITY_REJECT";
}

function failedChecksFromReasons(reasons: ShadowBuyReason[]): FailedCheck[] {
  return reasons.map((reason) => ({
    code: reason.code,
    stage: reason.stage,
    message: reason.message,
    evidence: reason.evidence,
  }));
}

function warningsFromChecks(checks: Record<string, PolicyCheck>): string[] {
  return Object.entries(checks)
    .filter(([, check]) => check.status === "warning")
    .map(([name, check]) => check.reason ?? check.code ?? name);
}

function passedChecksFromPolicy(
  checks: Record<string, PolicyCheck>,
  failedChecks: FailedCheck[],
): string[] {
  const failedCodes = new Set(failedChecks.map((check) => check.code));
  const passed = Object.entries(checks)
    .filter(([, check]) => check.status === "pass")
    .map(([name]) => passedCodeFor(name))
    .filter((code) => !failedCodes.has(code));
  return [...new Set(passed)];
}

function passedCodeFor(name: string): string {
  const explicit: Record<string, string> = {
    calldata_decodable: "CALLDATA_DECODABLE",
    calldata_selector_allowlisted: "CALLDATA_SELECTOR_ALLOWLISTED",
    decoded_token_in: "DECODED_TOKEN_IN_MATCH",
    decoded_token_out: "DECODED_TOKEN_OUT_MATCH",
    decoded_recipient: "DECODED_RECIPIENT_MATCH",
    decoded_amount_in: "DECODED_AMOUNT_IN_MATCH",
    decoded_minimum_output: "DECODED_MINIMUM_OUTPUT_MATCH",
    native_value: "NATIVE_VALUE_MATCH",
    calldata_fingerprint_binding: "CALLDATA_FINGERPRINT_MATCH",
    method_parameter_fingerprint_binding: "METHOD_PARAMETER_FINGERPRINT_MATCH",
    route_data_decodable: "ROUTE_DATA_DECODABLE",
    route_expected_output: "ROUTE_EXPECTED_OUTPUT_MATCH",
    route_destination_token: "ROUTE_DESTINATION_TOKEN_MATCH",
    execution_targets_resolved: "EXECUTION_TARGETS_RESOLVED",
  };
  return explicit[name] ?? name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

export function emptySimulation(): SimulationResult {
  return {
    swap: emptySimulationCall(),
    approval: null,
    stateOverridesUsed: false,
    economicProfitabilityProven: false,
  };
}

export function emptySimulationCall(): SimulationCall {
  return {
    ethCallOk: false,
    ethCallError: null,
    ethCallReturnData: null,
    estimateGasOk: false,
    estimateGasError: null,
    gasEstimate: null,
  };
}

export function emptyBalances(walletAddress: string): BalanceEvidence {
  return {
    walletAddress,
    inputToken: PHIAT_SHADOW_BUY_TOKEN_IN,
    nativeToken: "PLS",
    inputBalanceRaw: null,
    inputBalanceHuman: null,
    nativeBalanceWei: null,
    nativeBalancePls: null,
    inputBalanceSufficient: null,
    gasBalanceSufficient: null,
    errors: [],
  };
}

export function emptyAllowance(owner: string, requiredAmountRaw: string): AllowanceEvidence {
  return {
    owner,
    spender: null,
    token: PHIAT_SHADOW_BUY_TOKEN_IN,
    allowanceRaw: null,
    allowanceHuman: null,
    requiredAmountRaw,
    sufficient: null,
    error: null,
  };
}

export function emptyApprovalIntent(): ApprovalIntent {
  return {
    status: "NOT_EVALUATED",
    token: PHIAT_SHADOW_BUY_TOKEN_IN,
    spender: null,
    amountRaw: null,
    amountHuman: null,
    calldata: null,
    valueWei: "0",
    unlimitedApproval: false,
    transactionPrepared: false,
    transactionSigned: false,
    transactionSubmitted: false,
    transactionBroadcast: false,
    transactionExecuted: false,
    simulation: null,
    error: null,
  };
}

export function emptyRouterIntegrity(): RouterIntegrity {
  return {
    router: null,
    expectedRouter: PITEAS_ROUTER,
    routerMatchesAllowlist: false,
    bytecodePresent: null,
    routerBytecodeHash: null,
    approvedRouterCodeHashes: [],
    approvedRouterTrustRecords: [],
    routerCodeHashApproved: null,
    operatorApprovalRequired: true,
    trustRecordFingerprint: null,
    rpcCodeHashes: [],
    codeHashAgreement: "unavailable",
    proxyDetection: {
      proxyDetected: null,
      proxyType: "unavailable",
      implementationAddress: null,
      implementationCodeHash: null,
      implementationBytecode: null,
      implementationBytecodeLength: null,
      rpcAgreement: "unavailable",
      blockNumbers: [],
    },
    warnings: [],
  };
}

export function emptyExecutionTargets(): ExecutionTargetsReport {
  return {
    executionTargets: [],
    unresolvedExecutionTargets: [],
    executionTargetConfidence: "low",
  };
}

export function emptyGasPolicy(
  gasSafetyFactor: number,
  maximumGasPls: string | undefined,
): GasPolicy {
  return {
    gasSafetyFactor,
    gasSafetyFactorBps: Math.ceil(gasSafetyFactor * 10_000).toString(),
    gasUnits: null,
    gasPriceWei: null,
    estimatedGasWei: null,
    estimatedGasPls: null,
    estimatedGasCostPls: null,
    safetyAdjustedGasWei: null,
    safetyAdjustedGasPls: null,
    safetyAdjustedGasCostPls: null,
    estimatedGasCostUsd: null,
    gasCostAsPercentOfInputValue: null,
    maximumGasPls: maximumGasPls ?? null,
    maximumGasWei: maximumGasPls ? parseHumanUnitsStrict(maximumGasPls, 18)?.toString() ?? null : null,
    withinMaximumGasPolicy: null,
    nativeBalanceCoversSafetyAdjustedGas: null,
  };
}
