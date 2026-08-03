import type { AppConfig } from "../../../types.js";
import type { PiteasQuoteData, PiteasRateLimitLeaseStatus, PiteasRateLimitReservation } from "../../../data/index.js";
import type { buildPhiatDashboard } from "../phiatDashboard.js";
import type { getPiteasQuote, preparePiteasSwap, ethCall, estimateGas, getFeeData, reservePiteasRateLimitSlots, markPiteasRateLimitSlotAttempted, markPiteasRateLimitSlotCompleted, releaseUnusedPiteasRateLimitSlots } from "../../../data/index.js";

export interface PhiatShadowBuyInput {
  walletAddress: string;
  amountInHuman: string;
  analyticalThresholdPercent?: number;
  operationalThresholdPercent?: number;
  maximumReferenceDriftPercent?: number;
  maximumSlippagePercent?: number;
  maximumQuoteAgeMs?: number;
  maximumBatchDurationMs?: number;
  maximumGasPls?: string;
  requireOperationalRecommendation?: boolean;
  referenceAmountHuman?: string;
  gasSafetyFactor?: number;
  approvedRouterCodeHashes?: string[];
}

export type Decision = "WOULD_BUY" | "NEEDS_APPROVAL" | "REJECT";
export type DecisionClass =
  | "WOULD_BUY"
  | "NEEDS_APPROVAL"
  | "MARKET_POLICY_REJECT"
  | "TRANSACTION_INTEGRITY_REJECT"
  | "INSUFFICIENT_FUNDS"
  | "INFRASTRUCTURE_REQUOTE_REQUIRED";
export type RetryDisposition =
  | "NONE"
  | "NEW_BATCH_AFTER_RATE_LIMIT_RESET"
  | "NEW_BATCH_WHEN_UPSTREAM_RECOVERS"
  | "NEW_BATCH_AFTER_APPROVAL_CONFIRMATION";
export type PolicyStatus = "pass" | "fail" | "not_run" | "warning";
export type QuoteBatchStatus =
  | "COMPLETE"
  | "RATE_LIMITED"
  | "DEADLINE_INSUFFICIENT"
  | "REFERENCE_BEFORE_FAILED"
  | "CANDIDATE_FAILED"
  | "REFERENCE_AFTER_FAILED";
export type AllowanceStatus =
  | "NOT_EVALUATED"
  | "SUFFICIENT"
  | "INSUFFICIENT"
  | "UNAVAILABLE";
export type ApprovalStatus =
  | "NOT_EVALUATED"
  | "NOT_REQUIRED"
  | "NEEDS_APPROVAL"
  | "INVALID"
  | "SIMULATION_FAILED";
export type RouterIntegrityStatus =
  | "NOT_EVALUATED"
  | "PASSED"
  | "FAILED"
  | "UNAVAILABLE";
export type SimulationStatus =
  | "NOT_RUN"
  | "PASSED"
  | "ETH_CALL_FAILED"
  | "GAS_ESTIMATION_FAILED";

export interface ShadowBuyReason {
  code: string;
  stage: string;
  message: string;
  evidence: Record<string, unknown> | null;
}

export type PiteasUpstreamErrorCode =
  | "PITEAS_TIMEOUT"
  | "PITEAS_HTTP_500"
  | "PITEAS_HTTP_429"
  | "PITEAS_HTTP_403"
  | "PITEAS_INVALID_JSON"
  | "PITEAS_ROUTE_UNAVAILABLE"
  | "PITEAS_NETWORK_ERROR"
  | "PITEAS_UNKNOWN_ERROR";

export interface PiteasUpstreamError {
  code: PiteasUpstreamErrorCode;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  likelyTemporaryBlock: boolean;
  operatorInvestigationRequired: boolean;
  conservativeRetryAfterMs: number | null;
}

export interface PolicyCheck {
  status: PolicyStatus;
  code?: string;
  stage?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ShadowQuoteSummary {
  label: "reference_before" | "candidate" | "reference_after";
  attempted: boolean;
  inputHuman: string;
  inputRaw: string;
  account: string | null;
  timeoutMs: number | null;
  requestStartedAt: string;
  responseReceivedAt: string;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  outputRaw: string | null;
  outputHuman: string | null;
  minimumOutputRaw: string | null;
  minimumOutputHuman: string | null;
  averagePrice: string | null;
  quoteIdentifier: string | null;
  quoteTimestamp: string | null;
  expiresAt: string | null;
  blockNumber: string | null;
  endpoint: string | null;
  routeSignature: string | null;
  responseFingerprint: string | null;
  methodParametersFingerprint: string | null;
  upstreamError: PiteasUpstreamError | null;
  data?: PiteasQuoteData;
}

export interface CandidateBinding {
  candidateQuoteFingerprint: string;
  candidateResponseReceivedAt: string;
  candidateQuoteIdentifier: string | null;
  candidateExpiry: string | null;
  candidateRouteSignature: string | null;
  candidateMethodParametersFingerprint: string;
}

export interface PreparedIntent {
  chainId: number | null;
  router: string | null;
  recipient: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  amountInRaw: string | null;
  amountInHuman: string | null;
  expectedAmountOutRaw: string | null;
  expectedAmountOutHuman: string | null;
  minimumAmountOutRaw: string | null;
  minimumAmountOutHuman: string | null;
  calldata: string | null;
  calldataSelector: string | null;
  valueWei: string | null;
  valuePls: string | null;
  deadlineOrExpiry: string | null;
  gasEstimateFromQuote: number | null;
  routeProtocols: string[];
  routePools: string[];
}

export interface DecodedIntent {
  decodable: boolean;
  method: string | null;
  selector: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  amountInRaw: string | null;
  amountInHuman: string | null;
  minimumAmountOutRaw: string | null;
  minimumAmountOutHuman: string | null;
  recipient: string | null;
  deadline: string | null;
  spender?: string | null;
  approvalAmountRaw?: string | null;
  unlimitedApproval?: boolean;
  decodedExpectedOutputRaw?: string | null;
  nestedTargets: string[];
  unresolvedTargets: string[];
  errors: string[];
}

export interface SimulationCall {
  ethCallOk: boolean;
  ethCallError: string | null;
  ethCallReturnData: string | null;
  estimateGasOk: boolean;
  estimateGasError: string | null;
  gasEstimate: string | null;
}

export interface SimulationResult {
  swap: SimulationCall;
  approval: SimulationCall | null;
  stateOverridesUsed: false;
  economicProfitabilityProven: false;
}

export interface BalanceEvidence {
  walletAddress: string;
  inputToken: string;
  nativeToken: "PLS";
  inputBalanceRaw: string | null;
  inputBalanceHuman: string | null;
  nativeBalanceWei: string | null;
  nativeBalancePls: string | null;
  inputBalanceSufficient: boolean | null;
  gasBalanceSufficient: boolean | null;
  errors: string[];
}

export interface AllowanceEvidence {
  owner: string;
  spender: string | null;
  token: string;
  allowanceRaw: string | null;
  allowanceHuman: string | null;
  requiredAmountRaw: string;
  sufficient: boolean | null;
  error: string | null;
}

export interface ApprovalIntent {
  status: "NOT_EVALUATED" | "NOT_REQUIRED" | "APPROVAL_REQUIRED" | "UNAVAILABLE";
  token: string;
  spender: string | null;
  amountRaw: string | null;
  amountHuman: string | null;
  calldata: string | null;
  valueWei: "0";
  unlimitedApproval: false;
  transactionPrepared: boolean;
  transactionSigned: false;
  transactionSubmitted: false;
  transactionBroadcast: false;
  transactionExecuted: false;
  simulation: SimulationCall | null;
  error: string | null;
}

export interface RouterIntegrity {
  router: string | null;
  expectedRouter: string;
  routerMatchesAllowlist: boolean;
  bytecodePresent: boolean | null;
  routerBytecodeHash: string | null;
  approvedRouterCodeHashes: string[];
  routerCodeHashApproved: boolean | null;
  rpcCodeHashes: Array<{
    rpcUrl: string;
    ok: boolean;
    codeHash: string | null;
    bytecodeLength: number | null;
    error: string | null;
  }>;
  codeHashAgreement: "agrees" | "disagrees" | "single_rpc" | "unavailable";
  warnings: string[];
}

export interface ExecutionTargetsReport {
  executionTargets: Array<{
    address: string;
    role: "router" | "nested_call_target";
    source: string;
    approved: boolean | null;
  }>;
  unresolvedExecutionTargets: string[];
  executionTargetConfidence: "high" | "medium" | "low";
}

export type ReferenceValidityStatus = "VALID" | "INVALID" | "UNAVAILABLE" | "NOT_EVALUATED";
export type CandidateFreshnessStatus = "FRESH" | "STALE" | "EXPIRED" | "UNAVAILABLE" | "NOT_EVALUATED";
export type SandwichTemporalStatus = "COHERENT" | "TOO_SLOW" | "INCOMPLETE";

export interface ReferenceFreshness {
  beforeStatus: ReferenceValidityStatus;
  afterStatus: ReferenceValidityStatus;
  possibleCacheDetected: boolean;
  confidence: "high" | "medium" | "low" | "unavailable";
  warnings: string[];
}

export interface CandidateFreshness {
  status: CandidateFreshnessStatus;
  candidateResponseReceivedAt: string | null;
  explicitQuoteTimestamp: string | null;
  explicitExpiry: string | null;
  ageBeforePreparationMs: number | null;
  ageBeforeSimulationMs: number | null;
  ageAfterSimulationMs: number | null;
  maximumQuoteAgeMs: number;
  warnings: string[];
}

export interface SandwichTemporalCoherence {
  status: SandwichTemporalStatus;
  quoteBatchStartedAt: string;
  quoteBatchCompletedAt: string;
  quoteBatchDurationMs: number;
  maximumBatchDurationMs: number;
}

export interface QuoteFreshness {
  referenceBeforeAcceptable: boolean;
  candidateAcceptable: boolean;
  referenceAfterAcceptable: boolean;
  freshnessAcceptable: boolean;
  referencesByteIdentical: boolean;
  possibleCacheDetected: boolean;
  freshnessConfidence: "high" | "medium" | "low" | "unavailable";
  candidateQuoteAgeMs: number | null;
  candidateAgeBeforePreparationMs: number | null;
  candidateAgeBeforeSimulationMs: number | null;
  candidateAgeAfterSimulationMs: number | null;
  maximumQuoteAgeMs: number;
  batchStartedAt: string;
  batchCompletedAt: string;
  batchDurationMs: number;
  batchDeadlineMs: number;
  referenceBeforeValidityStatus: ReferenceValidityStatus;
  referenceAfterValidityStatus: ReferenceValidityStatus;
  sandwichTemporalStatus: SandwichTemporalStatus;
  referenceFreshness: ReferenceFreshness;
  candidateFreshness: CandidateFreshness;
  sandwichTemporalCoherence: SandwichTemporalCoherence;
  reason: string | null;
}

export interface GasPolicy {
  gasSafetyFactor: number;
  gasSafetyFactorBps: string;
  gasUnits: string | null;
  gasPriceWei: string | null;
  estimatedGasWei: string | null;
  estimatedGasPls: string | null;
  safetyAdjustedGasWei: string | null;
  safetyAdjustedGasPls: string | null;
  maximumGasPls: string | null;
  maximumGasWei: string | null;
  withinMaximumGasPolicy: boolean | null;
  nativeBalanceCoversSafetyAdjustedGas: boolean | null;
}

export interface PhiatShadowBuyCertificate {
  decision: Decision;
  decisionClass: DecisionClass;
  economicDecisionReached: boolean;
  retryable: boolean;
  retryDisposition: RetryDisposition;
  reasons: ShadowBuyReason[];
  reasonSummaries: string[];
  quoteBatchStatus: QuoteBatchStatus;
  allowanceStatus: AllowanceStatus;
  approvalStatus: ApprovalStatus;
  routerIntegrityStatus: RouterIntegrityStatus;
  simulationStatus: SimulationStatus;
  marketContext: Record<string, unknown>;
  exactAmountEvidence: Record<string, unknown>;
  referenceBefore: Record<string, unknown> | null;
  candidateQuote: Record<string, unknown> | null;
  referenceAfter: Record<string, unknown> | null;
  referenceDriftPercent: number | null;
  candidateDeteriorationPercent: number | null;
  actualQuoteCallCount: number;
  rateLimitLease: PiteasRateLimitLeaseStatus | null;
  referenceBeforeValidityStatus: ReferenceValidityStatus;
  referenceAfterValidityStatus: ReferenceValidityStatus;
  candidateFreshnessStatus: CandidateFreshnessStatus;
  sandwichTemporalStatus: SandwichTemporalStatus;
  referenceFreshness: ReferenceFreshness | null;
  candidateFreshness: CandidateFreshness | null;
  sandwichTemporalCoherence: SandwichTemporalCoherence | null;
  quoteFreshness: QuoteFreshness | null;
  rateLimitBudget: PiteasRateLimitReservation | null;
  balances: BalanceEvidence;
  allowance: AllowanceEvidence;
  approvalIntent: ApprovalIntent;
  routerIntegrity: RouterIntegrity;
  executionTargets: ExecutionTargetsReport;
  preparedIntent: PreparedIntent | null;
  decodedIntent: DecodedIntent | null;
  simulation: SimulationResult;
  gasPolicy: GasPolicy;
  policyChecks: Record<string, PolicyCheck>;
  automaticExecutionEligible: boolean;
  swapEvidenceInvalidAfterApproval: boolean;
  transactionPrepared: boolean;
  transactionSigned: false;
  transactionSubmitted: false;
  transactionBroadcast: false;
  transactionExecuted: false;
}

export interface PhiatShadowBuyDeps {
  buildPhiatDashboard: typeof buildPhiatDashboard;
  getPiteasQuote: typeof getPiteasQuote;
  preparePiteasSwap: typeof preparePiteasSwap;
  ethCall: typeof ethCall;
  estimateGas: typeof estimateGas;
  getFeeData: typeof getFeeData;
  reservePiteasRateLimitSlots: typeof reservePiteasRateLimitSlots;
  markPiteasRateLimitSlotAttempted: typeof markPiteasRateLimitSlotAttempted;
  markPiteasRateLimitSlotCompleted: typeof markPiteasRateLimitSlotCompleted;
  releaseUnusedPiteasRateLimitSlots: typeof releaseUnusedPiteasRateLimitSlots;
  getAllowance: (
    config: AppConfig,
    owner: string,
    spender: string,
  ) => Promise<string>;
  getInputBalance: (config: AppConfig, owner: string) => Promise<string>;
  getNativeBalanceWei: (config: AppConfig, owner: string) => Promise<string>;
  getRouterIntegrity: (
    config: AppConfig,
    router: string,
    approvedHashes: string[],
  ) => Promise<RouterIntegrity>;
  nowMs?: () => number;
}
