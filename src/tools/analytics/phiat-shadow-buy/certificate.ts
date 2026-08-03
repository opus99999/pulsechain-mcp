import type { PhiatShadowBuyCertificate, ShadowQuoteSummary, BalanceEvidence, AllowanceEvidence, ApprovalIntent, RouterIntegrity, ExecutionTargetsReport, SimulationResult, SimulationCall, GasPolicy, Decision, PolicyCheck, PreparedIntent, DecodedIntent, QuoteFreshness, ShadowBuyReason, QuoteBatchStatus, AllowanceStatus, ApprovalStatus, RouterIntegrityStatus, SimulationStatus, ReferenceFreshness, CandidateFreshness, SandwichTemporalCoherence } from "./types.js";
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
  return {
    decision: args.decision,
    decisionClass: args.decisionClass ?? classifyDecision(args.decision, args.reasons),
    economicDecisionReached:
      args.economicDecisionReached ?? defaultEconomicDecisionReached(args.decision, args.reasons),
    retryable: args.retryable ?? defaultRetryable(args.reasons),
    retryDisposition: args.retryDisposition ?? defaultRetryDisposition(args.decision, args.reasons),
    reasons: args.reasons,
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
  const codes = new Set(reasons.map((reason) => reason.code));
  if (
    [...codes].some((code) => code.startsWith("PITEAS_")) ||
    codes.has("RATE_LIMIT_REQUOTE_REQUIRED") ||
    codes.has("QUOTE_BATCH_INCOMPLETE")
  ) {
    return "INFRASTRUCTURE_REQUOTE_REQUIRED";
  }
  if (codes.has("INSUFFICIENT_INPUT_BALANCE") || codes.has("INSUFFICIENT_GAS_BALANCE")) {
    return "INSUFFICIENT_FUNDS";
  }
  if (codes.has("REFERENCE_DRIFT_EXCEEDED") || codes.has("CANDIDATE_DETERIORATION_EXCEEDED")) {
    return "MARKET_POLICY_REJECT";
  }
  return "TRANSACTION_INTEGRITY_REJECT";
}

function defaultEconomicDecisionReached(decision: Decision, reasons: ShadowBuyReason[]): boolean {
  if (decision === "WOULD_BUY" || decision === "NEEDS_APPROVAL") return true;
  return classifyDecision(decision, reasons) !== "INFRASTRUCTURE_REQUOTE_REQUIRED";
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
    routerCodeHashApproved: null,
    rpcCodeHashes: [],
    codeHashAgreement: "unavailable",
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
    safetyAdjustedGasWei: null,
    safetyAdjustedGasPls: null,
    maximumGasPls: maximumGasPls ?? null,
    maximumGasWei: maximumGasPls ? parseHumanUnitsStrict(maximumGasPls, 18)?.toString() ?? null : null,
    withinMaximumGasPolicy: null,
    nativeBalanceCoversSafetyAdjustedGas: null,
  };
}
