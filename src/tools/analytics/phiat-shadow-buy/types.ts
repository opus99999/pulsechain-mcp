import type { AppConfig } from "../../../types.js";
import type { PiteasQuoteData, PiteasRateLimitLeaseStatus, PiteasRateLimitReservation } from "../../../data/index.js";
import type { buildPhiatDashboard } from "../phiatDashboard.js";
import type { getPiteasQuote, preparePiteasSwap, ethCall, estimateGas, getFeeData, reservePiteasRateLimitSlots, markPiteasRateLimitSlotAttempted, markPiteasRateLimitSlotCompleted, releaseUnusedPiteasRateLimitSlots } from "../../../data/index.js";
import type {
  LiveExecutionAuthorityStatus,
  ManifestAuthorizationStatus,
  ManifestComparisonResult,
  VerifiedTrustManifest,
} from "./executionTrustManifest.js";

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
  approvedRouterTrustRecords?: ApprovedRouterTrustRecord[];
  approvedExecutionTrustRecords?: ExecutionTrustRecord[];
  signedExecutionTrustManifest?: unknown;
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
export type ManagerIntegrityStatus =
  | "NOT_EVALUATED"
  | "PASSED"
  | "FAILED"
  | "UNAVAILABLE";
export type ExecutionTraceStatus =
  | "NOT_RUN"
  | "PASSED"
  | "FAILED"
  | "UNSUPPORTED"
  | "STATE_INSUFFICIENT";
export type ExecutionGraphStatus =
  | "NOT_EVALUATED"
  | "RESOLVED"
  | "PARTIALLY_RESOLVED"
  | "UNRESOLVED"
  | "FAILED";

export interface ShadowBuyReason {
  code: string;
  stage: string;
  message: string;
  evidence: Record<string, unknown> | null;
}

export interface FailedCheck {
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
  canonicalFunction: string | null;
  method: string | null;
  selector: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  amountInRaw: string | null;
  amountInHuman: string | null;
  minimumOutputRaw: string | null;
  minimumAmountOutRaw: string | null;
  minimumAmountOutHuman: string | null;
  recipient: string | null;
  deadline: string | null;
  nativeValueWei: string | null;
  permitDataPresent: boolean;
  routeDataFingerprint: string | null;
  routeDataRaw: string | null;
  calldataFingerprint: string | null;
  routeData: {
    decodable: boolean;
    destinationToken: string | null;
    expectedOutputRaw: string | null;
    deadline: string | null;
    swapPayloadCount: number;
    swapPayloadFingerprints: string[];
    embeddedAddresses: string[];
    validationErrors: string[];
  } | null;
  executionTargets: ExecutionTargetEvidence[];
  unresolvedExecutionTargets: string[];
  validationErrors: string[];
  spender?: string | null;
  approvalAmountRaw?: string | null;
  unlimitedApproval?: boolean;
  decodedExpectedOutputRaw?: string | null;
  routeExpectedOutputRaw?: string | null;
  minimumOutputValidation?: MinimumOutputValidation | null;
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

export interface ApprovedRouterTrustRecord {
  router?: string;
  codeHash: string;
  chainId?: number;
  implementationAddress?: string | null;
  implementationCodeHash?: string | null;
  label?: string;
}

export type ExecutionTrustRole =
  | "PiteasRouter"
  | "SwapManager"
  | "ManagerImplementation"
  | "DelegatecallTarget"
  | "ProtocolRouter"
  | "PoolFactory"
  | "Pool"
  | "Token";

export interface ExecutionTrustRecord {
  chainId: number;
  address: string;
  role: ExecutionTrustRole;
  runtimeCodeHash: string;
  implementationAddress?: string | null;
  implementationCodeHash?: string | null;
  sourceFingerprint?: string | null;
  approvedSelectors: string[];
  approvalEvidence: string;
  approvedAtBlock?: string | null;
  expiresAtBlockOrTime?: string | null;
  operatorApproved: boolean;
}

export interface RouterIntegrity {
  router: string | null;
  expectedRouter: string;
  routerMatchesAllowlist: boolean;
  bytecodePresent: boolean | null;
  routerBytecodeHash: string | null;
  approvedRouterCodeHashes: string[];
  approvedRouterTrustRecords: ApprovedRouterTrustRecord[];
  routerCodeHashApproved: boolean | null;
  operatorApprovalRequired: boolean;
  trustRecordFingerprint: string | null;
  rpcCodeHashes: Array<{
    rpcUrl: string;
    ok: boolean;
    codeHash: string | null;
    bytecode?: string | null;
    bytecodeLength: number | null;
    blockNumber?: string | null;
    proxyDetected?: boolean | null;
    proxyType?: "none" | "eip1967" | "eip1167" | "unavailable";
    implementationAddress?: string | null;
    implementationCodeHash?: string | null;
    implementationBytecode?: string | null;
    implementationBytecodeLength?: number | null;
    error: string | null;
  }>;
  codeHashAgreement: "agrees" | "disagrees" | "single_rpc" | "unavailable";
  proxyDetection: {
    proxyDetected: boolean | null;
    proxyType: "none" | "eip1967" | "eip1167" | "unavailable";
    implementationAddress: string | null;
    implementationCodeHash: string | null;
    implementationBytecode: string | null;
    implementationBytecodeLength: number | null;
    rpcAgreement: "agrees" | "disagrees" | "single_rpc" | "unavailable";
    blockNumbers: string[];
  };
  warnings: string[];
}

export interface ExecutionTargetEvidence {
  address: string;
  role: "router" | "nested_call_target" | "route_embedded_address";
  selector: string | null;
  codeHash: string | null;
  approved: boolean | null;
  source: string;
}

export interface ExecutionTargetsReport {
  executionTargets: ExecutionTargetEvidence[];
  unresolvedExecutionTargets: string[];
  executionTargetConfidence: "high" | "medium" | "low";
}

export interface SourceEvidence {
  sourceRepository: string;
  sourceCommit: string;
  routerSourceHash: string;
  pitErc20SourceHash: string;
  swapManagerInterfaceSourceHash: string;
  compilerVersion: string;
  optimizerSettings: {
    enabled: boolean;
    runs: number | null;
    evmVersion: string;
  };
  verifiedAbiFingerprint: string;
  verifiedSourceFingerprint: string;
  verifiedAbiFragment: string;
  verifiedRouterAbi: boolean;
  verifiedRouterSource: boolean;
  bytecodeReproduction: {
    attempted: boolean;
    matched: boolean | null;
    reason: string;
  };
}

export interface SwapManagerStorageLayout {
  status: "DERIVED" | "UNAVAILABLE";
  source: {
    repository: string;
    commit: string;
    routerSourceHash: string;
    verifiedSourceFingerprint: string;
  };
  compilerVersion: string;
  contractName: string;
  inheritanceOrder: string[];
  slot: string;
  offsetBytes: number;
  widthBytes: number;
  derivationEvidence: string[];
  layoutFingerprint: string;
  unavailableReason?: string;
}

export interface SwapManagerAddressDecode {
  ok: boolean;
  address: string | null;
  normalizedAddress: string | null;
  zeroAddress: boolean;
  slot: string;
  offsetBytes: number;
  widthBytes: number;
  error: string | null;
}

export interface ActiveSwapManager {
  address: string | null;
  blockNumber: string | null;
  storageSlot: string;
  storageOffsetBytes: number;
  storageWidthBytes: number;
  swapManagerStorageLayout: SwapManagerStorageLayout;
  storageEvidenceByRpc: Array<{
    rpcUrl: string;
    ok: boolean;
    blockNumber: string | null;
    storageWord: string | null;
    decodedAddress: string | null;
    zeroAddress: boolean | null;
    decodeError: string | null;
    error: string | null;
  }>;
  latestChangeEvent: {
    address: string | null;
    blockNumber: string | null;
    transactionHash: string | null;
    logIndex: string | null;
    topic: string;
  } | null;
  storageAgreement: "agrees" | "disagrees" | "single_rpc" | "unavailable";
  storageEventAgreement: "agrees" | "disagrees" | "event_unavailable" | "storage_unavailable";
  officialDocumentationMatch: boolean | null;
  documentationStatus: "MATCHES_CHAIN" | "STALE" | "UNAVAILABLE";
  confidence: "high" | "medium" | "low" | "unavailable";
}

export interface ProxyDetectionEvidence {
  proxyType:
    | "NONE_DETECTED"
    | "EIP1967_IMPLEMENTATION"
    | "EIP1967_BEACON"
    | "EIP1167_MINIMAL"
    | "RECOGNIZED_OTHER"
    | "UNKNOWN_PATTERN";
  implementationAddress: string | null;
  beaconAddress: string | null;
  evidence: Record<string, unknown>;
}

export interface ExecutionOpcodeObservations {
  containsDelegatecallOpcode: boolean | null;
  containsCallcodeOpcode: boolean | null;
  containsCreateOpcode: boolean | null;
  containsCreate2Opcode: boolean | null;
  containsSelfdestructOpcode: boolean | null;
}

export interface SwapManagerIntegrity {
  address: string | null;
  codeHashesByRpc: Array<{
    rpcUrl: string;
    ok: boolean;
    blockNumber: string | null;
    bytecode: string | null;
    runtimeCodeHash: string | null;
    bytecodeLength: number | null;
    error: string | null;
  }>;
  codeHashAgreement: RouterIntegrity["codeHashAgreement"];
  proxyType: "none" | "eip1967" | "eip1967_beacon" | "eip1167" | "unknown" | "unavailable";
  proxyDetection: ProxyDetectionEvidence;
  executionOpcodeObservations: ExecutionOpcodeObservations;
  implementationAddress: string | null;
  implementationCodeHashesByRpc: Array<{
    rpcUrl: string;
    ok: boolean;
    blockNumber: string | null;
    runtimeCodeHash: string | null;
    bytecodeLength: number | null;
    error: string | null;
  }>;
  sourceVerificationStatus: "verified" | "unverified" | "unavailable";
  abiFingerprint: string | null;
  sourceFingerprint: string | null;
  operatorApprovalRequired: boolean;
  trustRecordFingerprint: string | null;
  trusted: boolean;
}

export interface RouterManagerBinding {
  quoteBeforeBlock: string | null;
  candidateQuoteBlock: string | null;
  quoteAfterBlock: string | null;
  certificationBlock: string | null;
  simulationBlock: string | null;
  managerChangedSinceQuote: boolean | null;
  routerCodeChangedSinceQuote: boolean | null;
  managerCodeChangedSinceQuote: boolean | null;
}

export interface RouteDataCertification {
  rawFingerprint: string | null;
  length: number;
  managerCodeHash: string | null;
  decoderVersion: string;
  decoderMatchesManagerHash: boolean;
  authoritativeFields: string[];
  heuristicObservations: Array<{
    kind: string;
    value: string;
    source: string;
  }>;
}

export interface TraceBackend {
  rpc: string | null;
  method: "debug_traceCall" | "trace_call" | null;
  blockNumber: string | null;
  stateOverridesUsed: boolean;
  supported: boolean;
  failureReason: string | null;
}

export interface RouterCallSequenceEntry {
  callType: string;
  from: string | null;
  to: string | null;
  selector: string | null;
  value: string | null;
  success: boolean | null;
  gasUsed: string | null;
  codeHash: string | null;
  classification: string;
}

export interface ExecutionGraphCall {
  depth: number;
  callType: string;
  from: string | null;
  to: string | null;
  selector: string | null;
  value: string | null;
  inputFingerprint: string | null;
  outputFingerprint: string | null;
  success: boolean | null;
  revertReason: string | null;
  codeHash: string | null;
  protocolClassification: string;
  trustStatus: "trusted" | "untrusted" | "unresolved" | "prohibited";
}

export interface InternalApprovalEvidence {
  token: string | null;
  ownerContext: string;
  spender: string | null;
  amount: string | null;
  initiatedBy: string | null;
  walletApproval: boolean;
  managerInternalApproval: boolean;
  approvedByPolicy: boolean;
}

export interface ExecutionLayerCertification {
  sourceEvidence: SourceEvidence;
  managerIntegrityStatus: ManagerIntegrityStatus;
  executionTraceStatus: ExecutionTraceStatus;
  executionGraphStatus: ExecutionGraphStatus;
  activeSwapManager: ActiveSwapManager;
  swapManagerIntegrity: SwapManagerIntegrity;
  routerManagerBinding: RouterManagerBinding;
  routeData: RouteDataCertification;
  traceBackend: TraceBackend;
  routerCallSequence: RouterCallSequenceEntry[];
  executionGraph: ExecutionGraphCall[];
  approvedTargets: ExecutionTrustRecord[];
  unresolvedTargets: string[];
  prohibitedOperations: string[];
  internalApprovals: InternalApprovalEvidence[];
  managerChangedSinceQuote: boolean | null;
  trustRecordFingerprint: string | null;
  automaticExecutionEligible: boolean;
  trustManifestVerification: VerifiedTrustManifest | null;
  trustManifestComparison: ManifestComparisonResult | null;
  manifestAuthorizationStatus: ManifestAuthorizationStatus | "MISSING";
  liveExecutionAuthorityStatus: LiveExecutionAuthorityStatus | "MISSING";
  executionAuthority:
    | "VALID"
    | "INVALID"
    | "EXPIRED"
    | "STATE_MISMATCH"
    | "NOT_EVALUATED"
    | "GRAPH_MISMATCH"
    | "REVOCATION_UNAVAILABLE"
    | "TRACE_UNAVAILABLE"
    | "MISSING";
  failureCodes: string[];
  validationErrors: string[];
  warnings: string[];
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
  estimatedGasCostPls: string | null;
  safetyAdjustedGasWei: string | null;
  safetyAdjustedGasPls: string | null;
  safetyAdjustedGasCostPls: string | null;
  estimatedGasCostUsd: string | null;
  gasCostAsPercentOfInputValue: number | null;
  maximumGasPls: string | null;
  maximumGasWei: string | null;
  withinMaximumGasPolicy: boolean | null;
  nativeBalanceCoversSafetyAdjustedGas: boolean | null;
}

export interface MinimumOutputValidation {
  apiExpectedOutputRaw: string | null;
  apiMinimumOutputRaw: string | null;
  quoteRouteMinimumOutputRaw: string | null;
  methodParametersMinimumOutputRaw: string | null;
  decodedDestMinAmountRaw: string | null;
  decodedReturnConstraintRaw: string | null;
  allowedSlippagePercent: number | null;
  sourceForEachValue: Record<string, string>;
  relationship:
    | "EXACT_MATCH"
    | "CALLDATA_STRICTER"
    | "CALLDATA_WEAKER"
    | "SEMANTICS_UNRESOLVED";
  authoritativeQuoteField: string | null;
  validationStatus: "PASSED" | "FAILED";
  explanation: string;
  evidenceFingerprint: string | null;
}

export interface PhiatShadowBuyCertificate {
  decision: Decision;
  decisionClass: DecisionClass;
  primaryDecisionClass: DecisionClass;
  secondaryDecisionClasses: DecisionClass[];
  economicDecisionReached: boolean;
  transactionIntegrityDecisionReached: boolean;
  retryable: boolean;
  retryDisposition: RetryDisposition;
  reasons: ShadowBuyReason[];
  passedChecks: string[];
  failedChecks: FailedCheck[];
  warnings: string[];
  reasonSummaries: string[];
  quoteBatchStatus: QuoteBatchStatus;
  allowanceStatus: AllowanceStatus;
  approvalStatus: ApprovalStatus;
  routerIntegrityStatus: RouterIntegrityStatus;
  managerIntegrityStatus: ManagerIntegrityStatus;
  simulationStatus: SimulationStatus;
  executionTraceStatus: ExecutionTraceStatus;
  executionGraphStatus: ExecutionGraphStatus;
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
  executionLayer: ExecutionLayerCertification;
  activeSwapManager: ActiveSwapManager;
  swapManagerIntegrity: SwapManagerIntegrity;
  routerManagerBinding: RouterManagerBinding;
  routeData: RouteDataCertification;
  traceBackend: TraceBackend;
  routerCallSequence: RouterCallSequenceEntry[];
  executionGraph: ExecutionGraphCall[];
  approvedTargets: ExecutionTrustRecord[];
  unresolvedTargets: string[];
  prohibitedOperations: string[];
  managerChangedSinceQuote: boolean | null;
  trustRecordFingerprint: string | null;
  preparedIntent: PreparedIntent | null;
  decodedIntent: DecodedIntent | null;
  minimumOutputValidation: MinimumOutputValidation | null;
  simulation: SimulationResult;
  gasPolicy: GasPolicy;
  policyChecks: Record<string, PolicyCheck>;
  manifestAuthorizationStatus: ExecutionLayerCertification["manifestAuthorizationStatus"];
  liveExecutionAuthorityStatus: ExecutionLayerCertification["liveExecutionAuthorityStatus"];
  executionAuthority: ExecutionLayerCertification["executionAuthority"];
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
    approvedTrustRecords?: ApprovedRouterTrustRecord[],
  ) => Promise<RouterIntegrity>;
  certifyExecutionLayer: (
    config: AppConfig,
    args: {
      walletAddress: string;
      router: string;
      tokenIn: string;
      tokenOut: string;
      recipient: string;
      amountInRaw: string;
      calldata: string;
      valueWei: string;
      routeDataRaw: string | null;
      referenceBeforeBlock: string | null;
      candidateQuoteBlock: string | null;
      referenceAfterBlock: string | null;
      approvedTrustRecords: ExecutionTrustRecord[];
      signedExecutionTrustManifest?: unknown;
      routerCodeHash?: string | null;
    },
  ) => Promise<ExecutionLayerCertification>;
  nowMs?: () => number;
}
