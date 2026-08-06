import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  formatUnits,
  parseAbiItem,
  parseUnits,
} from "viem";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  EUSDC_ADDRESS,
  HEX_ADDRESS,
  INC_ADDRESS,
  PLSX_ADDRESS,
  PULSECHAIN_CHAIN_ID,
  WPLS_ADDRESS,
} from "../../constants.js";
import {
  fetchPairsForToken,
  fetchSwapsAdvanced,
  getChainId,
  getErc20Metadata,
  getFeeData,
  getNativeBalance,
  getPiteasQuote,
  getPublicClient,
  getTransactionReceipt,
  preparePiteasSwap,
  type PiteasQuoteData,
  type PiteasQuoteResult,
  type PiteasPrepareResult,
  type SubgraphPair,
  type SubgraphSwap,
} from "../../data/index.js";
import {
  decodePiteasRouterSwapCalldata,
  EUSDC_TOKEN_ADDRESS,
  fingerprint,
  PITEAS_ROUTER_SWAP_SELECTOR,
  sameAddress,
  VERIFIED_PITEAS_ROUTER,
  type PiteasTopLevelSwapIntent,
} from "../../piteas/routerIntent.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { neverReturnPrivateKey } from "../../utils/safety.js";
import {
  atomicWriteJson,
  agentWalletSystemStatus,
  buildAgentIntentView,
  executeAgentTx,
  getAgentWalletInfo,
  inspectTokenNotional,
  listAgentWallets,
  loadProposal,
  proposeAgentTx,
  withWalletLock,
  type AgentIntentView,
  type AgentWalletPublicInfo,
  type SimulationResult,
  type TxProposal,
  type TxProposalWithReview,
} from "../../wallet/index.js";
import { registerTool } from "../define.js";
import {
  assertCalldataHandoffIntegrity,
  buildCalldataCheckpoint,
  estimateGasCost,
  maxGasEstimate,
  readErc20Allowance,
  readErc20Balance,
  routeProtocols,
  simulateSameBlockTwoRpc,
  validateDecodedIntent,
  validateExecutableCalldata,
  validateQuoteFields,
  validateTwoRpcSimulation,
  validateWalletInspection,
  type CalldataCheckpoint,
  type RpcPinnedSimulationRow,
} from "./piteasProposeAgentSwap.js";

export type RotationCandidateId = "PLS" | "PLSX" | "INC" | "PHEX" | "PRVX";

export type RotationCycleState =
  | "EUSDC_IDLE"
  | "SCANNING"
  | "ENTRY_CANDIDATE_SELECTED"
  | "ENTRY_APPROVAL_REQUIRED"
  | "ENTRY_PROPOSAL_READY"
  | "ENTRY_BROADCASTING"
  | "POSITION_OPEN"
  | "EXIT_SIGNAL_AVAILABLE"
  | "EXIT_APPROVAL_REQUIRED"
  | "EXIT_PROPOSAL_READY"
  | "EXIT_BROADCASTING"
  | "CYCLE_COMPLETE"
  | "RECONCILIATION_REQUIRED"
  | "MANUAL_REVIEW"
  | "ABORTED";

export type RotationScanDecision =
  | "HOLD_EUSDC"
  | "CANDIDATE_SELECTED"
  | "INSUFFICIENT_HISTORY"
  | "INSUFFICIENT_EVIDENCE"
  | "TARGET_ECONOMICALLY_INFEASIBLE"
  | "DATA_SOURCE_FAILURE";

export type RotationAnalysisMode =
  | "DENSE_CANDLES"
  | "SPARSE_EVENT_TIME"
  | "UNUSABLE_HISTORY";

export type RotationMetricUnit =
  | "token_raw"
  | "token_human"
  | "eusdc"
  | "usd"
  | "percent"
  | "bps"
  | "count"
  | "minutes";

export type RotationRouteAvailabilityStatus =
  | "DIRECT_POOL"
  | "MULTIHOP_VIA_WPLS"
  | "MULTIHOP_OTHER_VERIFIED"
  | "UNKNOWN_UNTIL_EXECUTABLE_QUOTE"
  | "UNAVAILABLE"
  | "both_directions"
  | "missing_entry"
  | "missing_exit"
  | "none";

export type RotationProposalClassification =
  | "READY_FOR_HUMAN_CONFIRMATION"
  | "SCAN_NOT_FOUND"
  | "SCAN_STALE"
  | "SCAN_FINGERPRINT_MISMATCH"
  | "CANDIDATE_MISMATCH"
  | "NO_OPEN_POSITION"
  | "OPEN_POSITION_EXISTS"
  | "ENTRY_BOUNDED_APPROVAL_REQUIRED"
  | "EXIT_BOUNDED_APPROVAL_REQUIRED"
  | "INVALID_SLIPPAGE"
  | "GAS_COST_ABOVE_LIMIT"
  | "MINIMUM_OUTPUT_BELOW_FLOOR"
  | "INFRASTRUCTURE_REQUOTE_REQUIRED"
  | "PITEAS_MALFORMED_CALLDATA"
  | "CALLDATA_HANDOFF_MISMATCH"
  | "ROUTE_NOT_EXECUTABLE"
  | "RPC_STATE_DISAGREEMENT"
  | "QUOTE_STALE"
  | "PROPOSAL_INTERNAL_SIMULATION_FAILED"
  | "SAVED_PROPOSAL_INTEGRITY_MISMATCH"
  | "WALLET_RUNTIME_BLOCKED"
  | "TOKEN_VALIDATION_FAILED"
  | "INSUFFICIENT_BALANCE"
  | "UNKNOWN_FAIL_CLOSED";

export interface RotationCandidateRegistryEntry {
  candidateId: RotationCandidateId;
  displaySymbol: string;
  executionTokenAddress: `0x${string}`;
  expectedSymbol: string;
  expectedNamePatterns: string[];
  expectedDecimals: number;
  baseAssetAddress: `0x${string}`;
  enabled: boolean;
  minimumLiquidityUsd: number;
  minimumRecentVolumeUsd: number;
  maximumPriceImpactPercent: number;
  maximumSlippagePercent: number;
  maximumGasCostPlsPerLeg: string;
}

export const PRVX_ADDRESS =
  "0xF6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11" as const;

export const EUSDC_ROTATION_CANDIDATES: readonly RotationCandidateRegistryEntry[] = [
  {
    candidateId: "PLS",
    displaySymbol: "PLS",
    executionTokenAddress: WPLS_ADDRESS,
    expectedSymbol: "WPLS",
    expectedNamePatterns: ["wrapped pls", "wrapped pulse"],
    expectedDecimals: 18,
    baseAssetAddress: EUSDC_ADDRESS,
    enabled: true,
    minimumLiquidityUsd: 25_000,
    minimumRecentVolumeUsd: 1_000,
    maximumPriceImpactPercent: 0.5,
    maximumSlippagePercent: 0.5,
    maximumGasCostPlsPerLeg: "1500",
  },
  {
    candidateId: "PLSX",
    displaySymbol: "PLSX",
    executionTokenAddress: PLSX_ADDRESS,
    expectedSymbol: "PLSX",
    expectedNamePatterns: ["pulsex"],
    expectedDecimals: 18,
    baseAssetAddress: EUSDC_ADDRESS,
    enabled: true,
    minimumLiquidityUsd: 25_000,
    minimumRecentVolumeUsd: 1_000,
    maximumPriceImpactPercent: 0.5,
    maximumSlippagePercent: 0.5,
    maximumGasCostPlsPerLeg: "1500",
  },
  {
    candidateId: "INC",
    displaySymbol: "INC",
    executionTokenAddress: INC_ADDRESS,
    expectedSymbol: "INC",
    expectedNamePatterns: ["incentive"],
    expectedDecimals: 18,
    baseAssetAddress: EUSDC_ADDRESS,
    enabled: true,
    minimumLiquidityUsd: 15_000,
    minimumRecentVolumeUsd: 750,
    maximumPriceImpactPercent: 0.6,
    maximumSlippagePercent: 0.5,
    maximumGasCostPlsPerLeg: "1500",
  },
  {
    candidateId: "PHEX",
    displaySymbol: "pHEX",
    executionTokenAddress: HEX_ADDRESS,
    expectedSymbol: "HEX",
    expectedNamePatterns: ["hex"],
    expectedDecimals: 8,
    baseAssetAddress: EUSDC_ADDRESS,
    enabled: true,
    minimumLiquidityUsd: 20_000,
    minimumRecentVolumeUsd: 1_000,
    maximumPriceImpactPercent: 0.5,
    maximumSlippagePercent: 0.5,
    maximumGasCostPlsPerLeg: "1500",
  },
  {
    candidateId: "PRVX",
    displaySymbol: "PRVX",
    executionTokenAddress: PRVX_ADDRESS,
    expectedSymbol: "PRVX",
    expectedNamePatterns: ["prvx", "provex"],
    expectedDecimals: 18,
    baseAssetAddress: EUSDC_ADDRESS,
    enabled: true,
    minimumLiquidityUsd: 10_000,
    minimumRecentVolumeUsd: 500,
    maximumPriceImpactPercent: 0.6,
    maximumSlippagePercent: 0.5,
    maximumGasCostPlsPerLeg: "1500",
  },
] as const;

const DEFAULT_LOOKBACK_MINUTES = 1440;
const DEFAULT_CANDLE_MINUTES = 5;
const DEFAULT_MINIMUM_DIP_BPS = 100;
const DEFAULT_MINIMUM_REBOUND_BPS = 20;
const DEFAULT_MINIMUM_NET_TARGET_BPS = 100;
const DEFAULT_MAX_QUOTE_AGE_MS = 60_000;
const DEFAULT_ALLOWED_SLIPPAGE_PERCENT = 0.5;
const DEFAULT_MAX_GAS_COST_PLS = "1500";
const SCAN_FRESHNESS_MS = 5 * 60_000;
const PITEAS_QUOTE_RATE_WINDOW_MS = 60_000;
const PITEAS_QUOTE_RATE_LIMIT = 10;
const DEFAULT_HISTORY_LOOKBACK_MINUTES = 10_080;
const DEFAULT_HISTORY_RETENTION_DAYS = 7;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_HISTORY_MAX_PAGES = 32;
const DEFAULT_LOG_CHUNK_BLOCKS = 25_000;
const DEFAULT_HISTORY_MAX_RUNTIME_MS = 180_000;
const MAX_HISTORY_MAX_RUNTIME_MS = 220_000;
const HISTORY_RUNTIME_GUARD_MS = 10_000;
const HISTORY_SOURCE_REQUEST_TIMEOUT_MS = 5_000;
const HISTORY_MIN_REQUEST_TIMEOUT_MS = 1_000;
const HISTORY_CHECKPOINT_SCHEMA_VERSION = 1;
const HISTORY_STORE_SCHEMA_VERSION = 1;
const HISTORY_RECENT_REORG_BLOCKS = 64n;
const ANCHOR_MAX_AGE_SECONDS = 15 * 60;
const REQUIRED_POOL_MIN_LIQUIDITY_EUSDC = 1_000;
const REQUIRED_POOL_MIN_RECENT_VOLUME_EUSDC = 10;
const SPARSE_MIN_ACTUAL_SWAPS = 20;
const SPARSE_MAX_GAP_MINUTES = 360;
const FRESH_TRADE_MAX_AGE_MINUTES = 30;
const PRICE_CARRY_FORWARD_MAX_MINUTES = 60;

const v2SwapEventAbi = parseAbiItem(
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
);
const ROUTER = VERIFIED_PITEAS_ROUTER;

const walletIdSchema = z.string().regex(/^aw_[a-f0-9]{32}$/);
const candidateIdSchema = z.enum(["PLS", "PLSX", "INC", "PHEX", "PRVX"]);
const proposalIdSchema = z.string().regex(/^prop_[a-f0-9]{24}$/);
const decimalUintSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
const positiveDecimalPlsSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface RotationScanInput {
  walletId: string;
  lookbackMinutes?: number;
  candleMinutes?: number;
  minimumDipBps?: number;
  minimumReboundConfirmationBps?: number;
  minimumNetTargetBps?: number;
}

export interface RotationTokenValidation {
  chainId: number;
  codeExists: boolean;
  symbol: string;
  name: string;
  decimals: number;
  transferProbeOk: boolean;
  balanceOfReadable: boolean;
  allowanceReadable: boolean;
  routeToBaseAvailable: boolean;
  routeFromBaseAvailable: boolean;
  ok: boolean;
  rejectionReasons: string[];
}

export interface RotationMarketEvidence {
  relevantPools: string[];
  largestPoolLiquidityUsd: number;
  aggregateLiquidityUsd: number;
  largestPoolLiquidityEusdc?: number;
  aggregateLiquidityEusdc?: number;
  recentVolumeUsd: number;
  recentVolumeEusdc?: number;
  tradeCount: number;
  uniqueTransactionCount?: number;
  fiveMinuteReturnBps: number | null;
  fifteenMinuteReturnBps: number | null;
  oneHourReturnBps: number | null;
  sixHourReturnBps: number | null;
  distanceFromOneHourHighBps: number | null;
  distanceFromOneHourLowBps: number | null;
  reboundFromRecentLocalLowBps: number | null;
  realizedVolatilityBps: number | null;
  directionalTrendScore: number;
  meanReversionScore: number;
  liquidityScore: number;
  volumeScore: number;
  routeQualityScore: number;
  volatilitySuitabilityScore: number;
  estimatedPriceImpactPercent: number | null;
  routeAvailabilityStatus: RotationRouteAvailabilityStatus;
  entryRouteAvailability?: RotationRouteAvailabilityStatus;
  exitRouteAvailability?: RotationRouteAvailabilityStatus;
  evidenceFresh: boolean;
  dataSourceErrors: string[];
  poolsUsed?: string[];
  tokenPath?: string[];
  metrics?: Record<string, RotationMetric<unknown> | RotationUnavailableMetric>;
  candleCoverage?: RotationCandleCoverage;
  dipReboundEvidence?: RotationDipReboundEvidence;
  historyQuality?: RotationHistoryQuality;
  targetAwareReversion?: RotationTargetAwareReversion;
  poolConsolidation?: RotationPoolConsolidation;
  dataSourcesUsed?: string[];
  dataFreshness?: string;
  diagnosticRankReason?: string;
}

export interface RotationCandidateScanRow {
  candidateId: RotationCandidateId;
  displaySymbol: string;
  executionTokenAddress: `0x${string}`;
  addressValidation: RotationTokenValidation;
  symbol: string;
  decimals: number;
  relevantPools: string[];
  largestPoolLiquidityUsd: number;
  aggregateLiquidityUsd: number;
  largestPoolLiquidityEusdc?: number;
  aggregateLiquidityEusdc?: number;
  recentVolumeUsd: number;
  recentVolumeEusdc?: number;
  tradeCount: number;
  uniqueTransactionCount?: number;
  fiveMinuteReturnBps: number | null;
  fifteenMinuteReturnBps: number | null;
  oneHourReturnBps: number | null;
  sixHourReturnBps: number | null;
  distanceFromRollingOneHourHighBps: number | null;
  distanceFromRollingOneHourLowBps: number | null;
  reboundFromMostRecentLocalLowBps: number | null;
  realizedVolatilityBps: number | null;
  directionalTrendScore: number;
  meanReversionScore: number;
  liquidityScore: number;
  volumeScore: number;
  estimatedPriceImpactForCompleteEusdcBalancePercent: number | null;
  routeAvailabilityStatus: RotationMarketEvidence["routeAvailabilityStatus"];
  entryRouteAvailability?: RotationRouteAvailabilityStatus;
  exitRouteAvailability?: RotationRouteAvailabilityStatus;
  eligibility: boolean;
  score: number;
  rejectionReasons: string[];
  metrics?: Record<string, RotationMetric<unknown> | RotationUnavailableMetric>;
  metricAvailability?: Record<string, RotationMetricStatus>;
  candleCoverage?: RotationCandleCoverage;
  dipReboundEvidence?: RotationDipReboundEvidence;
  historyQuality?: RotationHistoryQuality;
  targetAwareReversion?: RotationTargetAwareReversion;
  poolConsolidation?: RotationPoolConsolidation;
  dataSourcesUsed?: string[];
  dataFreshness?: string;
  rankingStatus?: "ELIGIBLE_RANKED" | "UNRANKED_NO_EVIDENCE" | "UNRANKED_INCOMPLETE_HISTORY" | "TIED";
}

export interface RotationCandidateSelectionReadiness {
  candidateId: RotationCandidateId;
  ready: boolean;
  analysisMode: RotationAnalysisMode | null;
  currentSignalWindowReady: boolean;
  sevenDayStatisticsReady: boolean;
  blockers: string[];
  warnings: string[];
}

export interface RotationScanResult {
  ok: boolean;
  decision: RotationScanDecision;
  walletId: string;
  walletAddress?: `0x${string}`;
  state: RotationCycleState;
  scannedAt: string;
  expiresAt: string;
  scanFingerprint: `0x${string}`;
  quoteCallCount: number;
  candidates: RotationCandidateScanRow[];
  winner?: RotationCandidateId;
  rankedCandidateIds: RotationCandidateId[];
  diagnosticOrdering?: RotationCandidateId[];
  readyCandidateRanking?: RotationCandidateId[];
  eligibleCandidateRanking?: RotationCandidateId[];
  historyReady: boolean;
  readyCandidateIds: RotationCandidateId[];
  incompleteCandidateIds: RotationCandidateId[];
  selectionCandidateIds: RotationCandidateId[];
  selectionScope: "READY_CANDIDATES_ONLY";
  candidateReadiness: RotationCandidateSelectionReadiness[];
  historyDecisionReason: string;
  tiedCandidateIds?: RotationCandidateId[];
  economicFeasibility?: RotationEconomicFeasibility;
  noPiteasQuoteUsed: true;
  noLiveTransaction: true;
  reason?: string;
}

export interface RotationMetric<T = unknown> {
  value: T;
  unit: RotationMetricUnit;
  source: string;
  sourceTimestamp: string | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  sampleCount: number;
  pageCount: number;
  truncated: boolean;
  coveragePercent: number;
  stale: boolean;
  confidence: "high" | "medium" | "low" | "none";
  warnings: string[];
}

export interface RotationUnavailableMetric {
  status: "UNAVAILABLE";
  reason: string;
  unit: RotationMetricUnit;
  source: string;
  requiredSamples: number;
  availableSamples: number;
  warnings: string[];
}

export interface RotationMetricStatus {
  status: "AVAILABLE" | "UNAVAILABLE";
  reason?: string;
  requiredSamples?: number;
  availableSamples?: number;
}

export interface RotationCandle {
  startTimestamp: string;
  endTimestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeEusdc: number;
  tradeCount: number;
  sourceSwapIds: string[];
  carriedForward: boolean;
}

export interface RotationCandleCoverage {
  expectedCandles: number;
  populatedCandles: number;
  activeTradeCandles: number;
  coveragePercent: number;
  activeTradeCandlePercent?: number;
  sourceCompletenessPercent?: number;
  priceContinuityPercent?: number;
  analysisMode?: RotationAnalysisMode;
  maximumDataGapMinutes: number | null;
  mostRecentTradeAgeMinutes: number | null;
  missingBuckets: number;
  truncated: boolean;
  sparseMarketMethodUsed: boolean;
  unresolvedGaps?: string[];
}

export interface RotationDipReboundEvidence {
  status: "AVAILABLE" | "UNAVAILABLE";
  referenceTimestamp?: string;
  referencePrice?: number;
  localLowTimestamp?: string;
  localLowPrice?: number;
  currentTimestamp?: string;
  currentPrice?: number;
  dipBps?: number;
  reboundBps?: number;
  candlesInvolved: number;
  volumeConfirmation: boolean;
  trendRejected: boolean;
  reason?: string;
}

export interface RotationHistoryQuality {
  sourceCompletenessPercent: number;
  activeTradeCandlePercent: number;
  priceContinuityPercent: number;
  analysisMode: RotationAnalysisMode;
  latestTradeAgeMinutes: number | null;
  maximumObservedGapMinutes: number | null;
  actualTradeCount: number;
  sourceTruncated: boolean;
  unresolvedGaps: string[];
  readinessForLiveScanning: boolean;
}

export interface RotationHistoricalReversionEvidence {
  targetBps: number;
  completedReversions: number;
  failedReversions: number;
  completionRatePercent: number;
  medianCompletionTimeMinutes: number | null;
  medianAdverseContinuationBps: number | null;
  worstAdverseContinuationBps: number | null;
  daysWithNoQualifyingReversal: number;
}

export interface RotationTargetAwareReversion {
  requestedNetTargetBps: number;
  requiredGrossMoveBps: number;
  currentDipBps: number | null;
  currentReboundBps: number | null;
  projectedRemainingMoveBps: number | null;
  historicalProbabilityOfCompletionPercent: number;
  medianTimeToCompleteMinutes: number | null;
  simpleOnePercentReversions: RotationHistoricalReversionEvidence;
  dynamicTargetReversions: RotationHistoricalReversionEvidence;
  dynamicGrossMoveSupported: boolean;
}

export interface RotationPoolConsolidation {
  primaryPool: string | null;
  eligiblePools: string[];
  excludedPools: Array<{ pool: string; reason: string }>;
  aggregateLiquidityEusdc: number;
  largestPoolLiquidityEusdc: number;
  liquidityConcentrationPercent: number;
  consolidatedPriceEusdc: number | null;
  priceDispersionPercent: number | null;
}

export interface RotationEconomicFeasibility {
  simpleTargetRaw: string;
  estimatedCycleGasEusdcRaw: string;
  routeCostEusdcRaw: string;
  safetyBufferRaw: string;
  dynamicTargetRaw: string;
  requiredGrossMoveBps: number;
  onePercentTargetEconomicallyPlausible: boolean;
  gasConversionSource: string;
}

export interface RotationHistoryRecord {
  chainId: number;
  candidateId: RotationCandidateId;
  poolAddress: `0x${string}`;
  factoryAddress: `0x${string}` | null;
  protocol: string;
  sourceVersion?: RotationHistorySourceVersion;
  eventAdapter?: RotationHistoryEventAdapter;
  anchorPoolAddress?: `0x${string}`;
  anchorAgeSeconds?: number;
  blockNumber: string | null;
  blockHash: `0x${string}` | null;
  transactionHash: `0x${string}`;
  logIndex: number;
  timestamp: number;
  token0: `0x${string}`;
  token1: `0x${string}`;
  amount0Raw: string;
  amount1Raw: string;
  candidatePriceEusdc: number;
  eusdcNotionalRaw: string;
  source: string;
  fetchedAt: string;
}

export type RotationHistorySourceVersion =
  | "PULSEX_V1"
  | "PULSEX_V2"
  | "VERIFIED_V3"
  | "VERIFIED_STABLE"
  | "UNKNOWN";

export type RotationHistoryEventAdapter =
  | "PULSEX_V2_STYLE_SWAP"
  | "VERIFIED_V3_SWAP"
  | "VERIFIED_STABLE_SWAP"
  | "UNSUPPORTED";

export type RotationHistoryPoolClassification =
  | "REQUIRED_PRICE_POOL"
  | "OPTIONAL_DIAGNOSTIC_POOL"
  | "EXCLUDED_POOL";

export type RotationHistorySyncCode =
  | "COMPLETE"
  | "PARTIAL_PROGRESS"
  | "HISTORY_SYNC_BUSY"
  | "CHECKPOINT_WINDOW_MISMATCH"
  | "CHECKPOINT_STALLED"
  | "SOURCE_ERROR"
  | RotationHistoryStoreReviewCode;

export type RotationHistorySyncPurpose =
  | "RECENT_SIGNAL_WINDOW"
  | "HISTORICAL_BACKFILL";

export type RotationRecentRefreshPhase =
  | "TIP_REFRESH"
  | "SIGNAL_WINDOW_BACKFILL"
  | "SIGNAL_WINDOW_COMPLETE";

export type RotationTipFreshnessStatus =
  | "TIP_NOT_SCANNED"
  | "TIP_SCANNED_NO_RECENT_TRADES"
  | "TIP_SCANNED_RECENT_TRADES_FOUND"
  | "ANCHOR_TIP_INCOMPLETE"
  | "REQUIRED_POOL_TIP_INCOMPLETE"
  | "PIPELINE_STALE"
  | "MARKET_QUIET";

export interface RotationHistorySourcePoolRef {
  pair: SubgraphPair;
  protocol: string;
  sourceVersion: RotationHistorySourceVersion;
  subgraphVersion?: "v1" | "v2";
  subgraphEndpoint: string;
  eventAdapter: RotationHistoryEventAdapter;
  factoryAddress: `0x${string}` | null;
  classification: RotationHistoryPoolClassification;
  contributesToConsolidatedPrice: boolean;
  liquidityEusdc: number;
  recentVolumeEusdc: number;
  exclusionReason?: string;
}

export interface RotationHistoryPoolSyncStatus {
  candidateId: RotationCandidateId;
  poolAddress: `0x${string}`;
  token0?: `0x${string}`;
  token1?: `0x${string}`;
  token0Decimals?: number;
  token1Decimals?: number;
  factoryAddress?: `0x${string}` | null;
  protocol?: string;
  sourceVersion?: RotationHistorySourceVersion;
  eventAdapter?: RotationHistoryEventAdapter;
  sourceEndpoint: string;
  queryType: string;
  pageSize: number;
  maximumPageCount: number;
  cursorMechanism: string;
  resolvedStartBlock?: string | null;
  resolvedEndBlock?: string | null;
  scannedFromBlock?: string | null;
  scannedToBlock?: string | null;
  rangeFullyScanned?: boolean;
  firstObservedTradeTimestamp?: string | null;
  lastObservedTradeTimestamp?: string | null;
  contributesToConsolidatedPrice?: boolean;
  classification?: RotationHistoryPoolClassification;
  liquidityEusdc?: number;
  recentVolumeEusdc?: number;
  exclusionReason?: string;
  exactRemainingTruncationCause?: string;
  retrievalCompletenessPercent?: number;
  signalWindowCompletenessPercent?: number;
  tipFreshnessStatus?: RotationTipFreshnessStatus;
  tipCompletenessPercent?: number;
  tipLagBlocks?: number;
  tipLagMinutes?: number;
  latestSourceTradeTimestamp?: string | null;
  lastScannedBlockTimestamp?: string | null;
  timestampResolutionMaxErrorSeconds?: number;
  rpcRecordsRetrieved?: number;
  anchorRecordsUsed?: number;
  unsupportedLogs?: number;
  blocksScanned?: number;
  logsRetrieved?: number;
  validRecordsProduced?: number;
  recordsAdded?: number;
  duplicateRecordsIgnored?: number;
  errors?: string[];
  nextResumeBlock?: string | null;
  elapsedMs?: number;
  oldestReturnedRecord: string | null;
  newestReturnedRecord: string | null;
  requestedStartTime: string;
  requestedEndTime: string;
  totalRecordsRetrieved: number;
  deduplicatedRecords: number;
  boundaryCrossed: boolean;
  truncationReason:
    | "NONE"
    | "SOURCE_ROW_LIMIT"
    | "PAGINATION_BUG_OR_REPEATED_CURSOR"
    | "SPARSE_ACTUAL_TRADING"
    | "STALE_POOL"
    | "MISSING_POOL_DISCOVERY"
    | "FAILED_BLOCK_TO_TIME_CONVERSION"
    | "UNSUPPORTED_EVENT_ABI"
    | "RPC_LOG_RANGE_LIMITATION"
    | "PARTIAL_PROGRESS"
    | "SOURCE_ERROR";
  completedRangeScanned?: boolean;
  sourceRepeatsOrCapsRecords: boolean;
  historicalPaginationReliable: boolean;
  fallbackUsed?: "NONE" | "RPC_ETH_GETLOGS";
  fallbackRecords?: number;
  error?: string;
}

export interface RotationHistoryCandidateSyncStatus {
  candidateId: RotationCandidateId;
  syncPurpose?: RotationHistorySyncPurpose;
  recordsAdded: number;
  recordsUpdated: number;
  duplicateRecordsIgnored: number;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  boundaryCrossed: boolean;
  sourceCompletenessPercent: number;
  retrievalCompletenessPercent?: number;
  signalWindowCompletenessPercent?: number;
  sevenDayCompletenessPercent?: number;
  tipFreshnessStatus?: RotationTipFreshnessStatus;
  tipCompletenessPercent?: number;
  latestSourceTradeAgeMinutes?: number | null;
  pipelineLagMinutes?: number | null;
  requiredPoolsComplete?: boolean;
  anchorTipComplete?: boolean;
  unresolvedGaps: string[];
  pools: RotationHistoryPoolSyncStatus[];
}

export type RotationHistoryStorePathSource =
  | "MODULE_ROOT_DEFAULT"
  | "CONFIG_OVERRIDE";

export type RotationHistoryStoreReviewCode =
  | "OK"
  | "LEGACY_PUBLIC_HISTORY_MIGRATION_REQUIRED"
  | "MULTIPLE_PUBLIC_HISTORY_STORES_REQUIRE_REVIEW";

export type RotationHistoryCrossProcessLockStatus =
  | "not_checked"
  | "free"
  | "acquired"
  | "released"
  | "busy_live_owner"
  | "busy_unverified_owner"
  | "stale_removed";

export interface RotationHistoryPathDiagnostics {
  repositoryRoot: string;
  currentWorkingDirectory: string;
  historyStoreDirectory: string;
  historyStorePath: string;
  historyStorePathSource: RotationHistoryStorePathSource;
  pathMatchesExpectedRepositoryLocalDefault: boolean;
  legacyCwdDerivedStorePath: string;
  legacyCwdDerivedStoreExists: boolean;
  legacyStoreRecordCount: number;
  activeStoreRecordCount: number;
  repositoryLocalStoreRecordCount: number;
  historyStoreReviewCode: RotationHistoryStoreReviewCode;
  crossProcessLockStatus: RotationHistoryCrossProcessLockStatus;
}

export interface RotationHistorySyncCheckpoint {
  schemaVersion: 1;
  resumeToken: string;
  syncPurpose?: RotationHistorySyncPurpose;
  requestedWindow: {
    startTime: string;
    endTime: string;
    lookbackMinutes: number;
  };
  resolvedStartBlock?: string;
  resolvedEndBlock?: string;
  candidateIds?: RotationCandidateId[];
  requiredPoolSet?: Array<{
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    sourceVersion: RotationHistorySourceVersion;
  }>;
  storePath?: string;
  chainId?: number;
  phase?: RotationRecentRefreshPhase;
  candidateId?: RotationCandidateId;
  poolAddress?: `0x${string}`;
  nextBlock?: string;
  completedBlockRanges: Array<{
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    sourceVersion: RotationHistorySourceVersion;
    fromBlock: string;
    toBlock: string;
    resultCount?: number;
    validRecordCount?: number;
    duplicateCount?: number;
    completedAt?: string;
    source?: string;
    adapter?: RotationHistoryEventAdapter;
    success?: boolean;
  }>;
  completedPools: Array<{
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    sourceVersion: RotationHistorySourceVersion;
  }>;
  sourceCursor?: {
    candidateIndex: number;
    poolIndex: number;
    taskIndex?: number;
  };
  lastAttemptedRange?: {
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    fromBlock: string;
    toBlock: string;
  };
  lastSuccessfullyScannedRange?: {
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    fromBlock: string;
    toBlock: string;
  };
  progressFingerprint?: `0x${string}`;
  previousProgressFingerprint?: `0x${string}`;
  repeatedRange?: {
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    fromBlock: string;
    toBlock: string;
  };
  storeFingerprintBeforeRun: `0x${string}`;
  updatedAt: string;
}

export interface RotationHistoryFile {
  schemaVersion: 1;
  chainId: number;
  updatedAt: string;
  retentionDays: number;
  records: RotationHistoryRecord[];
  lastSync?: {
    syncPurpose?: RotationHistorySyncPurpose;
    requestedStartTime: string;
    requestedEndTime: string;
    historyStoreFingerprint: `0x${string}`;
    candidates: RotationHistoryCandidateSyncStatus[];
  };
}

export interface RotationHistorySyncInput {
  lookbackMinutes?: number;
  maximumBlocksPerChunk?: number;
  maximumPagesPerSource?: number;
  forceRecentBlockRecheck?: boolean;
  maximumRuntimeMs?: number;
  candidateIds?: RotationCandidateId[];
  resumeToken?: string;
  maximumPoolsPerRun?: number;
  syncPurpose?: RotationHistorySyncPurpose;
}

export interface RotationRecentRefreshInput {
  lookbackMinutes?: number;
  candidateIds?: RotationCandidateId[];
  tipRefreshMinutes?: number;
  maximumRuntimeMs?: number;
  maximumBlocksPerChunk?: number;
  maximumPoolsPerRun?: number;
  resumeToken?: string;
  forceRecentBlockRecheck?: boolean;
}

export interface RotationRecentRefreshResult extends RotationHistorySyncResult {
  syncPurpose: "RECENT_SIGNAL_WINDOW";
  tipRefreshMinutes: number;
  phase: RotationRecentRefreshPhase;
  anchorTipComplete: boolean;
  anchorLatestBlock: string | null;
  anchorLatestTimestamp: string | null;
  anchorLagBlocks: number | null;
  anchorLagMinutes: number | null;
}

export interface RotationHistorySyncResult {
  ok: boolean;
  code?: RotationHistorySyncCode;
  reason?: string;
  resumeToken?: string;
  checkpointPath?: string;
  checkpointUpdatedAt?: string;
  maximumRuntimeMs?: number;
  lookbackMinutes: number;
  requestedStartTime: string;
  requestedEndTime: string;
  recordsAdded: number;
  recordsUpdated: number;
  duplicateRecordsIgnored: number;
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  sourceCompleteness: RotationHistoryCandidateSyncStatus[];
  unresolvedGaps: string[];
  syncPurpose?: RotationHistorySyncPurpose;
  blocksScanned?: number;
  rangesCompleted?: number;
  rangesWithZeroLogs?: number;
  recordsRetrieved?: number;
  checkpointAdvanced?: boolean;
  tipLagBlocksBefore?: number | null;
  tipLagBlocksAfter?: number | null;
  tipLagMinutesBefore?: number | null;
  tipLagMinutesAfter?: number | null;
  progressFingerprintBefore?: `0x${string}` | null;
  progressFingerprintAfter?: `0x${string}` | null;
  repeatedRange?: {
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    fromBlock: string;
    toBlock: string;
  };
  repositoryRoot: string;
  currentWorkingDirectory: string;
  historyStoreDirectory: string;
  historyStorePath: string;
  historyStorePathSource: RotationHistoryStorePathSource;
  pathMatchesExpectedRepositoryLocalDefault: boolean;
  legacyCwdDerivedStorePath: string;
  legacyCwdDerivedStoreExists: boolean;
  legacyStoreRecordCount: number;
  activeStoreRecordCount: number;
  crossProcessLockStatus: RotationHistoryCrossProcessLockStatus;
  historyStoreFingerprint: `0x${string}`;
  quoteCallCount: 0;
  noPiteasQuoteUsed: true;
  noWalletWrite: true;
  noLiveTransaction: true;
}

export interface RotationHistoryCandidateStatus {
  candidateId: RotationCandidateId;
  recordsStored: number;
  earliestRecord: string | null;
  latestRecord: string | null;
  historyDurationMinutes: number;
  sourceCompletenessPercent: number;
  activeCandleCoveragePercent: number;
  priceContinuityPercent: number;
  analysisMode: RotationAnalysisMode;
  latestTradeAgeMinutes: number | null;
  unresolvedGaps: string[];
  tipFreshnessStatus?: RotationTipFreshnessStatus;
  tipCompletenessPercent?: number;
  currentSignalWindowCompletenessPercent?: number;
  sevenDayCompletenessPercent?: number;
  latestSourceTradeAgeMinutes?: number | null;
  pipelineLagMinutes?: number | null;
  requiredPoolsComplete?: boolean;
  readinessForLiveScanning: boolean;
}

export interface RotationHistoryStatusResult {
  ok: boolean;
  code?: RotationHistoryStoreReviewCode;
  reason?: string;
  checkedAt: string;
  lookbackMinutes: number;
  candidates: RotationHistoryCandidateStatus[];
  repositoryRoot: string;
  currentWorkingDirectory: string;
  historyStoreDirectory: string;
  historyStorePath: string;
  historyStorePathSource: RotationHistoryStorePathSource;
  pathMatchesExpectedRepositoryLocalDefault: boolean;
  legacyCwdDerivedStorePath: string;
  legacyCwdDerivedStoreExists: boolean;
  legacyStoreRecordCount: number;
  activeStoreRecordCount: number;
  crossProcessLockStatus: RotationHistoryCrossProcessLockStatus;
  historyStoreFingerprint: `0x${string}`;
  quoteCallCount: 0;
  noPiteasQuoteUsed: true;
  noWalletWrite: true;
  noLiveTransaction: true;
}

export interface RotationCycleLedgerEntry {
  cycleId: string;
  walletId: string;
  state: RotationCycleState;
  cycleStartTime: string;
  startingEusdcRaw: string;
  selectedCandidate?: RotationCandidateId;
  candidateTokenAddress?: `0x${string}`;
  entrySignalEvidence?: Record<string, unknown>;
  entryQuoteFingerprint?: string;
  entryProposalId?: string;
  entryTransactionHash?: `0x${string}`;
  entryEusdcSpentRaw?: string;
  candidateReceivedRaw?: string;
  entryGasPls?: string;
  entryGasEusdcEquivalentRaw?: string;
  positionOpenedAt?: string;
  exitTargetRaw?: string;
  exitQuoteFingerprint?: string;
  exitProposalId?: string;
  exitTransactionHash?: `0x${string}`;
  candidateSoldRaw?: string;
  finalEusdcReceivedRaw?: string;
  exitGasPls?: string;
  exitGasEusdcEquivalentRaw?: string;
  endingEusdcRaw?: string;
  grossEusdcGainRaw?: string;
  netEusdcEquivalentGainRaw?: string;
  netGainBps?: number;
  reconciliationStatus?: string;
  completedAt?: string;
}

export interface RotationLedgerFile {
  schemaVersion: 1;
  updatedAt: string;
  cycles: RotationCycleLedgerEntry[];
}

export interface RotationTargetBreakdown {
  startingEusdcRaw: string;
  minimumNetTargetBps: number;
  simpleBalanceTargetRaw: string;
  entryApprovalGasEusdcEquivalentRaw: string;
  entrySwapGasEusdcEquivalentRaw: string;
  exitApprovalGasEusdcEquivalentRaw: string;
  projectedExitSwapGasEusdcEquivalentRaw: string;
  safetyBufferRaw: string;
  requiredFinalEusdcRaw: string;
  gasConversionAvailable: boolean;
  gasConversionSource: string;
}

export interface RotationPiteasProposalOutput {
  ok: boolean;
  classification: RotationProposalClassification;
  failureStage?: string;
  reason?: string;
  walletId: string;
  walletAddress?: `0x${string}`;
  cycleId?: string;
  candidateId?: RotationCandidateId;
  leg: "entry" | "exit";
  tokenIn?: `0x${string}`;
  tokenOut?: `0x${string}`;
  inputAmountRaw?: string;
  inputBalanceRaw?: string;
  currentAllowanceRaw?: string;
  verifiedSpender?: `0x${string}`;
  requiredAllowanceRaw?: string;
  unlimitedApproval?: false;
  expectedOutputRaw?: string;
  executableMinimumOutputRaw?: string;
  minimumExecutableOutputFloorRaw?: string;
  maximumEstimatedGasCostPls?: string;
  routeProtocols?: string[];
  routeIntermediates?: string[];
  quoteCallCount: number;
  quoteRequestedAt?: string;
  quoteReceivedAt?: string;
  quoteResponseTimeMs?: number;
  quoteResponseFingerprint?: string;
  methodParameterFingerprint?: `0x${string}`;
  upstreamCalldataFingerprint?: `0x${string}`;
  preparedCalldataFingerprint?: `0x${string}`;
  decoderInputFingerprint?: `0x${string}`;
  walletInspectionInputFingerprint?: `0x${string}`;
  simulationInputFingerprint?: `0x${string}`;
  proposalInputFingerprint?: `0x${string}`;
  savedProposalCalldataFingerprint?: `0x${string}`;
  everyCalldataFingerprintMatched?: boolean;
  calldataByteLength?: number;
  topLevelDecodeStatus?: string;
  canonicalReencodingStatus?: string;
  decodeKnowledge?: string;
  agentGuidance?: string;
  twoRpcSimulation?: RpcPinnedSimulationRow[];
  internalProposalSimulation?: SimulationResult;
  estimatedGas?: string;
  estimatedGasCostPls?: string;
  proposalId?: string;
  proposalStatus?: TxProposal["status"];
  proposalCreatedAt?: string;
  proposalExpiresAt?: string;
  readyForHumanConfirmation: boolean;
}

export interface RotationExecutionOutput {
  ok: boolean;
  walletId: string;
  cycleId?: string;
  candidateId?: RotationCandidateId;
  leg: "entry" | "exit";
  proposalId: string;
  txHash?: `0x${string}`;
  receiptStatus?: unknown;
  blockNumber?: string;
  gasUsed?: string;
  eUsdcBalanceRaw?: string;
  candidateBalanceRaw?: string;
  finalState?: RotationCycleState;
  reason?: string;
}

export interface RotationPositionStatus {
  ok: boolean;
  walletId: string;
  state: RotationCycleState;
  candidateId?: RotationCandidateId;
  amountRaw?: string;
  entryEusdcSpentRaw?: string;
  currentReadOnlyEusdcValuationRaw?: string;
  unrealizedEusdcChangeRaw?: string;
  unrealizedPercent?: number;
  entryGasPls?: string;
  projectedExitGasPls?: string;
  requiredFinalEusdcRaw?: string;
  estimatedExecutableSellOutputRaw?: string;
  distanceFromTargetRaw?: string;
  holdingDurationSeconds?: number;
  adverseMovementBps?: number;
  exitSignalStatus:
    | "HOLD_POSITION"
    | "CHECK_EXECUTABLE_EXIT"
    | "MAX_HOLD_REVIEW"
    | "ADVERSE_MOVE_REVIEW"
    | "DATA_SOURCE_FAILURE"
    | "NO_OPEN_POSITION";
  quoteCallCount: number;
}

export interface RotationDeps {
  nowMs: () => number;
  getChainId: typeof getChainId;
  getAgentWalletInfo: typeof getAgentWalletInfo;
  listAgentWallets: typeof listAgentWallets;
  agentWalletSystemStatus: (config: AppConfig) => Record<string, unknown>;
  getTokenValidation: (
    config: AppConfig,
    candidate: RotationCandidateRegistryEntry,
    walletAddress: `0x${string}`,
  ) => Promise<RotationTokenValidation>;
  fetchCandidateMarketEvidence: (
    config: AppConfig,
    candidate: RotationCandidateRegistryEntry,
    input: Required<RotationScanInput>,
    eUsdcBalanceRaw: string,
  ) => Promise<RotationMarketEvidence>;
  readTokenBalance: typeof readErc20Balance;
  readTokenAllowance: typeof readErc20Allowance;
  readNativeBalanceWei: (
    config: AppConfig,
    owner: `0x${string}`,
  ) => Promise<string>;
  getPiteasQuote: typeof getPiteasQuote;
  preparePiteasSwap: typeof preparePiteasSwap;
  decodePiteasRouterSwapCalldata: typeof decodePiteasRouterSwapCalldata;
  inspectTokenNotional: typeof inspectTokenNotional;
  buildAgentIntentView: typeof buildAgentIntentView;
  simulateSameBlock: typeof simulateSameBlockTwoRpc;
  getFeeData: typeof getFeeData;
  proposeAgentTx: typeof proposeAgentTx;
  executeAgentTx: typeof executeAgentTx;
  loadProposal: (config: AppConfig, proposalId: string) => TxProposal;
  getTransactionReceipt: typeof getTransactionReceipt;
}

const quoteCounter = {
  count: 0,
};

const quoteWindowTimestamps: number[] = [];
const lastScanByWallet = new Map<string, RotationScanResult>();

function decimalUint(value: string, label: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a decimal unsigned integer string`);
  }
  return BigInt(value);
}

function positivePlainDecimalToWei(value: string, label: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a positive plain decimal string`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 18) {
    throw new Error(`${label} cannot have more than 18 decimal places`);
  }
  const wei = BigInt(whole) * 1_000_000_000_000_000_000n + BigInt(fraction.padEnd(18, "0"));
  if (wei <= 0n) throw new Error(`${label} must be positive`);
  return wei;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number, decimals = 8): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function isoFromSeconds(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function makeMetric<T>(input: {
  value: T;
  unit: RotationMetricUnit;
  source: string;
  sourceTimestamp?: string | null;
  startTimestamp?: string | null;
  endTimestamp?: string | null;
  sampleCount: number;
  pageCount: number;
  truncated: boolean;
  coveragePercent: number;
  stale: boolean;
  confidence?: RotationMetric["confidence"];
  warnings?: string[];
}): RotationMetric<T> {
  return {
    value: input.value,
    unit: input.unit,
    source: input.source,
    sourceTimestamp: input.sourceTimestamp ?? null,
    startTimestamp: input.startTimestamp ?? null,
    endTimestamp: input.endTimestamp ?? null,
    sampleCount: input.sampleCount,
    pageCount: input.pageCount,
    truncated: input.truncated,
    coveragePercent: round(input.coveragePercent, 4),
    stale: input.stale,
    confidence: input.confidence ?? (input.sampleCount > 0 && !input.stale ? "medium" : "none"),
    warnings: input.warnings ?? [],
  };
}

function unavailableMetric(input: {
  reason: string;
  unit: RotationMetricUnit;
  source: string;
  requiredSamples: number;
  availableSamples: number;
  warnings?: string[];
}): RotationUnavailableMetric {
  return {
    status: "UNAVAILABLE",
    reason: input.reason,
    unit: input.unit,
    source: input.source,
    requiredSamples: input.requiredSamples,
    availableSamples: input.availableSamples,
    warnings: input.warnings ?? [],
  };
}

function metricStatus(metric: RotationMetric<unknown> | RotationUnavailableMetric | undefined): RotationMetricStatus {
  if (!metric) return { status: "UNAVAILABLE", reason: "metric missing", requiredSamples: 1, availableSamples: 0 };
  if ("status" in metric && metric.status === "UNAVAILABLE") {
    return {
      status: "UNAVAILABLE",
      reason: metric.reason,
      requiredSamples: metric.requiredSamples,
      availableSamples: metric.availableSamples,
    };
  }
  return { status: "AVAILABLE" };
}

function stableScanPayload(row: RotationCandidateScanRow): Record<string, unknown> {
  return {
    candidateId: row.candidateId,
    executionTokenAddress: row.executionTokenAddress.toLowerCase(),
    largestPoolLiquidityUsd: row.largestPoolLiquidityUsd,
    aggregateLiquidityUsd: row.aggregateLiquidityUsd,
    largestPoolLiquidityEusdc: row.largestPoolLiquidityEusdc,
    aggregateLiquidityEusdc: row.aggregateLiquidityEusdc,
    recentVolumeUsd: row.recentVolumeUsd,
    recentVolumeEusdc: row.recentVolumeEusdc,
    tradeCount: row.tradeCount,
    fiveMinuteReturnBps: row.fiveMinuteReturnBps,
    fifteenMinuteReturnBps: row.fifteenMinuteReturnBps,
    oneHourReturnBps: row.oneHourReturnBps,
    sixHourReturnBps: row.sixHourReturnBps,
    distanceFromRollingOneHourHighBps: row.distanceFromRollingOneHourHighBps,
    distanceFromRollingOneHourLowBps: row.distanceFromRollingOneHourLowBps,
    reboundFromMostRecentLocalLowBps: row.reboundFromMostRecentLocalLowBps,
    realizedVolatilityBps: row.realizedVolatilityBps,
    estimatedPriceImpactForCompleteEusdcBalancePercent:
      row.estimatedPriceImpactForCompleteEusdcBalancePercent,
    routeAvailabilityStatus: row.routeAvailabilityStatus,
    entryRouteAvailability: row.entryRouteAvailability,
    exitRouteAvailability: row.exitRouteAvailability,
    candleCoverage: row.candleCoverage,
    dipReboundEvidence: row.dipReboundEvidence,
    historyQuality: row.historyQuality,
    targetAwareReversion: row.targetAwareReversion,
    eligibility: row.eligibility,
    score: row.score,
    rejectionReasons: row.rejectionReasons,
  };
}

export function getRotationCandidateRegistry(): RotationCandidateRegistryEntry[] {
  return EUSDC_ROTATION_CANDIDATES.map((candidate) => ({ ...candidate }));
}

export function getRotationCandidate(candidateId: RotationCandidateId): RotationCandidateRegistryEntry {
  const candidate = EUSDC_ROTATION_CANDIDATES.find((entry) => entry.candidateId === candidateId);
  if (!candidate) throw new Error(`Unknown rotation candidate ${candidateId}`);
  return { ...candidate };
}

export function computeSimpleBalanceTargetRaw(
  startingEusdcRaw: string,
  minimumNetTargetBps = DEFAULT_MINIMUM_NET_TARGET_BPS,
): string {
  const start = decimalUint(startingEusdcRaw, "startingEusdcRaw");
  const numerator = start * BigInt(10_000 + minimumNetTargetBps);
  return ((numerator + 9_999n) / 10_000n).toString();
}

export function computeRequiredFinalEusdcRaw(input: {
  startingEusdcRaw: string;
  minimumNetTargetBps?: number;
  entryApprovalGasEusdcEquivalentRaw?: string;
  entrySwapGasEusdcEquivalentRaw?: string;
  exitApprovalGasEusdcEquivalentRaw?: string;
  projectedExitSwapGasEusdcEquivalentRaw?: string;
  safetyBufferRaw?: string;
  gasConversionAvailable: boolean;
  gasConversionSource?: string;
}): RotationTargetBreakdown {
  const simpleBalanceTargetRaw = computeSimpleBalanceTargetRaw(
    input.startingEusdcRaw,
    input.minimumNetTargetBps ?? DEFAULT_MINIMUM_NET_TARGET_BPS,
  );
  const gasFields = [
    input.entryApprovalGasEusdcEquivalentRaw ?? "0",
    input.entrySwapGasEusdcEquivalentRaw ?? "0",
    input.exitApprovalGasEusdcEquivalentRaw ?? "0",
    input.projectedExitSwapGasEusdcEquivalentRaw ?? "0",
    input.safetyBufferRaw ?? "0",
  ].map((value, index) => decimalUint(value, `target component ${index}`));
  const required = gasFields.reduce(
    (sum, value) => sum + value,
    decimalUint(simpleBalanceTargetRaw, "simpleBalanceTargetRaw"),
  );
  return {
    startingEusdcRaw: input.startingEusdcRaw,
    minimumNetTargetBps: input.minimumNetTargetBps ?? DEFAULT_MINIMUM_NET_TARGET_BPS,
    simpleBalanceTargetRaw,
    entryApprovalGasEusdcEquivalentRaw: input.entryApprovalGasEusdcEquivalentRaw ?? "0",
    entrySwapGasEusdcEquivalentRaw: input.entrySwapGasEusdcEquivalentRaw ?? "0",
    exitApprovalGasEusdcEquivalentRaw: input.exitApprovalGasEusdcEquivalentRaw ?? "0",
    projectedExitSwapGasEusdcEquivalentRaw: input.projectedExitSwapGasEusdcEquivalentRaw ?? "0",
    safetyBufferRaw: input.safetyBufferRaw ?? "0",
    requiredFinalEusdcRaw: required.toString(),
    gasConversionAvailable: input.gasConversionAvailable,
    gasConversionSource: input.gasConversionSource ?? "unavailable",
  };
}

function tokenId(token: { id?: string } | undefined): string {
  return String(token?.id ?? "").toLowerCase();
}

function tokenSymbol(token: { symbol?: string } | undefined): string {
  return String(token?.symbol ?? "").toLowerCase();
}

function pairIncludes(pair: SubgraphPair | NonNullable<SubgraphSwap["pair"]>, token: string): boolean {
  const lower = token.toLowerCase();
  return tokenId(pair.token0) === lower || tokenId(pair.token1) === lower;
}

function pairMatches(pair: SubgraphPair, a: string, b: string): boolean {
  return pairIncludes(pair, a) && pairIncludes(pair, b);
}

function pairReserveFor(pair: SubgraphPair, token: string): number {
  const lower = token.toLowerCase();
  if (tokenId(pair.token0) === lower) return num(pair.reserve0);
  if (tokenId(pair.token1) === lower) return num(pair.reserve1);
  return 0;
}

function pairTokenDecimals(pair: SubgraphPair, token: string, fallback: number): number {
  const lower = token.toLowerCase();
  const raw =
    tokenId(pair.token0) === lower
      ? pair.token0.decimals
      : tokenId(pair.token1) === lower
        ? pair.token1.decimals
        : undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : fallback;
}

export function normalizeTokenAmount(value: string, decimals: number, sourceIsRaw: boolean): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return 0;
  if (!sourceIsRaw) return num(value);
  try {
    return Number(formatUnits(BigInt(value), decimals));
  } catch {
    return 0;
  }
}

function amountForSwapToken(swap: SubgraphSwap, token: string): number {
  const lower = token.toLowerCase();
  const p = swap.pair;
  if (!p) return 0;
  if (tokenId(p.token0) === lower || (!p.token0?.id && tokenSymbol(p.token0) === lower)) {
    return num(swap.amount0In) + num(swap.amount0Out);
  }
  if (tokenId(p.token1) === lower || (!p.token1?.id && tokenSymbol(p.token1) === lower)) {
    return num(swap.amount1In) + num(swap.amount1Out);
  }
  return 0;
}

function swapPairMatches(swap: SubgraphSwap, a: string, b: string): boolean {
  const p = swap.pair;
  if (!p) return false;
  return pairIncludes(p, a) && pairIncludes(p, b);
}

function pairPriceEusdc(pair: SubgraphPair, token: string, priceMap: Map<string, number>): number | null {
  const lower = token.toLowerCase();
  const tokenReserve = pairReserveFor(pair, lower);
  if (tokenReserve <= 0) return null;
  const other =
    tokenId(pair.token0) === lower
      ? tokenId(pair.token1)
      : tokenId(pair.token1) === lower
        ? tokenId(pair.token0)
        : "";
  const otherReserve = other ? pairReserveFor(pair, other) : 0;
  const otherPrice = priceMap.get(other);
  if (!other || otherReserve <= 0 || otherPrice === undefined || otherPrice <= 0) return null;
  return (otherReserve * otherPrice) / tokenReserve;
}

function findAnchorWplsEusdcPair(pairs: SubgraphPair[]): SubgraphPair | undefined {
  return pairs
    .filter((pair) => pairMatches(pair, WPLS_ADDRESS, EUSDC_ADDRESS))
    .sort((a, b) => pairLiquidityUsd(b) - pairLiquidityUsd(a))[0];
}

function deriveWplsEusdcPrice(anchor: SubgraphPair | undefined): number | null {
  if (!anchor) return null;
  const wplsReserve = pairReserveFor(anchor, WPLS_ADDRESS);
  const eusdcReserve = pairReserveFor(anchor, EUSDC_ADDRESS);
  if (wplsReserve <= 0 || eusdcReserve <= 0) return null;
  return eusdcReserve / wplsReserve;
}

export function calculatePairLiquidityEusdc(pair: SubgraphPair, priceMap: Map<string, number>): number {
  const token0 = tokenId(pair.token0);
  const token1 = tokenId(pair.token1);
  const p0 = priceMap.get(token0);
  const p1 = priceMap.get(token1);
  if (p0 === undefined || p1 === undefined || p0 <= 0 || p1 <= 0) return 0;
  const r0 = normalizeTokenAmount(pair.reserve0, pairTokenDecimals(pair, token0, 18), false);
  const r1 = normalizeTokenAmount(pair.reserve1, pairTokenDecimals(pair, token1, 18), false);
  return Math.max(0, r0 * p0 + r1 * p1);
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function priceDispersionPercent(values: number[]): number | null {
  const m = median(values);
  if (m === null || m <= 0) return null;
  const deviations = values.map((v) => Math.abs(v - m) / m * 100);
  return round(Math.max(0, ...deviations), 6);
}

export function consolidateRotationPools(input: {
  candidate: RotationCandidateRegistryEntry;
  pairs: SubgraphPair[];
  priceMap: Map<string, number>;
  poolBytecode?: Map<string, boolean>;
}): RotationPoolConsolidation {
  const candidateToken = input.candidate.executionTokenAddress.toLowerCase();
  const routeRelevant = input.pairs.filter(
    (pair) =>
      pairMatches(pair, candidateToken, EUSDC_ADDRESS) ||
      pairMatches(pair, candidateToken, WPLS_ADDRESS) ||
      (input.candidate.candidateId === "PLS" && pairMatches(pair, WPLS_ADDRESS, EUSDC_ADDRESS)),
  );
  const eligible: Array<{ pair: SubgraphPair; liquidity: number; price: number | null }> = [];
  const excluded: Array<{ pool: string; reason: string }> = [];
  for (const pair of routeRelevant) {
    const id = pair.id.toLowerCase();
    if (input.poolBytecode?.has(id) && input.poolBytecode.get(id) === false) {
      excluded.push({ pool: id, reason: "pool bytecode missing" });
      continue;
    }
    const liquidity = calculatePairLiquidityEusdc(pair, input.priceMap);
    if (liquidity <= 0) {
      excluded.push({ pool: id, reason: "non-positive or unpriced reserves" });
      continue;
    }
    if (liquidity < Math.max(10, input.candidate.minimumLiquidityUsd * 0.01)) {
      excluded.push({ pool: id, reason: "tiny pool excluded from consolidation" });
      continue;
    }
    eligible.push({ pair, liquidity, price: pairPriceEusdc(pair, candidateToken, input.priceMap) });
  }
  eligible.sort((a, b) => b.liquidity - a.liquidity);
  const aggregate = eligible.reduce((sum, row) => sum + row.liquidity, 0);
  const largest = eligible[0]?.liquidity ?? 0;
  const priceRows = eligible.filter((row) => row.price !== null) as Array<{
    pair: SubgraphPair;
    liquidity: number;
    price: number;
  }>;
  const weightedPrice =
    priceRows.length === 0
      ? null
      : priceRows.reduce((sum, row) => sum + row.price * row.liquidity, 0) /
        priceRows.reduce((sum, row) => sum + row.liquidity, 0);
  return {
    primaryPool: eligible[0]?.pair.id.toLowerCase() ?? null,
    eligiblePools: eligible.map((row) => row.pair.id.toLowerCase()),
    excludedPools: excluded,
    aggregateLiquidityEusdc: round(aggregate, 6),
    largestPoolLiquidityEusdc: round(largest, 6),
    liquidityConcentrationPercent: aggregate > 0 ? round(largest / aggregate * 100, 6) : 0,
    consolidatedPriceEusdc: weightedPrice === null ? null : round(weightedPrice, 12),
    priceDispersionPercent: priceDispersionPercent(priceRows.map((row) => row.price)),
  };
}

export function deriveRouteConnectivity(input: {
  candidate: RotationCandidateRegistryEntry;
  pairs: SubgraphPair[];
}): RotationRouteAvailabilityStatus {
  const candidateToken = input.candidate.executionTokenAddress.toLowerCase();
  const hasPositive = (pair: SubgraphPair, a: string, b: string) =>
    pairMatches(pair, a, b) && pairReserveFor(pair, a) > 0 && pairReserveFor(pair, b) > 0;
  if (input.pairs.some((pair) => hasPositive(pair, candidateToken, EUSDC_ADDRESS))) return "DIRECT_POOL";
  const hasWplsAnchor = input.pairs.some((pair) => hasPositive(pair, WPLS_ADDRESS, EUSDC_ADDRESS));
  if (input.candidate.candidateId === "PLS") {
    return hasWplsAnchor ? "DIRECT_POOL" : "UNAVAILABLE";
  }
  const hasCandidateWpls = input.pairs.some((pair) => hasPositive(pair, candidateToken, WPLS_ADDRESS));
  if (hasCandidateWpls && hasWplsAnchor) return "MULTIHOP_VIA_WPLS";
  return hasCandidateWpls ? "UNKNOWN_UNTIL_EXECUTABLE_QUOTE" : "UNAVAILABLE";
}

export interface RotationPriceObservation {
  timestamp: number;
  priceEusdc: number;
  volumeEusdc: number;
  swapId: string;
  source: string;
  blockNumber?: string | null;
  poolAddress?: `0x${string}`;
  anchorPoolAddress?: `0x${string}`;
  anchorAgeSeconds?: number;
}

function nearestAnchorPrice(
  anchors: RotationPriceObservation[],
  timestamp: number,
  maxAgeSeconds: number,
  blockNumber?: string | null,
): { price: number; age: number; poolAddress?: `0x${string}` } | null {
  if (blockNumber) {
    const exact = anchors.find((anchor) => anchor.blockNumber === blockNumber);
    if (exact) return { price: exact.priceEusdc, age: 0, poolAddress: exact.poolAddress };
  }
  let best: RotationPriceObservation | null = null;
  let bestAge = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const age = Math.abs(anchor.timestamp - timestamp);
    if (age < bestAge) {
      best = anchor;
      bestAge = age;
    }
  }
  return best && bestAge <= maxAgeSeconds
    ? { price: best.priceEusdc, age: bestAge, poolAddress: best.poolAddress }
    : null;
}

export function priceObservationFromSwap(input: {
  swap: SubgraphSwap;
  candidate: RotationCandidateRegistryEntry;
  anchorObservations?: RotationPriceObservation[];
  maxAnchorAgeSeconds?: number;
  blockNumber?: string | null;
}): RotationPriceObservation | null {
  const swap = input.swap;
  const ts = Number(swap.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const candidateToken = input.candidate.executionTokenAddress.toLowerCase();
  const candidateAmount = amountForSwapToken(swap, candidateToken);
  const eusdcAmount = amountForSwapToken(swap, EUSDC_ADDRESS);
  const wplsAmount = amountForSwapToken(swap, WPLS_ADDRESS);
  let price: number | null = null;
  let volumeEusdc = num(swap.amountUSD);
  let source = "direct";
  let anchorAgeSeconds: number | undefined;
  let anchorPoolAddress: `0x${string}` | undefined;
  if (candidateAmount > 0 && eusdcAmount > 0 && swapPairMatches(swap, candidateToken, EUSDC_ADDRESS)) {
    price = eusdcAmount / candidateAmount;
    volumeEusdc = Math.max(volumeEusdc, eusdcAmount);
  } else if (
    input.candidate.candidateId === "PLS" &&
    wplsAmount > 0 &&
    eusdcAmount > 0 &&
    swapPairMatches(swap, WPLS_ADDRESS, EUSDC_ADDRESS)
  ) {
    price = eusdcAmount / wplsAmount;
    volumeEusdc = Math.max(volumeEusdc, eusdcAmount);
    source = "wpls/eusdc";
  } else if (candidateAmount > 0 && wplsAmount > 0 && swapPairMatches(swap, candidateToken, WPLS_ADDRESS)) {
    const anchor = nearestAnchorPrice(
      input.anchorObservations ?? [],
      ts,
      input.maxAnchorAgeSeconds ?? 900,
      input.blockNumber,
    );
    if (!anchor) return null;
    price = (wplsAmount / candidateAmount) * anchor.price;
    volumeEusdc = Math.max(volumeEusdc, wplsAmount * anchor.price);
    source = "candidate/wpls*historical-wpls/eusdc";
    anchorAgeSeconds = anchor.age;
    anchorPoolAddress = anchor.poolAddress;
  }
  if (price === null || price <= 0 || !Number.isFinite(price)) return null;
  return {
    timestamp: ts,
    priceEusdc: price,
    volumeEusdc: Math.max(0, volumeEusdc),
    swapId: `${swap.transaction?.id ?? ""}:${swap.id}`,
    source,
    ...(input.blockNumber !== undefined ? { blockNumber: input.blockNumber } : {}),
    ...(anchorPoolAddress !== undefined ? { anchorPoolAddress } : {}),
    ...(anchorAgeSeconds !== undefined ? { anchorAgeSeconds } : {}),
  };
}

function bucketStart(timestampSeconds: number, candleMinutes: number): number {
  const size = candleMinutes * 60;
  return Math.floor(timestampSeconds / size) * size;
}

export function buildFiveMinuteCandles(input: {
  observations: RotationPriceObservation[];
  lookbackMinutes: number;
  candleMinutes: number;
  nowMs: number;
}): { candles: RotationCandle[]; coverage: RotationCandleCoverage } {
  const candleSeconds = input.candleMinutes * 60;
  const expectedCandles = Math.ceil(input.lookbackMinutes / input.candleMinutes);
  const endSeconds = Math.floor(input.nowMs / 1000 / candleSeconds) * candleSeconds;
  const startSeconds = endSeconds - expectedCandles * candleSeconds;
  const byBucket = new Map<number, RotationPriceObservation[]>();
  const uniqueObservations = new Map<string, RotationPriceObservation>();
  for (const obs of input.observations) {
    if (!uniqueObservations.has(obs.swapId)) uniqueObservations.set(obs.swapId, obs);
  }
  for (const obs of uniqueObservations.values()) {
    if (obs.timestamp < startSeconds || obs.timestamp >= endSeconds) continue;
    const bucket = bucketStart(obs.timestamp, input.candleMinutes);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push(obs);
  }
  const candles: RotationCandle[] = [];
  const populatedBuckets = [...byBucket.keys()].sort((a, b) => a - b);
  for (const bucket of populatedBuckets) {
    const rows = byBucket.get(bucket)!.sort((a, b) => a.timestamp - b.timestamp);
    const prices = rows.map((row) => row.priceEusdc);
    candles.push({
      startTimestamp: new Date(bucket * 1000).toISOString(),
      endTimestamp: new Date((bucket + candleSeconds) * 1000).toISOString(),
      open: prices[0]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1]!,
      volumeEusdc: round(rows.reduce((sum, row) => sum + row.volumeEusdc, 0), 6),
      tradeCount: rows.length,
      sourceSwapIds: rows.map((row) => row.swapId),
      carriedForward: false,
    });
  }
  const gaps = populatedBuckets.slice(1).map((bucket, i) => (bucket - populatedBuckets[i]!) / 60);
  const mostRecent = [...uniqueObservations.values()]
    .filter((obs) => obs.timestamp < endSeconds)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const populatedCandles = candles.length;
  return {
    candles,
    coverage: {
      expectedCandles,
      populatedCandles,
      activeTradeCandles: populatedCandles,
      coveragePercent: expectedCandles > 0 ? round(populatedCandles / expectedCandles * 100, 4) : 0,
      maximumDataGapMinutes: gaps.length > 0 ? Math.max(...gaps) : null,
      mostRecentTradeAgeMinutes: mostRecent ? round((endSeconds - mostRecent.timestamp) / 60, 4) : null,
      missingBuckets: Math.max(0, expectedCandles - populatedCandles),
      truncated: false,
      sparseMarketMethodUsed: false,
    },
  };
}

function returnBps(candles: RotationCandle[], minutes: number): RotationMetric<number> | RotationUnavailableMetric {
  const latest = candles[candles.length - 1];
  if (!latest) {
    return unavailableMetric({
      reason: "no candles available",
      unit: "bps",
      source: "five-minute-candles",
      requiredSamples: 2,
      availableSamples: 0,
    });
  }
  const target = Date.parse(latest.endTimestamp) - minutes * 60_000;
  const prior = [...candles].reverse().find((candle) => Date.parse(candle.endTimestamp) <= target);
  if (!prior || prior.close <= 0) {
    return unavailableMetric({
      reason: `insufficient candle span for ${minutes} minute return`,
      unit: "bps",
      source: "five-minute-candles",
      requiredSamples: Math.ceil(minutes / DEFAULT_CANDLE_MINUTES) + 1,
      availableSamples: candles.length,
    });
  }
  return makeMetric({
    value: round((latest.close - prior.close) / prior.close * 10_000, 6),
    unit: "bps",
    source: "five-minute-candles",
    sourceTimestamp: latest.endTimestamp,
    startTimestamp: prior.endTimestamp,
    endTimestamp: latest.endTimestamp,
    sampleCount: candles.length,
    pageCount: 0,
    truncated: false,
    coveragePercent: 100,
    stale: false,
    confidence: "medium",
  });
}

function metricNumber(metric: RotationMetric<number> | RotationUnavailableMetric): number | null {
  return "status" in metric ? null : metric.value;
}

export function analyzeRotationCandles(input: {
  candles: RotationCandle[];
  scanInput: Required<RotationScanInput>;
  pageCount: number;
  truncated: boolean;
}): {
  metrics: Record<string, RotationMetric<unknown> | RotationUnavailableMetric>;
  dipReboundEvidence: RotationDipReboundEvidence;
  directionalTrendScore: number;
  meanReversionScore: number;
  volatilitySuitabilityScore: number;
} {
  const candles = [...input.candles].sort(
    (a, b) => Date.parse(a.endTimestamp) - Date.parse(b.endTimestamp),
  );
  const metrics: Record<string, RotationMetric<unknown> | RotationUnavailableMetric> = {
    fiveMinuteReturnBps: returnBps(candles, 5),
    fifteenMinuteReturnBps: returnBps(candles, 15),
    oneHourReturnBps: returnBps(candles, 60),
    sixHourReturnBps: returnBps(candles, 360),
  };
  const consecutive = candles.slice(1).map((candle, i) => {
    const prev = candles[i]!;
    return prev.close > 0 ? (candle.close - prev.close) / prev.close * 10_000 : 0;
  });
  const mean = consecutive.length ? consecutive.reduce((s, v) => s + v, 0) / consecutive.length : 0;
  const variance = consecutive.length
    ? consecutive.reduce((s, v) => s + (v - mean) ** 2, 0) / consecutive.length
    : 0;
  if (consecutive.length >= 2) {
    metrics.realizedVolatilityBps = makeMetric({
      value: round(Math.sqrt(variance), 6),
      unit: "bps",
      source: "five-minute-candles",
      sourceTimestamp: candles[candles.length - 1]?.endTimestamp ?? null,
      startTimestamp: candles[0]?.startTimestamp ?? null,
      endTimestamp: candles[candles.length - 1]?.endTimestamp ?? null,
      sampleCount: consecutive.length,
      pageCount: input.pageCount,
      truncated: input.truncated,
      coveragePercent: 100,
      stale: false,
      confidence: "medium",
    });
  } else {
    metrics.realizedVolatilityBps = unavailableMetric({
      reason: "at least three active candles required",
      unit: "bps",
      source: "five-minute-candles",
      requiredSamples: 3,
      availableSamples: candles.length,
    });
  }

  const latest = candles[candles.length - 1];
  const oneHourStart = latest ? Date.parse(latest.endTimestamp) - 60 * 60_000 : 0;
  const lastHour = candles.filter((candle) => Date.parse(candle.endTimestamp) >= oneHourStart);
  const high = lastHour.length ? Math.max(...lastHour.map((c) => c.high)) : null;
  const low = lastHour.length ? Math.min(...lastHour.map((c) => c.low)) : null;
  metrics.distanceFromOneHourHighBps =
    latest && high && high > 0
      ? makeMetric({
          value: round((latest.close - high) / high * 10_000, 6),
          unit: "bps",
          source: "five-minute-candles",
          sourceTimestamp: latest.endTimestamp,
          startTimestamp: lastHour[0]?.startTimestamp ?? latest.startTimestamp,
          endTimestamp: latest.endTimestamp,
          sampleCount: lastHour.length,
          pageCount: input.pageCount,
          truncated: input.truncated,
          coveragePercent: 100,
          stale: false,
        })
      : unavailableMetric({
          reason: "insufficient one-hour candles",
          unit: "bps",
          source: "five-minute-candles",
          requiredSamples: 2,
          availableSamples: lastHour.length,
        });
  metrics.distanceFromOneHourLowBps =
    latest && low && low > 0
      ? makeMetric({
          value: round((latest.close - low) / low * 10_000, 6),
          unit: "bps",
          source: "five-minute-candles",
          sourceTimestamp: latest.endTimestamp,
          startTimestamp: lastHour[0]?.startTimestamp ?? latest.startTimestamp,
          endTimestamp: latest.endTimestamp,
          sampleCount: lastHour.length,
          pageCount: input.pageCount,
          truncated: input.truncated,
          coveragePercent: 100,
          stale: false,
        })
      : unavailableMetric({
          reason: "insufficient one-hour candles",
          unit: "bps",
          source: "five-minute-candles",
          requiredSamples: 2,
          availableSamples: lastHour.length,
        });

  let dipReboundEvidence: RotationDipReboundEvidence = {
    status: "UNAVAILABLE",
    candlesInvolved: lastHour.length,
    volumeConfirmation: false,
    trendRejected: false,
    reason: "insufficient one-hour candles",
  };
  let directionalTrendScore = 0;
  let meanReversionScore = 0;
  if (latest && lastHour.length >= 3) {
    const reference = lastHour.reduce((best, candle) => (candle.high > best.high ? candle : best), lastHour[0]!);
    const afterReference = lastHour.filter(
      (candle) => Date.parse(candle.endTimestamp) > Date.parse(reference.endTimestamp),
    );
    const localLow = afterReference.reduce<RotationCandle | null>(
      (best, candle) => (!best || candle.low < best.low ? candle : best),
      null,
    );
    const first = lastHour[0]!;
    const slopeBps = first.close > 0 ? (latest.close - first.close) / first.close * 10_000 : 0;
    directionalTrendScore = round(Math.max(-100, Math.min(100, slopeBps / 2)), 6);
    if (localLow && reference.high > 0 && localLow.low > 0) {
      const dipBps = (reference.high - localLow.low) / reference.high * 10_000;
      const reboundBps = (latest.close - localLow.low) / localLow.low * 10_000;
      const madeNewLowerLow = latest.low < localLow.low;
      const reboundVolume = afterReference
        .filter((candle) => Date.parse(candle.endTimestamp) >= Date.parse(localLow.endTimestamp))
        .reduce((sum, candle) => sum + candle.volumeEusdc, 0);
      const volumeConfirmation = reboundVolume > 0;
      dipReboundEvidence = {
        status: "AVAILABLE",
        referenceTimestamp: reference.endTimestamp,
        referencePrice: round(reference.high, 12),
        localLowTimestamp: localLow.endTimestamp,
        localLowPrice: round(localLow.low, 12),
        currentTimestamp: latest.endTimestamp,
        currentPrice: round(latest.close, 12),
        dipBps: round(dipBps, 6),
        reboundBps: round(reboundBps, 6),
        candlesInvolved: afterReference.length,
        volumeConfirmation,
        trendRejected: madeNewLowerLow || directionalTrendScore < -50,
        ...(madeNewLowerLow ? { reason: "current candle made a new lower low after rebound" } : {}),
      };
      metrics.reboundFromRecentLocalLowBps = makeMetric({
        value: round(reboundBps, 6),
        unit: "bps",
        source: "dip-rebound-candles",
        sourceTimestamp: latest.endTimestamp,
        startTimestamp: localLow.endTimestamp,
        endTimestamp: latest.endTimestamp,
        sampleCount: afterReference.length,
        pageCount: input.pageCount,
        truncated: input.truncated,
        coveragePercent: 100,
        stale: false,
        confidence: volumeConfirmation ? "medium" : "low",
        warnings: volumeConfirmation ? [] : ["no rebound volume confirmation"],
      });
      meanReversionScore =
        dipBps >= input.scanInput.minimumDipBps && reboundBps >= input.scanInput.minimumReboundConfirmationBps
          ? clampScore(50 + Math.min(35, dipBps / 4) + Math.min(15, reboundBps / 4))
          : 0;
    }
  }
  if (!metrics.reboundFromRecentLocalLowBps) {
    metrics.reboundFromRecentLocalLowBps = unavailableMetric({
      reason: dipReboundEvidence.reason ?? "no post-reference local low",
      unit: "bps",
      source: "dip-rebound-candles",
      requiredSamples: 3,
      availableSamples: lastHour.length,
    });
  }
  return {
    metrics,
    dipReboundEvidence,
    directionalTrendScore,
    meanReversionScore,
    volatilitySuitabilityScore: clampScore(100 - Math.abs(num(metricNumber(metrics.realizedVolatilityBps as never)) - 80) / 2),
  };
}

export function computeScanEconomicFeasibility(input: {
  startingEusdcRaw: string;
  minimumNetTargetBps: number;
  wplsPriceEusdc: number | null;
  estimatedGasPlsPerLeg?: number;
  approvalLegs?: number;
  swapLegs?: number;
  routeCostEusdcRaw?: string;
  safetyBufferRaw?: string;
}): RotationEconomicFeasibility {
  const simpleTargetRaw = computeSimpleBalanceTargetRaw(input.startingEusdcRaw, input.minimumNetTargetBps);
  const gasPls =
    (input.estimatedGasPlsPerLeg ?? 1500) *
    ((input.approvalLegs ?? 2) + (input.swapLegs ?? 2));
  const estimatedCycleGasEusdcRaw =
    input.wplsPriceEusdc && input.wplsPriceEusdc > 0
      ? Math.ceil(gasPls * input.wplsPriceEusdc * 1_000_000).toString()
      : "0";
  const routeCostEusdcRaw = input.routeCostEusdcRaw ?? "0";
  const safetyBufferRaw = input.safetyBufferRaw ?? "1000";
  const dynamicTargetRaw = (
    BigInt(simpleTargetRaw) +
    BigInt(estimatedCycleGasEusdcRaw) +
    BigInt(routeCostEusdcRaw) +
    BigInt(safetyBufferRaw)
  ).toString();
  const starting = Number(input.startingEusdcRaw);
  const requiredGrossMoveBps = starting > 0 ? (Number(dynamicTargetRaw) - starting) / starting * 10_000 : 0;
  return {
    simpleTargetRaw,
    estimatedCycleGasEusdcRaw,
    routeCostEusdcRaw,
    safetyBufferRaw,
    dynamicTargetRaw,
    requiredGrossMoveBps: round(requiredGrossMoveBps, 6),
    onePercentTargetEconomicallyPlausible:
      input.wplsPriceEusdc !== null && requiredGrossMoveBps <= input.minimumNetTargetBps + 250,
    gasConversionSource:
      input.wplsPriceEusdc !== null
        ? "verified WPLS/eUSDC reserve-derived price"
      : "unavailable: no verified WPLS/eUSDC anchor",
  };
}

function pathKey(path: string): string {
  return normalize(path).toLowerCase();
}

function pathEquals(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function pathInside(child: string, parent: string): boolean {
  const rel = relative(normalize(parent), normalize(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathHasParentTraversal(raw: string): boolean {
  return raw.split(/[\\/]+/).some((segment) => segment === "..");
}

function modulePathFromUrlOrPath(moduleUrlOrPath: string): string {
  return moduleUrlOrPath.startsWith("file:")
    ? fileURLToPath(moduleUrlOrPath)
    : moduleUrlOrPath;
}

export function resolveEusdcRotationRepositoryRoot(input: {
  moduleUrlOrPath?: string;
} = {}): string {
  const modulePath = modulePathFromUrlOrPath(input.moduleUrlOrPath ?? import.meta.url);
  return normalize(resolve(dirname(modulePath), "..", "..", ".."));
}

function resolveHistoryOverride(config: AppConfig | undefined): string | null {
  const raw = config?.eusdcRotationHistoryDir;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("EUSDC_ROTATION_HISTORY_DIR must not be blank");
  }
  if (trimmed.includes("\0")) {
    throw new Error("EUSDC_ROTATION_HISTORY_DIR contains an invalid null character");
  }
  if (pathHasParentTraversal(trimmed)) {
    throw new Error("EUSDC_ROTATION_HISTORY_DIR must not contain parent-directory traversal");
  }
  if (!isAbsolute(trimmed)) {
    throw new Error("EUSDC_ROTATION_HISTORY_DIR must be an absolute path");
  }
  const normalized = normalize(trimmed);
  if (config?.agentWalletDir) {
    const walletDir = isAbsolute(config.agentWalletDir)
      ? normalize(config.agentWalletDir)
      : normalize(resolve(config.agentWalletDir));
    if (pathInside(normalized, walletDir)) {
      throw new Error("EUSDC_ROTATION_HISTORY_DIR must not be equal to or nested under AGENT_WALLET_DIR");
    }
  }
  return normalized;
}

export function resolveEusdcRotationHistoryDirectory(
  config?: AppConfig,
  input: { moduleUrlOrPath?: string } = {},
): {
  repositoryRoot: string;
  directory: string;
  source: RotationHistoryStorePathSource;
  defaultDirectory: string;
} {
  const repositoryRoot = resolveEusdcRotationRepositoryRoot(input);
  const defaultDirectory = normalize(join(repositoryRoot, "data", "eusdc-rotation-history"));
  const override = resolveHistoryOverride(config);
  return {
    repositoryRoot,
    directory: override ?? defaultDirectory,
    source: override ? "CONFIG_OVERRIDE" : "MODULE_ROOT_DEFAULT",
    defaultDirectory,
  };
}

export function resolveEusdcRotationHistoryStorePath(
  config?: AppConfig,
  input: { moduleUrlOrPath?: string } = {},
): {
  repositoryRoot: string;
  directory: string;
  path: string;
  source: RotationHistoryStorePathSource;
  defaultPath: string;
} {
  const resolved = resolveEusdcRotationHistoryDirectory(config, input);
  const defaultPath = normalize(join(resolved.defaultDirectory, "market-history.json"));
  return {
    repositoryRoot: resolved.repositoryRoot,
    directory: resolved.directory,
    path: normalize(join(resolved.directory, "market-history.json")),
    source: resolved.source,
    defaultPath,
  };
}

export function legacyCwdDerivedHistoryStorePath(cwd: string = process.cwd()): string {
  return normalize(join(cwd, "data", "eusdc-rotation-history", "market-history.json"));
}

function countHistoryRecordsAtPath(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RotationHistoryFile>;
    return Array.isArray(parsed.records) ? parsed.records.length : 0;
  } catch {
    return 0;
  }
}

function historyStorePath(config?: AppConfig): string {
  return resolveEusdcRotationHistoryStorePath(config).path;
}

function historyStoreDirectory(config?: AppConfig): string {
  return resolveEusdcRotationHistoryStorePath(config).directory;
}

function historySyncCheckpointPath(config?: AppConfig): string {
  return normalize(join(historyStoreDirectory(config), "sync-checkpoint.json"));
}

function readHistorySyncCheckpoint(config?: AppConfig): RotationHistorySyncCheckpoint | null {
  const file = historySyncCheckpointPath(config);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RotationHistorySyncCheckpoint>;
    if (
      parsed.schemaVersion === HISTORY_CHECKPOINT_SCHEMA_VERSION &&
      typeof parsed.resumeToken === "string" &&
      parsed.requestedWindow &&
      Array.isArray(parsed.completedBlockRanges) &&
      Array.isArray(parsed.completedPools)
    ) {
      return parsed as RotationHistorySyncCheckpoint;
    }
  } catch {
    return null;
  }
  return null;
}

function writeHistorySyncCheckpoint(config: AppConfig, checkpoint: RotationHistorySyncCheckpoint): void {
  mkdirSync(historyStoreDirectory(config), { recursive: true });
  atomicWriteJson(historySyncCheckpointPath(config), checkpoint, { fsync: true });
}

function clearHistorySyncCheckpoint(config: AppConfig): void {
  try {
    unlinkSync(historySyncCheckpointPath(config));
  } catch {
    // ignore absent or already-cleared checkpoint files
  }
}

function historyStoreReviewCode(config?: AppConfig): RotationHistoryStoreReviewCode {
  const resolved = resolveEusdcRotationHistoryStorePath(config);
  if (resolved.source === "CONFIG_OVERRIDE") return "OK";
  const activeCount = countHistoryRecordsAtPath(resolved.defaultPath);
  const legacyPath = legacyCwdDerivedHistoryStorePath();
  const legacyCount = pathEquals(legacyPath, resolved.defaultPath)
    ? activeCount
    : countHistoryRecordsAtPath(legacyPath);
  if (activeCount === 0 && legacyCount > 0) return "LEGACY_PUBLIC_HISTORY_MIGRATION_REQUIRED";
  if (activeCount > 0 && legacyCount > 0 && !pathEquals(legacyPath, resolved.defaultPath)) {
    return "MULTIPLE_PUBLIC_HISTORY_STORES_REQUIRE_REVIEW";
  }
  return "OK";
}

function historyPathDiagnostics(
  config?: AppConfig,
  crossProcessLockStatus: RotationHistoryCrossProcessLockStatus = "not_checked",
): RotationHistoryPathDiagnostics {
  const resolved = resolveEusdcRotationHistoryStorePath(config);
  const legacyPath = legacyCwdDerivedHistoryStorePath();
  const activeStoreRecordCount = countHistoryRecordsAtPath(resolved.path);
  const legacyStoreRecordCount = pathEquals(legacyPath, resolved.path)
    ? activeStoreRecordCount
    : countHistoryRecordsAtPath(legacyPath);
  return {
    repositoryRoot: resolved.repositoryRoot,
    currentWorkingDirectory: process.cwd(),
    historyStoreDirectory: resolved.directory,
    historyStorePath: resolved.path,
    historyStorePathSource: resolved.source,
    pathMatchesExpectedRepositoryLocalDefault: pathEquals(resolved.path, resolved.defaultPath),
    legacyCwdDerivedStorePath: legacyPath,
    legacyCwdDerivedStoreExists: existsSync(legacyPath),
    legacyStoreRecordCount,
    activeStoreRecordCount,
    repositoryLocalStoreRecordCount: countHistoryRecordsAtPath(resolved.defaultPath),
    historyStoreReviewCode: historyStoreReviewCode(config),
    crossProcessLockStatus,
  };
}

function emptyHistoryStore(chainId: number = PULSECHAIN_CHAIN_ID): RotationHistoryFile {
  return {
    schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
    chainId,
    updatedAt: new Date(0).toISOString(),
    retentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
    records: [],
  };
}

export function readRotationHistoryStore(config?: AppConfig): RotationHistoryFile {
  const file = historyStorePath(config);
  if (!existsSync(file)) return emptyHistoryStore(config?.network === "testnet" ? 943 : PULSECHAIN_CHAIN_ID);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as RotationHistoryFile;
  return {
    schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
    chainId: Number(parsed.chainId ?? PULSECHAIN_CHAIN_ID),
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    retentionDays: parsed.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
    records: Array.isArray(parsed.records) ? parsed.records : [],
    ...(parsed.lastSync ? { lastSync: parsed.lastSync } : {}),
  };
}

function assertPublicHistoryRecord(record: RotationHistoryRecord): void {
  const serialized = JSON.stringify(record).toLowerCase();
  for (const forbidden of [
    "private_key",
    "master_key",
    "seed",
    "wallet_secret",
    ".env.wallet",
    "raw_signed",
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`history record contains forbidden secret marker: ${forbidden}`);
    }
  }
}

function writeRotationHistoryStore(config: AppConfig, store: RotationHistoryFile): void {
  for (const record of store.records) assertPublicHistoryRecord(record);
  const file = historyStorePath(config);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteJson(file, { ...store, updatedAt: new Date().toISOString() }, { fsync: true });
}

function rotationHistoryFingerprint(store: RotationHistoryFile): `0x${string}` {
  return fingerprint({
    schemaVersion: store.schemaVersion,
    chainId: store.chainId,
    records: store.records.map((record) => ({
      c: record.candidateId,
      p: record.poolAddress.toLowerCase(),
      t: record.transactionHash.toLowerCase(),
      i: record.logIndex,
      ts: record.timestamp,
      px: record.candidatePriceEusdc,
    })),
  });
}

function historyRecordKey(record: Pick<RotationHistoryRecord, "chainId" | "transactionHash" | "logIndex">): string {
  return `${record.chainId}:${record.transactionHash.toLowerCase()}:${record.logIndex}`;
}

export function mergeRotationHistoryRecords(input: {
  existing: RotationHistoryRecord[];
  incoming: RotationHistoryRecord[];
  nowMs: number;
  retentionDays?: number;
  protectedStartTimestamp?: number;
  forceRecentBlockRecheck?: boolean;
  latestBlockNumber?: bigint;
}): {
  records: RotationHistoryRecord[];
  added: number;
  updated: number;
  duplicates: number;
} {
  const retentionSeconds = (input.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS) * 24 * 60 * 60;
  const retentionFloor = Math.floor(input.nowMs / 1000) - retentionSeconds;
  const protectedFloor = input.protectedStartTimestamp ?? retentionFloor;
  const floor = Math.min(retentionFloor, protectedFloor);
  const byKey = new Map<string, RotationHistoryRecord>();
  for (const record of input.existing) {
    byKey.set(historyRecordKey(record), record);
  }
  let added = 0;
  let updated = 0;
  let duplicates = 0;
  const latest = input.latestBlockNumber;
  for (const record of input.incoming) {
    if (record.timestamp < floor) continue;
    const key = historyRecordKey(record);
    const prior = byKey.get(key);
    const block = record.blockNumber ? BigInt(record.blockNumber) : null;
    const recent =
      input.forceRecentBlockRecheck === true &&
      latest !== undefined &&
      block !== null &&
      latest >= block &&
      latest - block <= HISTORY_RECENT_REORG_BLOCKS;
    if (!prior) {
      byKey.set(key, record);
      added += 1;
    } else if (recent && prior.blockHash !== record.blockHash) {
      byKey.set(key, { ...record, timestamp: prior.timestamp });
      updated += 1;
    } else {
      duplicates += 1;
    }
  }
  const records = [...byKey.values()].sort((a, b) =>
    a.timestamp - b.timestamp ||
    a.transactionHash.localeCompare(b.transactionHash) ||
    a.logIndex - b.logIndex,
  );
  return { records, added, updated, duplicates };
}

const historyLocks = new Map<string, Promise<unknown>>();
const HISTORY_LOCK_STALE_MS = 30 * 60 * 1000;

async function withHistoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = historyLocks.get(key) ?? Promise.resolve();
  const current = prior.then(fn, fn);
  const stored = current.catch(() => undefined);
  historyLocks.set(key, stored);
  try {
    return await current;
  } finally {
    if (historyLocks.get(key) === stored) historyLocks.delete(key);
  }
}

interface RotationHistoryLockMetadata {
  pid: number;
  hostname: string;
  createdAt: string;
  historyStorePath: string;
}

class HistorySyncBusyError extends Error {
  status: RotationHistoryCrossProcessLockStatus;
  constructor(message: string, status: RotationHistoryCrossProcessLockStatus) {
    super(message);
    this.name = "HistorySyncBusyError";
    this.status = status;
  }
}

function processAppearsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readHistoryLockMetadata(lockPath: string): RotationHistoryLockMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<RotationHistoryLockMetadata>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.historyStorePath === "string"
    ) {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        createdAt: parsed.createdAt,
        historyStorePath: parsed.historyStorePath,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function inspectHistoryWriteLock(
  lockPath: string,
): RotationHistoryCrossProcessLockStatus {
  if (!existsSync(lockPath)) return "free";
  const metadata = readHistoryLockMetadata(lockPath);
  if (!metadata) return "busy_unverified_owner";
  if (metadata.hostname === hostname() && processAppearsLive(metadata.pid)) {
    return "busy_live_owner";
  }
  return "busy_unverified_owner";
}

function acquireHistoryWriteLock(config: AppConfig): {
  lockPath: string;
  acquiredStatus: RotationHistoryCrossProcessLockStatus;
  release: () => RotationHistoryCrossProcessLockStatus;
} {
  const resolved = resolveEusdcRotationHistoryStorePath(config);
  mkdirSync(resolved.directory, { recursive: true });
  const lockPath = join(resolved.directory, "market-history.lock");
  const metadata: RotationHistoryLockMetadata = {
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
    historyStorePath: resolved.path,
  };
  let removedStale = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, JSON.stringify(metadata, null, 2));
      } finally {
        closeSync(fd);
      }
      return {
        lockPath,
        acquiredStatus: removedStale ? "stale_removed" : "acquired",
        release: () => {
          try {
            const owned = readHistoryLockMetadata(lockPath);
            if (owned?.pid === process.pid && owned.hostname === hostname()) {
              unlinkSync(lockPath);
            }
          } catch {
            // Best-effort cleanup; stale-lock handling is conservative.
          }
          return "released";
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      const metadata = readHistoryLockMetadata(lockPath);
      const metadataAgeMs = metadata ? Date.now() - Date.parse(metadata.createdAt) : Number.NaN;
      const canRemoveStale =
        metadata?.hostname === hostname() &&
        Number.isFinite(metadataAgeMs) &&
        metadataAgeMs > HISTORY_LOCK_STALE_MS &&
        !processAppearsLive(metadata.pid);
      if (canRemoveStale) {
        try {
          const stats = statSync(lockPath);
          const ageMs = Date.now() - stats.mtimeMs;
          if (ageMs > HISTORY_LOCK_STALE_MS) {
            unlinkSync(lockPath);
            removedStale = true;
            continue;
          }
        } catch {
          // Fall through to busy if the stale lock cannot be safely removed.
        }
      }
      const lockStatus = inspectHistoryWriteLock(lockPath);
      throw new HistorySyncBusyError("public history sync is already locked by another writer", lockStatus);
    }
  }
  throw new HistorySyncBusyError("public history sync lock could not be acquired", "busy_unverified_owner");
}

function decimalHumanToRaw(value: string | number | undefined, decimals: number): string {
  const text = String(value ?? "0");
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || text.startsWith("-")) return "0";
  try {
    return parseUnits(text, decimals).toString();
  } catch {
    return "0";
  }
}

function parseSubgraphLogIndex(swap: SubgraphSwap, fallback: number): number {
  const parts = String(swap.id ?? "").split(/[-:#]/).reverse();
  for (const part of parts) {
    if (/^\d+$/.test(part)) return Number(part);
  }
  return fallback;
}

function swapTransactionHash(swap: SubgraphSwap, fallback: string): `0x${string}` {
  const tx = String(swap.transaction?.id ?? "");
  return /^0x[a-fA-F0-9]{64}$/.test(tx) ? (tx as `0x${string}`) : fingerprint({ fallback, id: swap.id });
}

function pairTokenAddress(pair: SubgraphPair, index: 0 | 1): `0x${string}` {
  const id = index === 0 ? pair.token0.id : pair.token1.id;
  return id.toLowerCase() as `0x${string}`;
}

function historyRecordFromSubgraphSwap(input: {
  chainId: number;
  candidate: RotationCandidateRegistryEntry;
  pair: SubgraphPair;
  sourcePool?: RotationHistorySourcePoolRef;
  swap: SubgraphSwap;
  observation: RotationPriceObservation;
  fetchedAt: string;
  fallbackLogIndex: number;
}): RotationHistoryRecord {
  const pair = input.pair;
  const amount0Human = num(input.swap.amount0In) + num(input.swap.amount0Out);
  const amount1Human = num(input.swap.amount1In) + num(input.swap.amount1Out);
  const token0Decimals = pairTokenDecimals(pair, pair.token0.id, 18);
  const token1Decimals = pairTokenDecimals(pair, pair.token1.id, 18);
  const txHash = swapTransactionHash(input.swap, `${pair.id}:${input.swap.id}`);
  return {
    chainId: input.chainId,
    candidateId: input.candidate.candidateId,
    poolAddress: pair.id.toLowerCase() as `0x${string}`,
    factoryAddress: input.sourcePool?.factoryAddress ?? null,
    protocol: input.sourcePool?.protocol ?? "PulseX V2",
    sourceVersion: input.sourcePool?.sourceVersion,
    eventAdapter: input.sourcePool?.eventAdapter,
    anchorPoolAddress: input.observation.anchorPoolAddress,
    anchorAgeSeconds: input.observation.anchorAgeSeconds,
    blockNumber: null,
    blockHash: null,
    transactionHash: txHash,
    logIndex: parseSubgraphLogIndex(input.swap, input.fallbackLogIndex),
    timestamp: Number(input.swap.timestamp),
    token0: pairTokenAddress(pair, 0),
    token1: pairTokenAddress(pair, 1),
    amount0Raw: decimalHumanToRaw(String(amount0Human), token0Decimals),
    amount1Raw: decimalHumanToRaw(String(amount1Human), token1Decimals),
    candidatePriceEusdc: round(input.observation.priceEusdc, 18),
    eusdcNotionalRaw: decimalHumanToRaw(String(input.observation.volumeEusdc), 6),
    source: input.observation.source.includes("historical")
      ? `${(input.sourcePool?.sourceVersion ?? "PULSEX_V2").toLowerCase()}-subgraph-time-aligned-anchor`
      : `${(input.sourcePool?.sourceVersion ?? "PULSEX_V2").toLowerCase()}-subgraph`,
    fetchedAt: input.fetchedAt,
  };
}

function recordsForCandidate(
  store: RotationHistoryFile,
  candidate: RotationCandidateRegistryEntry,
  startTimestamp: number,
  endTimestamp: number,
): RotationHistoryRecord[] {
  return store.records
    .filter((record) =>
      record.chainId === store.chainId &&
      record.candidateId === candidate.candidateId &&
      record.timestamp >= startTimestamp &&
      record.timestamp <= endTimestamp &&
      record.candidatePriceEusdc > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex);
}

function observationsFromHistory(records: RotationHistoryRecord[]): RotationPriceObservation[] {
  return records.map((record) => ({
    timestamp: record.timestamp,
    priceEusdc: record.candidatePriceEusdc,
    volumeEusdc: Number(formatUnits(BigInt(record.eusdcNotionalRaw), 6)),
    swapId: `${record.transactionHash}:${record.logIndex}`,
    source: record.source,
    blockNumber: record.blockNumber,
    poolAddress: record.poolAddress,
    anchorPoolAddress: record.anchorPoolAddress,
    anchorAgeSeconds: record.anchorAgeSeconds,
  }));
}

export function calculatePriceContinuityPercent(input: {
  observations: RotationPriceObservation[];
  lookbackMinutes: number;
  candleMinutes: number;
  nowMs: number;
  maxCarryForwardMinutes?: number;
}): number {
  const expectedCandles = Math.ceil(input.lookbackMinutes / input.candleMinutes);
  if (expectedCandles <= 0 || input.observations.length === 0) return 0;
  const candleSeconds = input.candleMinutes * 60;
  const maxCarrySeconds = (input.maxCarryForwardMinutes ?? PRICE_CARRY_FORWARD_MAX_MINUTES) * 60;
  const endSeconds = Math.floor(input.nowMs / 1000 / candleSeconds) * candleSeconds;
  const startSeconds = endSeconds - expectedCandles * candleSeconds;
  const observations = [...input.observations]
    .filter((obs) => obs.timestamp >= startSeconds && obs.timestamp < endSeconds)
    .sort((a, b) => a.timestamp - b.timestamp);
  let cursor = 0;
  let lastObserved: RotationPriceObservation | null = null;
  let covered = 0;
  for (let bucket = startSeconds; bucket < endSeconds; bucket += candleSeconds) {
    const bucketEnd = bucket + candleSeconds;
    while (cursor < observations.length && observations[cursor]!.timestamp < bucketEnd) {
      lastObserved = observations[cursor]!;
      cursor += 1;
    }
    if (lastObserved && bucketEnd - lastObserved.timestamp <= maxCarrySeconds) {
      covered += 1;
    }
  }
  return round(covered / expectedCandles * 100, 4);
}

export function classifyHistoryAnalysisMode(input: {
  sourceCompletenessPercent: number;
  activeTradeCandlePercent: number;
  priceContinuityPercent: number;
  actualTradeCount: number;
  latestTradeAgeMinutes: number | null;
  maximumObservedGapMinutes: number | null;
  routeConnected: boolean;
  liquidityPasses: boolean;
  priceDispersionPercent: number | null;
  sourceTruncated: boolean;
}): RotationAnalysisMode {
  if (input.sourceCompletenessPercent < 95 || input.sourceTruncated) return "UNUSABLE_HISTORY";
  if (input.latestTradeAgeMinutes === null || input.latestTradeAgeMinutes > FRESH_TRADE_MAX_AGE_MINUTES) {
    return "UNUSABLE_HISTORY";
  }
  if (input.activeTradeCandlePercent >= 80) return "DENSE_CANDLES";
  const dispersionOk = input.priceDispersionPercent === null || input.priceDispersionPercent <= 5;
  if (
    input.actualTradeCount >= SPARSE_MIN_ACTUAL_SWAPS &&
    (input.maximumObservedGapMinutes ?? Number.POSITIVE_INFINITY) <= SPARSE_MAX_GAP_MINUTES &&
    input.routeConnected &&
    input.liquidityPasses &&
    dispersionOk &&
    input.priceContinuityPercent >= 50
  ) {
    return "SPARSE_EVENT_TIME";
  }
  return "UNUSABLE_HISTORY";
}

function sourceCompletenessForRecords(input: {
  records: RotationHistoryRecord[];
  startTimestamp: number;
  endTimestamp: number;
  syncStatus?: RotationHistoryCandidateSyncStatus;
}): { percent: number; unresolvedGaps: string[]; truncated: boolean } {
  const unresolved: string[] = [];
  if (input.records.length === 0) {
    unresolved.push("no stored records in requested window");
    return { percent: 0, unresolvedGaps: unresolved, truncated: true };
  }
  const earliest = input.records[0]!.timestamp;
  const latest = input.records[input.records.length - 1]!.timestamp;
  const window = Math.max(1, input.endTimestamp - input.startTimestamp);
  const coveredStart = Math.max(input.startTimestamp, earliest);
  const coveredEnd = Math.min(input.endTimestamp, latest);
  const spanPercent = Math.max(0, Math.min(100, (coveredEnd - coveredStart) / window * 100));
  const requiredPools = input.syncStatus?.pools.filter((pool) =>
    pool.classification === "REQUIRED_PRICE_POOL" || pool.classification === undefined,
  ) ?? [];
  const completenessPools = requiredPools.length > 0 ? requiredPools : input.syncStatus?.pools ?? [];
  const statusPercent = input.syncStatus && completenessPools.length > 0
    ? round(completenessPools.filter((report) =>
      report.rangeFullyScanned ||
      report.boundaryCrossed ||
      report.truncationReason === "NONE" ||
      report.truncationReason === "SPARSE_ACTUAL_TRADING" ||
      report.truncationReason === "STALE_POOL",
    ).length / completenessPools.length * 100, 4)
    : input.syncStatus?.sourceCompletenessPercent;
  const requiredRangeComplete = completenessPools.length > 0 && completenessPools.every((pool) =>
    pool.rangeFullyScanned ||
    pool.boundaryCrossed ||
    pool.truncationReason === "NONE" ||
    pool.truncationReason === "SPARSE_ACTUAL_TRADING" ||
    pool.truncationReason === "STALE_POOL"
  );
  const recentSignalOnly = input.syncStatus?.syncPurpose === "RECENT_SIGNAL_WINDOW";
  const percent = input.syncStatus?.boundaryCrossed || (requiredRangeComplete && !recentSignalOnly)
    ? 100
    : round(Math.max(spanPercent, statusPercent ?? 0), 4);
  const truncated = completenessPools.length > 0
    ? completenessPools.some((pool) =>
      pool.truncationReason !== "NONE" &&
      pool.truncationReason !== "SPARSE_ACTUAL_TRADING" &&
      pool.truncationReason !== "STALE_POOL"
    )
    : percent < 95;
  if (earliest > input.startTimestamp && !requiredRangeComplete) {
    unresolved.push("oldest stored record does not cross requested start boundary");
  }
  if (latest < input.endTimestamp - FRESH_TRADE_MAX_AGE_MINUTES * 60) unresolved.push("latest stored record is stale");
  for (const gap of input.syncStatus?.unresolvedGaps ?? []) {
    const requiredGap = completenessPools.some((pool) => gap.includes(pool.poolAddress));
    if (requiredGap || completenessPools.length === 0) unresolved.push(gap);
  }
  return { percent, unresolvedGaps: [...new Set(unresolved)], truncated };
}

function buildHistoryQuality(input: {
  records: RotationHistoryRecord[];
  observations: RotationPriceObservation[];
  coverage: RotationCandleCoverage;
  sourceCompletenessPercent: number;
  sourceTruncated: boolean;
  unresolvedGaps: string[];
  routeConnected: boolean;
  liquidityPasses: boolean;
  priceDispersionPercent: number | null;
  nowMs: number;
  lookbackMinutes: number;
  candleMinutes: number;
}): RotationHistoryQuality {
  const latest = input.observations[input.observations.length - 1];
  const latestTradeAgeMinutes = latest
    ? round((Math.floor(input.nowMs / 1000) - latest.timestamp) / 60, 4)
    : null;
  const activeTradeCandlePercent = input.coverage.coveragePercent;
  const priceContinuityPercent = calculatePriceContinuityPercent({
    observations: input.observations,
    lookbackMinutes: input.lookbackMinutes,
    candleMinutes: input.candleMinutes,
    nowMs: input.nowMs,
  });
  const analysisMode = classifyHistoryAnalysisMode({
    sourceCompletenessPercent: input.sourceCompletenessPercent,
    activeTradeCandlePercent,
    priceContinuityPercent,
    actualTradeCount: input.observations.length,
    latestTradeAgeMinutes,
    maximumObservedGapMinutes: input.coverage.maximumDataGapMinutes,
    routeConnected: input.routeConnected,
    liquidityPasses: input.liquidityPasses,
    priceDispersionPercent: input.priceDispersionPercent,
    sourceTruncated: input.sourceTruncated,
  });
  return {
    sourceCompletenessPercent: input.sourceCompletenessPercent,
    activeTradeCandlePercent,
    priceContinuityPercent,
    analysisMode,
    latestTradeAgeMinutes,
    maximumObservedGapMinutes: input.coverage.maximumDataGapMinutes,
    actualTradeCount: input.records.length,
    sourceTruncated: input.sourceTruncated,
    unresolvedGaps: input.unresolvedGaps,
    readinessForLiveScanning: analysisMode !== "UNUSABLE_HISTORY",
  };
}

export function analyzeHistoricalReversions(input: {
  observations: RotationPriceObservation[];
  targetBps: number;
  lookbackMinutes: number;
}): RotationHistoricalReversionEvidence {
  const observations = [...input.observations].sort((a, b) => a.timestamp - b.timestamp);
  if (observations.length < 3) {
    return {
      targetBps: input.targetBps,
      completedReversions: 0,
      failedReversions: 0,
      completionRatePercent: 0,
      medianCompletionTimeMinutes: null,
      medianAdverseContinuationBps: null,
      worstAdverseContinuationBps: null,
      daysWithNoQualifyingReversal: Math.ceil(input.lookbackMinutes / 1440),
    };
  }
  let reference = observations[0]!;
  let active:
    | {
        referencePrice: number;
        localLowPrice: number;
        localLowTimestamp: number;
        worstAdverseBps: number;
      }
    | null = null;
  const completionTimes: number[] = [];
  const adverseContinuations: number[] = [];
  let failed = 0;
  const completedDays = new Set<string>();
  for (const obs of observations.slice(1)) {
    if (obs.priceEusdc > reference.priceEusdc && !active) {
      reference = obs;
    }
    if (!active) {
      const dipBps = reference.priceEusdc > 0
        ? (reference.priceEusdc - obs.priceEusdc) / reference.priceEusdc * 10_000
        : 0;
      if (dipBps >= input.targetBps) {
        active = {
          referencePrice: reference.priceEusdc,
          localLowPrice: obs.priceEusdc,
          localLowTimestamp: obs.timestamp,
          worstAdverseBps: 0,
        };
      }
      continue;
    }
    if (obs.priceEusdc < active.localLowPrice) {
      active.localLowPrice = obs.priceEusdc;
      active.localLowTimestamp = obs.timestamp;
      active.worstAdverseBps = active.referencePrice > 0
        ? Math.max(active.worstAdverseBps, (active.referencePrice - obs.priceEusdc) / active.referencePrice * 10_000)
        : active.worstAdverseBps;
    }
    const reboundBps = active.localLowPrice > 0
      ? (obs.priceEusdc - active.localLowPrice) / active.localLowPrice * 10_000
      : 0;
    if (reboundBps >= input.targetBps) {
      completionTimes.push((obs.timestamp - active.localLowTimestamp) / 60);
      adverseContinuations.push(active.worstAdverseBps);
      completedDays.add(new Date(obs.timestamp * 1000).toISOString().slice(0, 10));
      reference = obs;
      active = null;
    }
  }
  if (active) failed += 1;
  const completed = completionTimes.length;
  const attempts = completed + failed;
  const totalDays = Math.max(1, Math.ceil(input.lookbackMinutes / 1440));
  return {
    targetBps: input.targetBps,
    completedReversions: completed,
    failedReversions: failed,
    completionRatePercent: attempts > 0 ? round(completed / attempts * 100, 4) : 0,
    medianCompletionTimeMinutes: median(completionTimes),
    medianAdverseContinuationBps: median(adverseContinuations),
    worstAdverseContinuationBps: adverseContinuations.length > 0 ? round(Math.max(...adverseContinuations), 6) : null,
    daysWithNoQualifyingReversal: Math.max(0, totalDays - completedDays.size),
  };
}

function buildTargetAwareReversion(input: {
  observations: RotationPriceObservation[];
  dipReboundEvidence: RotationDipReboundEvidence;
  economicFeasibility: RotationEconomicFeasibility;
  requestedNetTargetBps: number;
  lookbackMinutes: number;
}): RotationTargetAwareReversion {
  const requiredGrossMoveBps = input.economicFeasibility.requiredGrossMoveBps;
  const currentDipBps = input.dipReboundEvidence.status === "AVAILABLE"
    ? input.dipReboundEvidence.dipBps ?? null
    : null;
  const currentReboundBps = input.dipReboundEvidence.status === "AVAILABLE"
    ? input.dipReboundEvidence.reboundBps ?? null
    : null;
  const dynamic = analyzeHistoricalReversions({
    observations: input.observations,
    targetBps: requiredGrossMoveBps,
    lookbackMinutes: input.lookbackMinutes,
  });
  const simple = analyzeHistoricalReversions({
    observations: input.observations,
    targetBps: input.requestedNetTargetBps,
    lookbackMinutes: input.lookbackMinutes,
  });
  const projectedRemaining =
    currentReboundBps === null ? null : round(Math.max(0, requiredGrossMoveBps - currentReboundBps), 6);
  return {
    requestedNetTargetBps: input.requestedNetTargetBps,
    requiredGrossMoveBps,
    currentDipBps,
    currentReboundBps,
    projectedRemainingMoveBps: projectedRemaining,
    historicalProbabilityOfCompletionPercent: dynamic.completionRatePercent,
    medianTimeToCompleteMinutes: dynamic.medianCompletionTimeMinutes,
    simpleOnePercentReversions: simple,
    dynamicTargetReversions: dynamic,
    dynamicGrossMoveSupported:
      currentDipBps !== null &&
      currentDipBps >= requiredGrossMoveBps &&
      dynamic.completedReversions > 0,
  };
}

function ledgerPath(config: AppConfig): string {
  return join(config.agentWalletDir, "eusdc-rotation-ledger.json");
}

function emptyLedger(): RotationLedgerFile {
  return {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    cycles: [],
  };
}

export function readRotationLedger(config: AppConfig): RotationLedgerFile {
  const file = ledgerPath(config);
  if (!existsSync(file)) return emptyLedger();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as RotationLedgerFile;
  return {
    schemaVersion: 1,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    cycles: Array.isArray(parsed.cycles) ? parsed.cycles : [],
  };
}

function writeRotationLedger(config: AppConfig, ledger: RotationLedgerFile): void {
  const file = ledgerPath(config);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteJson(file, { ...ledger, updatedAt: new Date().toISOString() }, { fsync: true });
}

export function getOpenRotationCycle(ledger: RotationLedgerFile, walletId: string): RotationCycleLedgerEntry | null {
  const terminal = new Set<RotationCycleState>(["CYCLE_COMPLETE", "ABORTED"]);
  const open = ledger.cycles.filter(
    (cycle) => cycle.walletId === walletId && !terminal.has(cycle.state),
  );
  return open.length === 0 ? null : open[open.length - 1]!;
}

function generateCycleId(nowMs: number, walletId: string, candidateId: RotationCandidateId): string {
  return `cycle_${fingerprint({ nowMs, walletId, candidateId }).slice(2, 18)}`;
}

function normalizeScanInput(input: RotationScanInput): Required<RotationScanInput> {
  return {
    walletId: input.walletId,
    lookbackMinutes: input.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES,
    candleMinutes: input.candleMinutes ?? DEFAULT_CANDLE_MINUTES,
    minimumDipBps: input.minimumDipBps ?? DEFAULT_MINIMUM_DIP_BPS,
    minimumReboundConfirmationBps:
      input.minimumReboundConfirmationBps ?? DEFAULT_MINIMUM_REBOUND_BPS,
    minimumNetTargetBps: input.minimumNetTargetBps ?? DEFAULT_MINIMUM_NET_TARGET_BPS,
  };
}

function isRouteConnected(status: RotationRouteAvailabilityStatus): boolean {
  return status === "DIRECT_POOL" ||
    status === "MULTIHOP_VIA_WPLS" ||
    status === "MULTIHOP_OTHER_VERIFIED" ||
    status === "both_directions";
}

const READY_SELECTION_ANALYSIS_MODES: ReadonlySet<RotationAnalysisMode> = new Set([
  "DENSE_CANDLES",
  "SPARSE_EVENT_TIME",
]);

function isCurrentSignalBlockingHistoryGap(gap: string): boolean {
  const normalized = gap.toLowerCase();
  if (normalized.includes("oldest stored record does not cross requested start boundary")) {
    return false;
  }
  return true;
}

function isSourceFailureReadinessBlocker(blocker: string): boolean {
  return /data source failure|candidate market data source failure|rpc range error|lock|failed|error|unsupported/i.test(blocker);
}

function metricAvailable(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredSignalMetricsAvailable(row: RotationCandidateScanRow): boolean {
  return metricAvailable(row.fiveMinuteReturnBps) &&
    metricAvailable(row.fifteenMinuteReturnBps) &&
    metricAvailable(row.oneHourReturnBps) &&
    metricAvailable(row.sixHourReturnBps) &&
    metricAvailable(row.distanceFromRollingOneHourHighBps) &&
    metricAvailable(row.reboundFromMostRecentLocalLowBps) &&
    metricAvailable(row.realizedVolatilityBps);
}

export function isCandidateReadyForSelection(
  row: RotationCandidateScanRow,
): RotationCandidateSelectionReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const historyQuality = row.historyQuality;

  if (!historyQuality) {
    blockers.push("historyQuality missing");
  } else {
    if (!historyQuality.readinessForLiveScanning) {
      blockers.push("historyQuality.readinessForLiveScanning is false");
    }
    if (!READY_SELECTION_ANALYSIS_MODES.has(historyQuality.analysisMode)) {
      blockers.push(`analysis mode ${historyQuality.analysisMode} is not selectable`);
    }
    if (historyQuality.sourceCompletenessPercent < 95) {
      blockers.push("current 24-hour source completeness below 95%");
    }
    if (historyQuality.sourceTruncated) {
      blockers.push("current 24-hour source range is truncated");
    }
    if (
      historyQuality.latestTradeAgeMinutes === null ||
      historyQuality.latestTradeAgeMinutes > FRESH_TRADE_MAX_AGE_MINUTES
    ) {
      blockers.push("latest trade is stale or unavailable");
    }
    if (historyQuality.actualTradeCount < SPARSE_MIN_ACTUAL_SWAPS) {
      blockers.push("insufficient actual trade count");
    }
    if (
      historyQuality.maximumObservedGapMinutes !== null &&
      historyQuality.maximumObservedGapMinutes > SPARSE_MAX_GAP_MINUTES
    ) {
      blockers.push("excessive observed trade gap");
    }
    for (const gap of historyQuality.unresolvedGaps) {
      if (isCurrentSignalBlockingHistoryGap(gap)) {
        blockers.push(`history gap: ${gap}`);
      } else {
        warnings.push(`history gap: ${gap}`);
      }
    }
  }

  if (!row.addressValidation.ok) {
    blockers.push("token identity validation failed");
  }
  if (!isRouteConnected(row.routeAvailabilityStatus)) {
    blockers.push("route evidence missing in one or both directions");
  }
  if (!requiredSignalMetricsAvailable(row)) {
    blockers.push("required entry metrics are unavailable");
  }
  if (row.rejectionReasons.includes("market data source failure")) {
    blockers.push("candidate market data source failure");
  }
  if (row.rejectionReasons.includes("market evidence is stale or incomplete")) {
    blockers.push("market evidence is stale or incomplete");
  }

  const currentSignalWindowReady = blockers.length === 0;
  const sevenDayStatisticsReady = Boolean(
    historyQuality &&
      READY_SELECTION_ANALYSIS_MODES.has(historyQuality.analysisMode) &&
      historyQuality.sourceCompletenessPercent >= 99.5 &&
      !historyQuality.sourceTruncated &&
      historyQuality.unresolvedGaps.length === 0 &&
      historyQuality.priceContinuityPercent >= 95,
  );
  if (currentSignalWindowReady && !sevenDayStatisticsReady) {
    warnings.push("seven-day statistics are incomplete or diagnostic-only");
  }

  return {
    candidateId: row.candidateId,
    ready: currentSignalWindowReady,
    analysisMode: historyQuality?.analysisMode ?? null,
    currentSignalWindowReady,
    sevenDayStatisticsReady,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
  };
}

export function buildCandidateScanRow(input: {
  candidate: RotationCandidateRegistryEntry;
  tokenValidation: RotationTokenValidation;
  market: RotationMarketEvidence;
  scanInput: Required<RotationScanInput>;
  state: RotationCycleState;
  hasOpenCycle: boolean;
  inCooldown?: boolean;
}): RotationCandidateScanRow {
  const { candidate, tokenValidation, market, scanInput } = input;
  const rejectionReasons = [...tokenValidation.rejectionReasons];
  if (!candidate.enabled) rejectionReasons.push("candidate disabled");
  if (input.hasOpenCycle) rejectionReasons.push("open cycle exists");
  if (input.state !== "EUSDC_IDLE") rejectionReasons.push(`wallet state is ${input.state}`);
  if (input.inCooldown) rejectionReasons.push("candidate cooldown active");
  if (!market.evidenceFresh) rejectionReasons.push("market evidence is stale or incomplete");
  if (market.dataSourceErrors.length > 0) rejectionReasons.push("market data source failure");
  if (!isRouteConnected(market.routeAvailabilityStatus)) {
    rejectionReasons.push("read-only route availability missing in one or both directions");
  }
  const liquidityForGate = market.largestPoolLiquidityEusdc ?? market.largestPoolLiquidityUsd;
  const volumeForGate = market.recentVolumeEusdc ?? market.recentVolumeUsd;
  if (liquidityForGate < candidate.minimumLiquidityUsd) {
    rejectionReasons.push("largest-pool liquidity below threshold");
  }
  if (volumeForGate < candidate.minimumRecentVolumeUsd) {
    rejectionReasons.push("recent volume below threshold");
  }
  if (
    market.estimatedPriceImpactPercent === null ||
    market.estimatedPriceImpactPercent > candidate.maximumPriceImpactPercent
  ) {
    rejectionReasons.push("modeled price impact above threshold or unavailable");
  }
  const distanceHigh = market.distanceFromOneHourHighBps;
  if (distanceHigh === null || distanceHigh > -scanInput.minimumDipBps) {
    rejectionReasons.push("price has not declined enough from rolling reference");
  }
  const rebound = market.reboundFromRecentLocalLowBps;
  if (rebound === null || rebound < scanInput.minimumReboundConfirmationBps) {
    rejectionReasons.push("rebound confirmation below threshold");
  }
  if (market.directionalTrendScore < -50) {
    rejectionReasons.push("severe continuing downtrend detected");
  }
  if (market.candleCoverage && market.candleCoverage.coveragePercent < 80 && !market.candleCoverage.sparseMarketMethodUsed) {
    rejectionReasons.push("insufficient candle coverage");
  }
  if (market.candleCoverage?.truncated) {
    rejectionReasons.push("unresolved swap pagination truncation");
  }
  if (market.historyQuality) {
    if (market.historyQuality.sourceCompletenessPercent < 95) {
      rejectionReasons.push("source completeness below 95%");
    }
    if (market.historyQuality.analysisMode === "UNUSABLE_HISTORY") {
      rejectionReasons.push("unusable price history");
    }
    if (market.historyQuality.latestTradeAgeMinutes === null ||
      market.historyQuality.latestTradeAgeMinutes > FRESH_TRADE_MAX_AGE_MINUTES) {
      rejectionReasons.push("latest trade is stale or unavailable");
    }
    if (market.historyQuality.actualTradeCount < SPARSE_MIN_ACTUAL_SWAPS) {
      rejectionReasons.push("insufficient actual trade count");
    }
    if (market.historyQuality.maximumObservedGapMinutes !== null &&
      market.historyQuality.maximumObservedGapMinutes > SPARSE_MAX_GAP_MINUTES) {
      rejectionReasons.push("excessive observed trade gap");
    }
    for (const gap of market.historyQuality.unresolvedGaps) {
      if (isCurrentSignalBlockingHistoryGap(gap)) {
        rejectionReasons.push(`history gap: ${gap}`);
      }
    }
  }
  if (market.dipReboundEvidence?.status === "AVAILABLE") {
    if (!market.dipReboundEvidence.volumeConfirmation) rejectionReasons.push("rebound volume confirmation missing");
    if (market.dipReboundEvidence.trendRejected) {
      rejectionReasons.push(market.dipReboundEvidence.reason ?? "trend rejection evidence present");
    }
  }
  if (market.targetAwareReversion) {
    const requiredGross = market.targetAwareReversion.requiredGrossMoveBps;
    if (
      market.targetAwareReversion.currentDipBps === null ||
      market.targetAwareReversion.currentDipBps < requiredGross
    ) {
      rejectionReasons.push("current dip does not meet dynamic gross target");
    }
    if (
      market.targetAwareReversion.currentReboundBps !== null &&
      market.targetAwareReversion.currentReboundBps < scanInput.minimumReboundConfirmationBps
    ) {
      rejectionReasons.push("actual-trade rebound below configured confirmation");
    }
    if (!market.targetAwareReversion.dynamicGrossMoveSupported) {
      rejectionReasons.push("historical dynamic-target reversion is not proven");
    }
  }
  const metricAvailability: Record<string, RotationMetricStatus> = market.metrics
    ? {
        fiveMinuteReturnBps: metricStatus(market.metrics.fiveMinuteReturnBps),
        fifteenMinuteReturnBps: metricStatus(market.metrics.fifteenMinuteReturnBps),
        oneHourReturnBps: metricStatus(market.metrics.oneHourReturnBps),
        sixHourReturnBps: metricStatus(market.metrics.sixHourReturnBps),
        realizedVolatilityBps: metricStatus(market.metrics.realizedVolatilityBps),
        reboundFromRecentLocalLowBps: metricStatus(market.metrics.reboundFromRecentLocalLowBps),
      }
    : {};
  if (market.metrics) {
    for (const [name, status] of Object.entries(metricAvailability)) {
      if (status.status === "UNAVAILABLE") {
        rejectionReasons.push(`${name} unavailable: ${status.reason ?? "missing"}`);
      }
    }
  }

  const rawScore =
    0.3 * clampScore(market.meanReversionScore) +
    0.2 * clampScore(market.liquidityScore) +
    0.15 * clampScore(market.volumeScore) +
    0.15 * clampScore((rebound ?? 0) / Math.max(1, scanInput.minimumReboundConfirmationBps) * 50) +
    0.1 * clampScore(market.routeQualityScore) +
    0.1 * clampScore(market.volatilitySuitabilityScore) -
    Math.max(0, -market.directionalTrendScore) * 0.25 -
    (market.tradeCount < 5 ? 15 : 0) -
    (market.dataSourceErrors.length > 0 ? 30 : 0);

  const eligibility = tokenValidation.ok && rejectionReasons.length === 0;
  return {
    candidateId: candidate.candidateId,
    displaySymbol: candidate.displaySymbol,
    executionTokenAddress: candidate.executionTokenAddress,
    addressValidation: tokenValidation,
    symbol: tokenValidation.symbol,
    decimals: tokenValidation.decimals,
    relevantPools: market.relevantPools,
    largestPoolLiquidityUsd: market.largestPoolLiquidityUsd,
    aggregateLiquidityUsd: market.aggregateLiquidityUsd,
    largestPoolLiquidityEusdc: market.largestPoolLiquidityEusdc,
    aggregateLiquidityEusdc: market.aggregateLiquidityEusdc,
    recentVolumeUsd: market.recentVolumeUsd,
    recentVolumeEusdc: market.recentVolumeEusdc,
    tradeCount: market.tradeCount,
    uniqueTransactionCount: market.uniqueTransactionCount,
    fiveMinuteReturnBps: market.fiveMinuteReturnBps,
    fifteenMinuteReturnBps: market.fifteenMinuteReturnBps,
    oneHourReturnBps: market.oneHourReturnBps,
    sixHourReturnBps: market.sixHourReturnBps,
    distanceFromRollingOneHourHighBps: market.distanceFromOneHourHighBps,
    distanceFromRollingOneHourLowBps: market.distanceFromOneHourLowBps,
    reboundFromMostRecentLocalLowBps: market.reboundFromRecentLocalLowBps,
    realizedVolatilityBps: market.realizedVolatilityBps,
    directionalTrendScore: market.directionalTrendScore,
    meanReversionScore: market.meanReversionScore,
    liquidityScore: market.liquidityScore,
    volumeScore: market.volumeScore,
    estimatedPriceImpactForCompleteEusdcBalancePercent:
      market.estimatedPriceImpactPercent,
    routeAvailabilityStatus: market.routeAvailabilityStatus,
    entryRouteAvailability: market.entryRouteAvailability,
    exitRouteAvailability: market.exitRouteAvailability,
    eligibility,
    score: eligibility ? Math.round(clampScore(rawScore) * 100) / 100 : 0,
    rejectionReasons,
    metrics: market.metrics,
    metricAvailability,
    candleCoverage: market.candleCoverage,
    dipReboundEvidence: market.dipReboundEvidence,
    historyQuality: market.historyQuality,
    targetAwareReversion: market.targetAwareReversion,
    poolConsolidation: market.poolConsolidation,
    dataSourcesUsed: market.dataSourcesUsed,
    dataFreshness: market.dataFreshness,
    rankingStatus: eligibility
      ? "ELIGIBLE_RANKED"
      : rejectionReasons.some((reason) => /history|source completeness|pagination|trade count|latest trade|gap|candle coverage/i.test(reason))
        ? "UNRANKED_INCOMPLETE_HISTORY"
        : "UNRANKED_NO_EVIDENCE",
  };
}

export function selectRotationWinner(rows: RotationCandidateScanRow[]): {
  decision: RotationScanDecision;
  winner?: RotationCandidateId;
  rankedCandidateIds: RotationCandidateId[];
  diagnosticOrdering: RotationCandidateId[];
  readyCandidateRanking: RotationCandidateId[];
  eligibleCandidateRanking: RotationCandidateId[];
  historyReady: boolean;
  readyCandidateIds: RotationCandidateId[];
  incompleteCandidateIds: RotationCandidateId[];
  selectionCandidateIds: RotationCandidateId[];
  selectionScope: "READY_CANDIDATES_ONLY";
  candidateReadiness: RotationCandidateSelectionReadiness[];
  historyDecisionReason: string;
  tiedCandidateIds?: RotationCandidateId[];
  reason?: string;
} {
  const diagnostic = [...rows].sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    const liquidityDelta = (b.aggregateLiquidityEusdc ?? b.aggregateLiquidityUsd) -
      (a.aggregateLiquidityEusdc ?? a.aggregateLiquidityUsd);
    return liquidityDelta;
  });
  const candidateReadiness = rows.map((row) => isCandidateReadyForSelection(row));
  const readinessByCandidate = new Map(candidateReadiness.map((row) => [row.candidateId, row]));
  const readyRows = diagnostic.filter((row) => readinessByCandidate.get(row.candidateId)?.ready);
  const readyCandidateRanking = readyRows.map((row) => row.candidateId);
  const readyCandidateIds = rows
    .filter((row) => readinessByCandidate.get(row.candidateId)?.ready)
    .map((row) => row.candidateId);
  const incompleteCandidateIds = rows
    .filter((row) => !readinessByCandidate.get(row.candidateId)?.ready)
    .map((row) => row.candidateId);
  const selectionCandidateIds = readyCandidateIds;
  const selectionBase = {
    diagnosticOrdering: diagnostic.map((row) => row.candidateId),
    readyCandidateRanking,
    historyReady: readyRows.length > 0,
    readyCandidateIds,
    incompleteCandidateIds,
    selectionCandidateIds,
    selectionScope: "READY_CANDIDATES_ONLY" as const,
    candidateReadiness,
  };
  const eligible = readyRows.filter((row) => row.eligibility);

  if (
    readyRows.length === 0 &&
    candidateReadiness.length > 0 &&
    candidateReadiness.every((row) => row.blockers.some(isSourceFailureReadinessBlocker))
  ) {
    return {
      decision: "DATA_SOURCE_FAILURE",
      rankedCandidateIds: [],
      ...selectionBase,
      eligibleCandidateRanking: [],
      historyDecisionReason: "all candidates are blocked by required source failures",
      reason: "all candidates are blocked by required source failures",
    };
  }
  if (readyRows.length === 0) {
    return {
      decision: "INSUFFICIENT_HISTORY",
      rankedCandidateIds: [],
      ...selectionBase,
      eligibleCandidateRanking: [],
      historyDecisionReason: "no candidate has independently ready current signal-window history",
      reason: "no candidate has independently ready current signal-window history",
    };
  }
  if (eligible.length === 0) {
    const readyRejections = readyRows.flatMap((row) => row.rejectionReasons);
    const allTargetEconomic = readyRows.length > 0 &&
      readyRows.every((row) =>
        row.rejectionReasons.some((reason) =>
          /dynamic gross target|dynamic-target reversion|economic/i.test(reason),
        ),
      );
    const allInsufficient = readyRows.every((row) =>
      row.rejectionReasons.some((reason) =>
        /evidence|liquidity|volume|route|declined|rebound|impact/i.test(reason),
      ),
    );
    const decision: RotationScanDecision = allTargetEconomic
      ? "TARGET_ECONOMICALLY_INFEASIBLE"
      : allInsufficient || readyRejections.length > 0
        ? "INSUFFICIENT_EVIDENCE"
        : "HOLD_EUSDC";
    return {
      decision,
      rankedCandidateIds: [],
      ...selectionBase,
      eligibleCandidateRanking: [],
      historyDecisionReason: "ready candidates exist; none satisfied the guarded entry signal",
      reason: "no candidate satisfied the guarded entry signal",
    };
  }
  const topScore = eligible[0]!.score;
  const tied = eligible.filter((row) => row.score === topScore).map((row) => row.candidateId);
  if (tied.length > 1) {
    return {
      decision: "HOLD_EUSDC",
      rankedCandidateIds: [],
      ...selectionBase,
      eligibleCandidateRanking: eligible.map((row) => row.candidateId),
      tiedCandidateIds: tied,
      historyDecisionReason: "ready candidates were evaluated; eligible candidates tied",
      reason: "eligible candidates tied; no registry-order tie-break applied",
    };
  }
  return {
    decision: "CANDIDATE_SELECTED",
    winner: eligible[0]!.candidateId,
    rankedCandidateIds: eligible.map((row) => row.candidateId),
    ...selectionBase,
    eligibleCandidateRanking: eligible.map((row) => row.candidateId),
    historyDecisionReason: "ready candidates were evaluated for selection",
  };
}

async function readNativeBalanceWei(
  config: AppConfig,
  owner: `0x${string}`,
): Promise<string> {
  const balance = await getNativeBalance(config, owner);
  return balance.balanceWei;
}

async function defaultTokenValidation(
  config: AppConfig,
  candidate: RotationCandidateRegistryEntry,
  walletAddress: `0x${string}`,
): Promise<RotationTokenValidation> {
  const rejectionReasons: string[] = [];
  const chainId = await getChainId(config);
  if (chainId !== PULSECHAIN_CHAIN_ID) rejectionReasons.push(`chain ID ${chainId} is not 369`);
  const client = getPublicClient(config);
  const code = await client.getBytecode({ address: candidate.executionTokenAddress });
  const codeExists = typeof code === "string" && code !== "0x";
  if (!codeExists) rejectionReasons.push("contract bytecode missing");
  const metadata = await getErc20Metadata(config, candidate.executionTokenAddress);
  if (!sameAddress(metadata.address, candidate.executionTokenAddress)) {
    rejectionReasons.push("metadata address mismatch");
  }
  if (metadata.symbol.toLowerCase() !== candidate.expectedSymbol.toLowerCase()) {
    rejectionReasons.push(`symbol ${metadata.symbol} does not match ${candidate.expectedSymbol}`);
  }
  const loweredName = metadata.name.toLowerCase();
  if (!candidate.expectedNamePatterns.some((pattern) => loweredName.includes(pattern.toLowerCase()))) {
    rejectionReasons.push(`name ${metadata.name} does not match expected patterns`);
  }
  if (metadata.decimals !== candidate.expectedDecimals) {
    rejectionReasons.push(`decimals ${metadata.decimals} does not match ${candidate.expectedDecimals}`);
  }

  let transferProbeOk = false;
  try {
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [walletAddress, 0n],
    });
    await client.call({
      account: walletAddress,
      to: candidate.executionTokenAddress,
      data,
    });
    transferProbeOk = true;
  } catch {
    rejectionReasons.push("zero-amount transfer probe failed");
  }

  let balanceOfReadable = false;
  try {
    await readErc20Balance(config, candidate.executionTokenAddress, walletAddress);
    balanceOfReadable = true;
  } catch {
    rejectionReasons.push("balanceOf read failed");
  }

  let allowanceReadable = false;
  try {
    await readErc20Allowance(config, candidate.executionTokenAddress, walletAddress, ROUTER);
    allowanceReadable = true;
  } catch {
    rejectionReasons.push("allowance read failed");
  }

  // Route connectivity is evaluated once in the market evidence pass. Keeping
  // token identity validation metadata-only avoids duplicate live subgraph work
  // and keeps routine scans read-only and bounded.
  const routeToBaseAvailable = true;
  const routeFromBaseAvailable = true;

  return {
    chainId,
    codeExists,
    symbol: metadata.symbol,
    name: metadata.name,
    decimals: metadata.decimals,
    transferProbeOk,
    balanceOfReadable,
    allowanceReadable,
    routeToBaseAvailable,
    routeFromBaseAvailable,
    ok: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

function uniqueLower(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()).filter(Boolean))];
}

function pairLiquidityUsd(pair: SubgraphPair): number {
  const raw = Math.max(0, num(pair.reserveUSD));
  return raw > 1_000_000_000_000 ? 0 : raw;
}

function estimatedImpactPercent(balanceRaw: string, liquidityUsd: number): number | null {
  if (liquidityUsd <= 0) return null;
  const balanceUsd = Number(formatUnits(BigInt(balanceRaw), 6));
  if (!Number.isFinite(balanceUsd) || balanceUsd <= 0) return null;
  return (balanceUsd / liquidityUsd) * 100;
}

function swapsVolume(swaps: SubgraphSwap[]): number {
  return swaps.reduce((sum, swap) => sum + num(swap.amountUSD), 0);
}

function historyRuntimeDeadlineReached(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() + HISTORY_RUNTIME_GUARD_MS >= deadlineMs;
}

function remainingHistoryRuntimeMs(deadlineMs: number | undefined): number | null {
  if (deadlineMs === undefined) return null;
  return Math.max(0, deadlineMs - Date.now() - HISTORY_RUNTIME_GUARD_MS);
}

function historyRuntimeDeadlineError(): Error {
  return new Error("HISTORY_RUNTIME_DEADLINE_REACHED");
}

function isHistoryRuntimeDeadlineError(err: unknown): boolean {
  return err instanceof Error && err.message === "HISTORY_RUNTIME_DEADLINE_REACHED";
}

function boundedHistoryRequestConfig(config: AppConfig, deadlineMs: number | undefined): AppConfig {
  const remaining = remainingHistoryRuntimeMs(deadlineMs);
  const boundedTimeout =
    remaining === null
      ? Math.min(config.httpTimeoutMs, HISTORY_SOURCE_REQUEST_TIMEOUT_MS)
      : Math.max(
        HISTORY_MIN_REQUEST_TIMEOUT_MS,
        Math.min(config.httpTimeoutMs, HISTORY_SOURCE_REQUEST_TIMEOUT_MS, remaining),
      );
  return { ...config, httpTimeoutMs: boundedTimeout };
}

async function fetchPairsForCandidate(
  config: AppConfig,
  candidate: RotationCandidateRegistryEntry,
): Promise<{ pairs: SubgraphPair[]; errors: string[] }> {
  const sourced = await fetchSourcePoolsForCandidate(config, candidate);
  const byId = new Map<string, SubgraphPair>();
  for (const ref of sourced.pools) {
    if (!byId.has(ref.pair.id.toLowerCase())) byId.set(ref.pair.id.toLowerCase(), ref.pair);
  }
  return { pairs: [...byId.values()], errors: sourced.errors };
}

function sourceVersionForSubgraph(version: "v1" | "v2"): RotationHistorySourceVersion {
  return version === "v1" ? "PULSEX_V1" : "PULSEX_V2";
}

function subgraphEndpointForVersion(config: AppConfig, version: "v1" | "v2"): string {
  return version === "v1" ? config.pulseXSubgraphV1 : config.pulseXSubgraphV2;
}

function protocolForSourceVersion(sourceVersion: RotationHistorySourceVersion): string {
  if (sourceVersion === "PULSEX_V1") return "PulseX V1";
  if (sourceVersion === "PULSEX_V2") return "PulseX V2";
  if (sourceVersion === "VERIFIED_V3") return "Verified V3";
  if (sourceVersion === "VERIFIED_STABLE") return "Verified stable";
  return "Unknown";
}

function pairSupportsCandidatePrice(
  candidate: RotationCandidateRegistryEntry,
  pair: SubgraphPair,
): boolean {
  const candidateToken = candidate.executionTokenAddress.toLowerCase();
  return (
    pairMatches(pair, candidateToken, EUSDC_ADDRESS) ||
    pairMatches(pair, candidateToken, WPLS_ADDRESS) ||
    (candidate.candidateId === "PLS" && pairMatches(pair, WPLS_ADDRESS, EUSDC_ADDRESS))
  );
}

function classifySourcePool(input: {
  candidate: RotationCandidateRegistryEntry;
  pair: SubgraphPair;
  priceMap: Map<string, number>;
}): {
  classification: RotationHistoryPoolClassification;
  contributesToConsolidatedPrice: boolean;
  liquidityEusdc: number;
  recentVolumeEusdc: number;
  exclusionReason?: string;
} {
  const liquidityEusdc = calculatePairLiquidityEusdc(input.pair, input.priceMap);
  const recentVolumeEusdc = Math.max(0, num(input.pair.volumeUSD));
  if (!pairSupportsCandidatePrice(input.candidate, input.pair)) {
    return {
      classification: "OPTIONAL_DIAGNOSTIC_POOL",
      contributesToConsolidatedPrice: false,
      liquidityEusdc,
      recentVolumeEusdc,
      exclusionReason: "pool is route diagnostic but not a candidate/eUSDC or candidate/WPLS price source",
    };
  }
  if (liquidityEusdc <= 0) {
    return {
      classification: "EXCLUDED_POOL",
      contributesToConsolidatedPrice: false,
      liquidityEusdc,
      recentVolumeEusdc,
      exclusionReason: "non-positive eUSDC-priced liquidity",
    };
  }
  if (liquidityEusdc < REQUIRED_POOL_MIN_LIQUIDITY_EUSDC) {
    return {
      classification: "OPTIONAL_DIAGNOSTIC_POOL",
      contributesToConsolidatedPrice: false,
      liquidityEusdc,
      recentVolumeEusdc,
      exclusionReason: "below required price-pool liquidity floor",
    };
  }
  if (recentVolumeEusdc < REQUIRED_POOL_MIN_RECENT_VOLUME_EUSDC) {
    return {
      classification: "OPTIONAL_DIAGNOSTIC_POOL",
      contributesToConsolidatedPrice: false,
      liquidityEusdc,
      recentVolumeEusdc,
      exclusionReason: "below required price-pool recent-volume floor",
    };
  }
  return {
    classification: "REQUIRED_PRICE_POOL",
    contributesToConsolidatedPrice: true,
    liquidityEusdc,
    recentVolumeEusdc,
  };
}

export function dedupeSourcePools(
  refs: RotationHistorySourcePoolRef[],
): { pools: RotationHistorySourcePoolRef[]; sourceDisagreements: string[] } {
  const byKey = new Map<string, RotationHistorySourcePoolRef>();
  const sourceDisagreements: string[] = [];
  for (const ref of refs) {
    const key = `${ref.sourceVersion}:${ref.pair.id.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, ref);
      continue;
    }
    if (
      existing.subgraphEndpoint !== ref.subgraphEndpoint ||
      existing.eventAdapter !== ref.eventAdapter ||
      existing.protocol !== ref.protocol
    ) {
      sourceDisagreements.push(
        `${ref.pair.id.toLowerCase()}: conflicting ${existing.sourceVersion} source metadata`,
      );
    }
    if (pairLiquidityUsd(ref.pair) > pairLiquidityUsd(existing.pair)) byKey.set(key, ref);
  }
  const byPool = new Map<string, RotationHistorySourcePoolRef[]>();
  for (const ref of byKey.values()) {
    const key = ref.pair.id.toLowerCase();
    const rows = byPool.get(key) ?? [];
    rows.push(ref);
    byPool.set(key, rows);
  }
  for (const [pool, rows] of byPool) {
    if (rows.length > 1) {
      sourceDisagreements.push(
        `${pool}: present in multiple source versions (${rows.map((row) => row.sourceVersion).join(", ")})`,
      );
    }
  }
  return { pools: [...byKey.values()], sourceDisagreements };
}

export function swapQueryPlanForSourcePool(ref: RotationHistorySourcePoolRef): {
  pair: string;
  version: "v1" | "v2" | undefined;
  endpoint: string;
  sourceVersion: RotationHistorySourceVersion;
  eventAdapter: RotationHistoryEventAdapter;
} {
  return {
    pair: ref.pair.id.toLowerCase(),
    version: ref.subgraphVersion,
    endpoint: ref.subgraphEndpoint,
    sourceVersion: ref.sourceVersion,
    eventAdapter: ref.eventAdapter,
  };
}

async function fetchSourcePoolsForCandidate(
  config: AppConfig,
  candidate: RotationCandidateRegistryEntry,
  deadlineMs?: number,
): Promise<{ pools: RotationHistorySourcePoolRef[]; errors: string[]; partial: boolean }> {
  const errors: string[] = [];
  let partial = false;
  const discovered: Array<{
    pair: SubgraphPair;
    protocol: string;
    sourceVersion: RotationHistorySourceVersion;
    subgraphVersion: "v1" | "v2";
    subgraphEndpoint: string;
    eventAdapter: RotationHistoryEventAdapter;
    factoryAddress: `0x${string}` | null;
  }> = [];
  const tokens = [candidate.executionTokenAddress, WPLS_ADDRESS, EUSDC_ADDRESS];
  for (const version of ["v1", "v2"] as const) {
    for (const token of tokens) {
      if (historyRuntimeDeadlineReached(deadlineMs)) {
        partial = true;
        errors.push(`${version} pairs ${token}: HISTORY_RUNTIME_DEADLINE_REACHED`);
        break;
      }
      try {
        const pairs = await fetchPairsForToken(boundedHistoryRequestConfig(config, deadlineMs), token, 20, version);
        const sourceVersion = sourceVersionForSubgraph(version);
        const endpoint = subgraphEndpointForVersion(config, version);
        for (const pair of pairs) {
          discovered.push({
            pair,
            protocol: protocolForSourceVersion(sourceVersion),
            sourceVersion,
            subgraphVersion: version,
            subgraphEndpoint: endpoint,
            eventAdapter: "PULSEX_V2_STYLE_SWAP",
            factoryAddress: null,
          });
        }
      } catch (err) {
        errors.push(`${version} pairs ${token}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (partial) break;
  }
  const allPairs = discovered.map((row) => row.pair);
  const anchor = findAnchorWplsEusdcPair(allPairs);
  const wplsPrice = deriveWplsEusdcPrice(anchor);
  const priceMap = new Map<string, number>([
    [EUSDC_ADDRESS.toLowerCase(), 1],
    ...(wplsPrice ? ([[WPLS_ADDRESS.toLowerCase(), wplsPrice]] as Array<[string, number]>) : []),
  ]);
  for (const pair of allPairs) {
    const p0 = pairPriceEusdc(pair, tokenId(pair.token0), priceMap);
    if (p0 && !priceMap.has(tokenId(pair.token0))) priceMap.set(tokenId(pair.token0), p0);
    const p1 = pairPriceEusdc(pair, tokenId(pair.token1), priceMap);
    if (p1 && !priceMap.has(tokenId(pair.token1))) priceMap.set(tokenId(pair.token1), p1);
  }
  const refs = discovered.map((row) => ({
    ...row,
    ...classifySourcePool({ candidate, pair: row.pair, priceMap }),
  }));
  const deduped = dedupeSourcePools(refs);
  errors.push(...deduped.sourceDisagreements.map((msg) => `source disagreement: ${msg}`));
  return { pools: deduped.pools, errors, partial };
}

function selectedSwapPairIds(
  candidate: RotationCandidateRegistryEntry,
  pairs: SubgraphPair[],
): string[] {
  const candidateToken = candidate.executionTokenAddress.toLowerCase();
  const relevant = pairs.filter(
    (pair) =>
      pairMatches(pair, candidateToken, EUSDC_ADDRESS) ||
      pairMatches(pair, candidateToken, WPLS_ADDRESS) ||
      pairMatches(pair, WPLS_ADDRESS, EUSDC_ADDRESS),
  );
  return relevant
    .sort((a, b) => pairLiquidityUsd(b) - pairLiquidityUsd(a))
    .slice(0, 4)
    .map((pair) => pair.id.toLowerCase());
}

function selectedSourcePools(
  candidate: RotationCandidateRegistryEntry,
  refs: RotationHistorySourcePoolRef[],
): RotationHistorySourcePoolRef[] {
  const candidateToken = candidate.executionTokenAddress.toLowerCase();
  const relevant = refs.filter((ref) =>
    pairMatches(ref.pair, candidateToken, EUSDC_ADDRESS) ||
    pairMatches(ref.pair, candidateToken, WPLS_ADDRESS) ||
    pairMatches(ref.pair, WPLS_ADDRESS, EUSDC_ADDRESS),
  );
  const required = relevant
    .filter((ref) => ref.classification === "REQUIRED_PRICE_POOL")
    .sort((a, b) => b.liquidityEusdc - a.liquidityEusdc);
  const optional = relevant
    .filter((ref) => ref.classification !== "REQUIRED_PRICE_POOL")
    .sort((a, b) => b.liquidityEusdc - a.liquidityEusdc);
  return [...required, ...optional].slice(0, 6);
}

function recentPoolPriority(candidate: RotationCandidateRegistryEntry, ref: RotationHistorySourcePoolRef): number {
  const candidateToken = candidate.executionTokenAddress.toLowerCase();
  if (pairMatches(ref.pair, WPLS_ADDRESS, EUSDC_ADDRESS)) return 0;
  if (pairMatches(ref.pair, candidateToken, EUSDC_ADDRESS)) return 1;
  if (pairMatches(ref.pair, candidateToken, WPLS_ADDRESS)) return 2;
  if (ref.classification === "REQUIRED_PRICE_POOL") return 3;
  if (ref.classification === "OPTIONAL_DIAGNOSTIC_POOL") return 4;
  return 5;
}

export function prioritizeRecentSignalPools(
  candidate: RotationCandidateRegistryEntry,
  refs: RotationHistorySourcePoolRef[],
): RotationHistorySourcePoolRef[] {
  return selectedSourcePools(candidate, refs)
    .sort((a, b) => {
      const priority = recentPoolPriority(candidate, a) - recentPoolPriority(candidate, b);
      if (priority !== 0) return priority;
      const required = Number(b.classification === "REQUIRED_PRICE_POOL") -
        Number(a.classification === "REQUIRED_PRICE_POOL");
      if (required !== 0) return required;
      return b.liquidityEusdc - a.liquidityEusdc;
    });
}

export type RotationRecentPoolRole =
  | "WPLS_EUSDC_ANCHOR"
  | "DIRECT_CANDIDATE_EUSDC"
  | "CANDIDATE_WPLS"
  | "OPTIONAL_DIAGNOSTIC";

export interface RotationRecentPoolTask {
  candidateId: RotationCandidateId;
  poolAddress: `0x${string}`;
  sourceVersion: RotationHistorySourceVersion;
  role: RotationRecentPoolRole;
  sourcePool: RotationHistorySourcePoolRef;
}

function recentPoolRole(
  candidate: RotationCandidateRegistryEntry,
  ref: RotationHistorySourcePoolRef,
): RotationRecentPoolRole {
  const candidateToken = candidate.executionTokenAddress.toLowerCase();
  if (pairMatches(ref.pair, WPLS_ADDRESS, EUSDC_ADDRESS)) return "WPLS_EUSDC_ANCHOR";
  if (pairMatches(ref.pair, candidateToken, EUSDC_ADDRESS)) return "DIRECT_CANDIDATE_EUSDC";
  if (pairMatches(ref.pair, candidateToken, WPLS_ADDRESS)) return "CANDIDATE_WPLS";
  return "OPTIONAL_DIAGNOSTIC";
}

function recentPoolRolePriority(role: RotationRecentPoolRole): number {
  switch (role) {
    case "WPLS_EUSDC_ANCHOR":
      return 0;
    case "DIRECT_CANDIDATE_EUSDC":
      return 1;
    case "CANDIDATE_WPLS":
      return 2;
    case "OPTIONAL_DIAGNOSTIC":
      return 3;
  }
}

export function buildRecentSignalPoolTasks(input: {
  candidates: RotationCandidateRegistryEntry[];
  poolsByCandidate: Map<RotationCandidateId, RotationHistorySourcePoolRef[]>;
}): RotationRecentPoolTask[] {
  const candidateOrder = new Map(input.candidates.map((candidate, index) => [candidate.candidateId, index]));
  const tasks: RotationRecentPoolTask[] = [];
  for (const candidate of input.candidates) {
    for (const sourcePool of prioritizeRecentSignalPools(
      candidate,
      input.poolsByCandidate.get(candidate.candidateId) ?? [],
    )) {
      tasks.push({
        candidateId: candidate.candidateId,
        poolAddress: sourcePool.pair.id.toLowerCase() as `0x${string}`,
        sourceVersion: sourcePool.sourceVersion,
        role: recentPoolRole(candidate, sourcePool),
        sourcePool,
      });
    }
  }
  return tasks.sort((a, b) => {
    const role = recentPoolRolePriority(a.role) - recentPoolRolePriority(b.role);
    if (role !== 0) return role;
    const required = Number(b.sourcePool.classification === "REQUIRED_PRICE_POOL") -
      Number(a.sourcePool.classification === "REQUIRED_PRICE_POOL");
    if (required !== 0) return required;
    const candidate = (candidateOrder.get(a.candidateId) ?? 0) - (candidateOrder.get(b.candidateId) ?? 0);
    if (candidate !== 0) return candidate;
    return b.sourcePool.liquidityEusdc - a.sourcePool.liquidityEusdc;
  });
}

export function rotationCheckpointProgressFingerprint(input: {
  syncPurpose: RotationHistorySyncPurpose;
  phase: RotationRecentRefreshPhase;
  candidateId?: RotationCandidateId;
  poolAddress?: `0x${string}`;
  nextBlock?: string | null;
  completedBlockRanges: Array<{
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    fromBlock: string;
    toBlock: string;
  }>;
  anchorTipComplete?: boolean;
}): `0x${string}` {
  return fingerprint({
    syncPurpose: input.syncPurpose,
    phase: input.phase,
    candidateId: input.candidateId ?? null,
    poolAddress: input.poolAddress?.toLowerCase() ?? null,
    nextBlock: input.nextBlock ?? null,
    anchorTipComplete: input.anchorTipComplete ?? false,
    completedBlockRanges: input.completedBlockRanges.map((range) => ({
      c: range.candidateId,
      p: range.poolAddress.toLowerCase(),
      f: range.fromBlock,
      t: range.toBlock,
    })),
  });
}

export function completedRangeFromReport(input: {
  candidateId: RotationCandidateId;
  report: Pick<
    RotationHistoryPoolSyncStatus,
    | "poolAddress"
    | "sourceVersion"
    | "eventAdapter"
    | "scannedFromBlock"
    | "scannedToBlock"
    | "totalRecordsRetrieved"
    | "deduplicatedRecords"
    | "sourceEndpoint"
    | "completedRangeScanned"
  > & { duplicateRecordsIgnored?: number };
  completedAt: string;
}): RotationHistorySyncCheckpoint["completedBlockRanges"][number] | null {
  if (!input.report.scannedFromBlock || !input.report.scannedToBlock || input.report.completedRangeScanned === false) {
    return null;
  }
  return {
    candidateId: input.candidateId,
    poolAddress: input.report.poolAddress,
    sourceVersion: input.report.sourceVersion ?? "UNKNOWN",
    fromBlock: input.report.scannedFromBlock,
    toBlock: input.report.scannedToBlock,
    resultCount: input.report.totalRecordsRetrieved,
    validRecordCount: input.report.deduplicatedRecords,
    duplicateCount: input.report.duplicateRecordsIgnored ?? 0,
    completedAt: input.completedAt,
    source: input.report.sourceEndpoint,
    adapter: input.report.eventAdapter,
    success: true,
  };
}

export function completedBlockCoveragePercent(input: {
  completedRanges: Array<{
    candidateId: RotationCandidateId;
    poolAddress: `0x${string}`;
    sourceVersion: RotationHistorySourceVersion;
    fromBlock: string;
    toBlock: string;
    success?: boolean;
  }>;
  candidateId: RotationCandidateId;
  poolAddress: `0x${string}`;
  sourceVersion: RotationHistorySourceVersion;
  fromBlock: bigint;
  toBlock: bigint;
}): number {
  if (input.toBlock < input.fromBlock) return 100;
  const ranges = input.completedRanges
    .filter((range) =>
      range.success !== false &&
      range.candidateId === input.candidateId &&
      sameAddress(range.poolAddress, input.poolAddress) &&
      range.sourceVersion === input.sourceVersion,
    )
    .map((range) => ({
      from: BigInt(range.fromBlock) < input.fromBlock ? input.fromBlock : BigInt(range.fromBlock),
      to: BigInt(range.toBlock) > input.toBlock ? input.toBlock : BigInt(range.toBlock),
    }))
    .filter((range) => range.from <= range.to)
    .sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  let covered = 0n;
  let active: { from: bigint; to: bigint } | null = null;
  for (const range of ranges) {
    if (!active) {
      active = { ...range };
      continue;
    }
    if (range.from <= active.to + 1n) {
      if (range.to > active.to) active.to = range.to;
      continue;
    }
    covered += active.to - active.from + 1n;
    active = { ...range };
  }
  if (active) covered += active.to - active.from + 1n;
  const total = input.toBlock - input.fromBlock + 1n;
  return round(Number(covered) / Number(total) * 100, 4);
}

export function appendCompletedRecentRange(input: {
  checkpoint: RotationHistorySyncCheckpoint;
  completedRange: RotationHistorySyncCheckpoint["completedBlockRanges"][number];
  phase: RotationRecentRefreshPhase;
  nextBlock?: string | null;
  taskIndex: number;
  anchorTipComplete: boolean;
  updatedAt: string;
}): { checkpoint: RotationHistorySyncCheckpoint; progressFingerprint: `0x${string}`; advanced: boolean } {
  const rangeKey = (range: RotationHistorySyncCheckpoint["completedBlockRanges"][number]) =>
    `${range.candidateId}:${range.poolAddress.toLowerCase()}:${range.sourceVersion}:${range.fromBlock}:${range.toBlock}`;
  const before = new Set(input.checkpoint.completedBlockRanges.map(rangeKey));
  const completedBlockRanges = before.has(rangeKey(input.completedRange))
    ? input.checkpoint.completedBlockRanges
    : [...input.checkpoint.completedBlockRanges, input.completedRange];
  const progressFingerprint = rotationCheckpointProgressFingerprint({
    syncPurpose: input.checkpoint.syncPurpose ?? "HISTORICAL_BACKFILL",
    phase: input.phase,
    candidateId: input.completedRange.candidateId,
    poolAddress: input.completedRange.poolAddress,
    nextBlock: input.nextBlock ?? null,
    completedBlockRanges,
    anchorTipComplete: input.anchorTipComplete,
  });
  return {
    checkpoint: {
      ...input.checkpoint,
      phase: input.phase,
      candidateId: input.completedRange.candidateId,
      poolAddress: input.completedRange.poolAddress,
      nextBlock: input.nextBlock ?? undefined,
      completedBlockRanges,
      sourceCursor: {
        candidateIndex: input.taskIndex,
        poolIndex: 0,
        taskIndex: input.taskIndex,
      },
      lastSuccessfullyScannedRange: {
        candidateId: input.completedRange.candidateId,
        poolAddress: input.completedRange.poolAddress,
        fromBlock: input.completedRange.fromBlock,
        toBlock: input.completedRange.toBlock,
      },
      previousProgressFingerprint: input.checkpoint.progressFingerprint,
      progressFingerprint,
      updatedAt: input.updatedAt,
    },
    progressFingerprint,
    advanced: progressFingerprint !== input.checkpoint.progressFingerprint,
  };
}

export function checkpointWouldStall(input: {
  previousProgressFingerprint?: `0x${string}` | null;
  nextProgressFingerprint?: `0x${string}` | null;
  code: RotationHistorySyncCode;
}): boolean {
  return input.code === "PARTIAL_PROGRESS" &&
    input.previousProgressFingerprint !== undefined &&
    input.previousProgressFingerprint !== null &&
    input.nextProgressFingerprint !== undefined &&
    input.nextProgressFingerprint !== null &&
    input.previousProgressFingerprint === input.nextProgressFingerprint;
}

export function checkpointWindowMatches(input: {
  checkpoint: RotationHistorySyncCheckpoint;
  syncPurpose: RotationHistorySyncPurpose;
  requestedStartTime: string;
  requestedEndTime: string;
  lookbackMinutes: number;
  candidateIds?: RotationCandidateId[];
  storePath: string;
  chainId: number;
}): boolean {
  if ((input.checkpoint.syncPurpose ?? "HISTORICAL_BACKFILL") !== input.syncPurpose) return false;
  if (input.checkpoint.requestedWindow.startTime !== input.requestedStartTime) return false;
  if (input.checkpoint.requestedWindow.endTime !== input.requestedEndTime) return false;
  if (input.checkpoint.requestedWindow.lookbackMinutes !== input.lookbackMinutes) return false;
  if (input.checkpoint.storePath && !pathEquals(input.checkpoint.storePath, input.storePath)) return false;
  if (input.checkpoint.chainId !== undefined && input.checkpoint.chainId !== input.chainId) return false;
  if (input.candidateIds && input.checkpoint.candidateIds) {
    const expected = [...input.candidateIds].sort().join(",");
    const actual = [...input.checkpoint.candidateIds].sort().join(",");
    if (expected !== actual) return false;
  }
  return true;
}

export function classifyTipFreshness(input: {
  tipScanned: boolean;
  recentTradesFound: boolean;
  sourceError?: boolean;
  anchorComplete?: boolean;
  requiredPoolComplete?: boolean;
}): RotationTipFreshnessStatus {
  if (!input.tipScanned) return "PIPELINE_STALE";
  if (input.anchorComplete === false) return "ANCHOR_TIP_INCOMPLETE";
  if (input.requiredPoolComplete === false) return "REQUIRED_POOL_TIP_INCOMPLETE";
  if (input.sourceError) return "REQUIRED_POOL_TIP_INCOMPLETE";
  return input.recentTradesFound ? "TIP_SCANNED_RECENT_TRADES_FOUND" : "MARKET_QUIET";
}

async function verifyPoolBytecode(
  config: AppConfig,
  pairIds: string[],
): Promise<Map<string, boolean>> {
  const client = getPublicClient(config);
  const rows = await Promise.allSettled(
    pairIds.map(async (id) => {
      const code = await client.getBytecode({ address: id as `0x${string}` });
      return [id.toLowerCase(), typeof code === "string" && code !== "0x"] as const;
    }),
  );
  const out = new Map<string, boolean>();
  for (const row of rows) {
    if (row.status === "fulfilled") out.set(row.value[0], row.value[1]);
  }
  return out;
}

async function fetchPairSwapsPaginated(input: {
  config: AppConfig;
  candidateId?: RotationCandidateId;
  pairIds?: string[];
  sourcePools?: RotationHistorySourcePoolRef[];
  startTimestamp: number;
  endTimestamp?: number;
  maxPagesPerPair?: number;
  pageSize?: number;
  deadlineMs?: number;
}): Promise<{
  swaps: SubgraphSwap[];
  poolSwaps: Array<{
    pairId: string;
    sourcePool?: RotationHistorySourcePoolRef;
    swaps: SubgraphSwap[];
  }>;
  pageCount: number;
  truncated: boolean;
  errors: string[];
  pairsUsed: string[];
  poolReports: RotationHistoryPoolSyncStatus[];
}> {
  const errors: string[] = [];
  const maxPages = input.maxPagesPerPair ?? 8;
  const pageSize = Math.min(input.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE, 100);
  const endTimestamp = input.endTimestamp ?? Math.floor(Date.now() / 1000);
  const byId = new Map<string, SubgraphSwap>();
  let pageCount = 0;
  let truncated = false;
  type NormalizedPoolInput = {
    pairId: string;
    sourceVersion: RotationHistorySourceVersion;
    subgraphVersion: "v1" | "v2";
    sourceEndpoint: string;
    protocol: string;
    eventAdapter: RotationHistoryEventAdapter;
    factoryAddress: `0x${string}` | null;
    classification: RotationHistoryPoolClassification;
    contributesToConsolidatedPrice: boolean;
    liquidityEusdc: number;
    recentVolumeEusdc: number;
    exclusionReason?: string;
    pair?: SubgraphPair;
  };
  const poolInputs: NormalizedPoolInput[] = input.sourcePools
    ? input.sourcePools.map((row) => ({
      pairId: row.pair.id.toLowerCase(),
      sourceVersion: row.sourceVersion,
      subgraphVersion: row.subgraphVersion ?? "v2",
      sourceEndpoint: row.subgraphEndpoint,
      protocol: row.protocol,
      eventAdapter: row.eventAdapter,
      factoryAddress: row.factoryAddress,
      classification: row.classification,
      contributesToConsolidatedPrice: row.contributesToConsolidatedPrice,
      liquidityEusdc: row.liquidityEusdc,
      recentVolumeEusdc: row.recentVolumeEusdc,
      exclusionReason: row.exclusionReason,
      pair: row.pair,
    }))
    : (input.pairIds ?? []).map((pairId) => ({
    pairId: pairId.toLowerCase(),
    sourceVersion: "PULSEX_V2" as RotationHistorySourceVersion,
    subgraphVersion: "v2" as const,
    sourceEndpoint: input.config.pulseXSubgraphV2,
    protocol: "PulseX V2",
    eventAdapter: "PULSEX_V2_STYLE_SWAP" as RotationHistoryEventAdapter,
    factoryAddress: null,
    classification: "REQUIRED_PRICE_POOL" as RotationHistoryPoolClassification,
    contributesToConsolidatedPrice: true,
    liquidityEusdc: 0,
    recentVolumeEusdc: 0,
    exclusionReason: undefined as string | undefined,
    pair: undefined as SubgraphPair | undefined,
  }));
  const tasks = poolInputs.map(async (poolInput) => {
    const pairId = poolInput.pairId;
    const started = Date.now();
    const local: SubgraphSwap[] = [];
    let localPages = 0;
    let localTruncated = false;
    let repeatedCursor = false;
    let stoppedForDeadline = false;
    let previousFirstId: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      if (historyRuntimeDeadlineReached(input.deadlineMs)) {
        stoppedForDeadline = true;
        localTruncated = true;
        break;
      }
      const result = await fetchSwapsAdvanced(boundedHistoryRequestConfig(input.config, input.deadlineMs), {
        pair: pairId,
        first: pageSize,
        skip: page * pageSize,
        version: poolInput.subgraphVersion,
      });
      localPages += 1;
      const swaps = result.swaps ?? [];
      const firstId = swaps[0]?.id;
      if (firstId && previousFirstId === firstId && page > 0) {
        repeatedCursor = true;
        localTruncated = true;
        break;
      }
      previousFirstId = firstId;
      local.push(...swaps);
      const oldest = swaps.reduce(
        (min, swap) => Math.min(min, Number(swap.timestamp) || Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      );
      if (swaps.length < pageSize || oldest <= input.startTimestamp) break;
      if (page === maxPages - 1) localTruncated = true;
    }
    const unique = new Map<string, SubgraphSwap>();
    for (const swap of local) unique.set(`${swap.transaction?.id ?? ""}:${swap.id}`, swap);
    const timestamps = [...unique.values()]
      .map((swap) => Number(swap.timestamp))
      .filter((ts) => Number.isFinite(ts) && ts > 0);
    const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const newest = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const boundaryCrossed = oldest !== null && oldest <= input.startTimestamp;
    let truncationReason: RotationHistoryPoolSyncStatus["truncationReason"] = "NONE";
    if (stoppedForDeadline) truncationReason = "PARTIAL_PROGRESS";
    else if (repeatedCursor) truncationReason = "PAGINATION_BUG_OR_REPEATED_CURSOR";
    else if (localTruncated && !boundaryCrossed) truncationReason = "SOURCE_ROW_LIMIT";
    else if (local.length === 0) truncationReason = "SPARSE_ACTUAL_TRADING";
    else if (newest !== null && newest < endTimestamp - FRESH_TRADE_MAX_AGE_MINUTES * 60) {
      truncationReason = "STALE_POOL";
    }
    const report: RotationHistoryPoolSyncStatus = {
      candidateId: input.candidateId ?? "PLS",
      poolAddress: pairId.toLowerCase() as `0x${string}`,
      token0: poolInput.pair ? pairTokenAddress(poolInput.pair, 0) : undefined,
      token1: poolInput.pair ? pairTokenAddress(poolInput.pair, 1) : undefined,
      token0Decimals: poolInput.pair ? pairTokenDecimals(poolInput.pair, poolInput.pair.token0.id, 18) : undefined,
      token1Decimals: poolInput.pair ? pairTokenDecimals(poolInput.pair, poolInput.pair.token1.id, 18) : undefined,
      factoryAddress: poolInput.factoryAddress,
      protocol: poolInput.protocol,
      sourceVersion: poolInput.sourceVersion,
      eventAdapter: poolInput.eventAdapter,
      sourceEndpoint: poolInput.sourceEndpoint,
      queryType: `${poolInput.protocol} swaps(pair, first, skip)`,
      pageSize,
      maximumPageCount: maxPages,
      cursorMechanism: "skip",
      oldestReturnedRecord: isoFromSeconds(oldest),
      newestReturnedRecord: isoFromSeconds(newest),
      requestedStartTime: isoFromSeconds(input.startTimestamp) ?? new Date(input.startTimestamp * 1000).toISOString(),
      requestedEndTime: isoFromSeconds(endTimestamp) ?? new Date(endTimestamp * 1000).toISOString(),
      totalRecordsRetrieved: local.length,
      deduplicatedRecords: unique.size,
      boundaryCrossed,
      truncationReason,
      contributesToConsolidatedPrice: poolInput.contributesToConsolidatedPrice,
      classification: poolInput.classification,
      liquidityEusdc: round(poolInput.liquidityEusdc, 6),
      recentVolumeEusdc: round(poolInput.recentVolumeEusdc, 6),
      exclusionReason: poolInput.exclusionReason,
      exactRemainingTruncationCause: truncationReason === "NONE" ? undefined : truncationReason,
      retrievalCompletenessPercent:
        !stoppedForDeadline &&
          (boundaryCrossed || truncationReason === "SPARSE_ACTUAL_TRADING" || truncationReason === "STALE_POOL")
          ? 100
          : 0,
      signalWindowCompletenessPercent: newest !== null && newest >= endTimestamp - 24 * 60 * 60 ? 100 : 0,
      rpcRecordsRetrieved: 0,
      anchorRecordsUsed: 0,
      unsupportedLogs: 0,
      errors: [],
      nextResumeBlock: null,
      elapsedMs: Date.now() - started,
      sourceRepeatsOrCapsRecords: repeatedCursor || (localTruncated && !boundaryCrossed && !stoppedForDeadline),
      historicalPaginationReliable: !stoppedForDeadline && (boundaryCrossed || local.length < pageSize) && !repeatedCursor,
      fallbackUsed: "NONE",
    };
    return {
      pairId,
      sourcePool: input.sourcePools?.find((ref) =>
        ref.pair.id.toLowerCase() === pairId &&
        ref.sourceVersion === poolInput.sourceVersion
      ),
      swaps: [...unique.values()],
      pageCount: localPages,
      truncated: localTruncated,
      report,
    };
  });
  const settled = await Promise.allSettled(tasks);
  const poolReports: RotationHistoryPoolSyncStatus[] = [];
  const poolSwaps: Array<{
    pairId: string;
    sourcePool?: RotationHistorySourcePoolRef;
    swaps: SubgraphSwap[];
  }> = [];
  for (const row of settled) {
    if (row.status === "rejected") {
      errors.push(row.reason instanceof Error ? row.reason.message : String(row.reason));
      continue;
    }
    pageCount += row.value.pageCount;
    truncated = truncated || row.value.truncated;
    poolReports.push(row.value.report);
    poolSwaps.push({
      pairId: row.value.pairId,
      sourcePool: row.value.sourcePool,
      swaps: row.value.swaps,
    });
    for (const swap of row.value.swaps) {
      const key = `${swap.transaction?.id ?? ""}:${swap.id}`;
      byId.set(key, swap);
    }
  }
  return {
    swaps: [...byId.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)),
    poolSwaps,
    pageCount,
    truncated,
    errors,
    pairsUsed: poolInputs.map((row) => row.pairId),
    poolReports,
  };
}

function buildAnchorObservations(swaps: SubgraphSwap[]): RotationPriceObservation[] {
  return swaps
    .filter((swap) => swapPairMatches(swap, WPLS_ADDRESS, EUSDC_ADDRESS))
    .map((swap) =>
      priceObservationFromSwap({
        swap,
        candidate: getRotationCandidate("PLS"),
      }),
    )
    .filter((row): row is RotationPriceObservation => row !== null);
}

function observationsForCandidate(
  candidate: RotationCandidateRegistryEntry,
  swaps: SubgraphSwap[],
  anchorObservations: RotationPriceObservation[],
): RotationPriceObservation[] {
  const byId = new Map<string, RotationPriceObservation>();
  for (const swap of swaps) {
    const obs = priceObservationFromSwap({
      swap,
      candidate,
      anchorObservations,
      maxAnchorAgeSeconds: 15 * 60,
    });
    if (obs) byId.set(obs.swapId, obs);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function reduceLogChunkAfterRangeError(currentBlocks: number): number {
  return Math.max(100, Math.floor(currentBlocks / 2));
}

type HistoryPublicClient = {
  getBlockNumber: () => Promise<bigint>;
  getBlock: (args: { blockNumber: bigint }) => Promise<{
    timestamp: bigint | number;
    hash?: `0x${string}` | string | null;
  }>;
  getLogs: (args: {
    address: `0x${string}`;
    event: typeof v2SwapEventAbi;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<Array<{
    blockNumber?: bigint;
    blockHash?: `0x${string}` | string | null;
    transactionHash?: `0x${string}` | string;
    logIndex?: bigint | number;
    data: `0x${string}`;
    topics: readonly `0x${string}`[];
  }>>;
};

export interface TimestampBlockRangeResolution {
  requestedStartTimestamp: number;
  requestedEndTimestamp: number;
  resolvedStartBlock: bigint;
  resolvedEndBlock: bigint;
  resolvedStartBlockTimestamp: number;
  resolvedEndBlockTimestamp: number;
  maximumTimestampResolutionErrorSeconds: number;
  blockTimestampCache: Map<bigint, { timestamp: number; hash: `0x${string}` | null }>;
  searchCalls: number;
}

async function cachedBlockInfo(
  client: HistoryPublicClient,
  blockNumber: bigint,
  cache: Map<bigint, { timestamp: number; hash: `0x${string}` | null }>,
): Promise<{ timestamp: number; hash: `0x${string}` | null }> {
  const cached = cache.get(blockNumber);
  if (cached) return cached;
  const block = await client.getBlock({ blockNumber });
  const info = {
    timestamp: Number(block.timestamp),
    hash: typeof block.hash === "string" ? (block.hash as `0x${string}`) : null,
  };
  cache.set(blockNumber, info);
  return info;
}

export async function resolveTimestampBlockRange(input: {
  client: HistoryPublicClient;
  startTimestamp: number;
  endTimestamp: number;
  latestBlock?: bigint;
  maximumSearchCalls?: number;
  deadlineMs?: number;
}): Promise<TimestampBlockRangeResolution> {
  if (historyRuntimeDeadlineReached(input.deadlineMs)) throw historyRuntimeDeadlineError();
  const latestBlock = input.latestBlock ?? await input.client.getBlockNumber();
  const cache = new Map<bigint, { timestamp: number; hash: `0x${string}` | null }>();
  const maxCalls = input.maximumSearchCalls ?? 96;
  let searchCalls = 0;
  const timestampAt = async (block: bigint): Promise<number> => {
    if (historyRuntimeDeadlineReached(input.deadlineMs)) throw historyRuntimeDeadlineError();
    searchCalls += 1;
    if (searchCalls > maxCalls) {
      throw new Error(`timestamp-to-block search exceeded ${maxCalls} block timestamp reads`);
    }
    return (await cachedBlockInfo(input.client, block, cache)).timestamp;
  };

  const firstAtOrAfter = async (target: number): Promise<bigint> => {
    let lo = 0n;
    let hi = latestBlock;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await timestampAt(mid) >= target) hi = mid;
      else lo = mid + 1n;
    }
    return lo;
  };

  const lastAtOrBefore = async (target: number): Promise<bigint> => {
    let lo = 0n;
    let hi = latestBlock;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (await timestampAt(mid) <= target) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  };

  const startBlock = await firstAtOrAfter(input.startTimestamp);
  const endBlock = await lastAtOrBefore(input.endTimestamp);
  const startInfo = await cachedBlockInfo(input.client, startBlock, cache);
  const endInfo = await cachedBlockInfo(input.client, endBlock, cache);
  return {
    requestedStartTimestamp: input.startTimestamp,
    requestedEndTimestamp: input.endTimestamp,
    resolvedStartBlock: startBlock,
    resolvedEndBlock: endBlock < startBlock ? startBlock : endBlock,
    resolvedStartBlockTimestamp: startInfo.timestamp,
    resolvedEndBlockTimestamp: endInfo.timestamp,
    maximumTimestampResolutionErrorSeconds: Math.max(
      Math.abs(startInfo.timestamp - input.startTimestamp),
      Math.abs(endInfo.timestamp - input.endTimestamp),
    ),
    blockTimestampCache: cache,
    searchCalls,
  };
}

export function rangeFullyScanned(input: {
  resolvedStartBlock?: bigint | null;
  resolvedEndBlock?: bigint | null;
  scannedFromBlock?: bigint | null;
  scannedToBlock?: bigint | null;
  unresolvedRpcRangeError?: boolean;
}): boolean {
  return (
    input.unresolvedRpcRangeError !== true &&
    input.resolvedStartBlock !== undefined &&
    input.resolvedStartBlock !== null &&
    input.resolvedEndBlock !== undefined &&
    input.resolvedEndBlock !== null &&
    input.scannedFromBlock !== undefined &&
    input.scannedFromBlock !== null &&
    input.scannedToBlock !== undefined &&
    input.scannedToBlock !== null &&
    input.scannedFromBlock <= input.resolvedStartBlock &&
    input.scannedToBlock >= input.resolvedEndBlock
  );
}

export function shouldUseRpcLogFallback(report: RotationHistoryPoolSyncStatus): boolean {
  return (
    report.truncationReason === "SOURCE_ROW_LIMIT" ||
    report.truncationReason === "PAGINATION_BUG_OR_REPEATED_CURSOR" ||
    report.truncationReason === "SOURCE_ERROR"
  );
}

async function fetchV2SwapLogsFallback(input: {
  config: AppConfig;
  candidate: RotationCandidateRegistryEntry;
  sourcePool: RotationHistorySourcePoolRef;
  startTimestamp: number;
  endTimestamp: number;
  maximumBlocksPerChunk: number;
  fetchedAt: string;
  anchorObservations?: RotationPriceObservation[];
  resumeFromBlock?: bigint;
  deadlineMs?: number;
}): Promise<{
  records: RotationHistoryRecord[];
  reportPatch: Partial<RotationHistoryPoolSyncStatus>;
  errors: string[];
  partial: boolean;
}> {
  const errors: string[] = [];
  const records: RotationHistoryRecord[] = [];
  const pair = input.sourcePool.pair;
  const client = getPublicClient(boundedHistoryRequestConfig(input.config, input.deadlineMs)) as unknown as HistoryPublicClient;
  let chunk = Math.max(100, input.maximumBlocksPerChunk);
  let range: TimestampBlockRangeResolution;
  try {
    range = await resolveTimestampBlockRange({
      client,
      startTimestamp: input.startTimestamp,
      endTimestamp: input.endTimestamp,
      deadlineMs: input.deadlineMs,
    });
  } catch (err) {
    if (isHistoryRuntimeDeadlineError(err)) {
      return {
        records,
        reportPatch: {
          fallbackUsed: "RPC_ETH_GETLOGS",
          truncationReason: "PARTIAL_PROGRESS",
          exactRemainingTruncationCause: "PARTIAL_PROGRESS",
          nextResumeBlock: input.resumeFromBlock?.toString() ?? null,
          error: "HISTORY_RUNTIME_DEADLINE_REACHED",
          errors: ["HISTORY_RUNTIME_DEADLINE_REACHED"],
        },
        errors: [],
        partial: true,
      };
    }
    return {
      records,
      reportPatch: {
        fallbackUsed: "RPC_ETH_GETLOGS",
        truncationReason: "FAILED_BLOCK_TO_TIME_CONVERSION",
        exactRemainingTruncationCause: "FAILED_BLOCK_TO_TIME_CONVERSION",
        error: err instanceof Error ? err.message : String(err),
      },
      errors: [err instanceof Error ? err.message : String(err)],
      partial: false,
    };
  }
  let from = input.resumeFromBlock ?? range.resolvedStartBlock;
  let scannedFromBlock: bigint | null = null;
  let scannedToBlock: bigint | null = null;
  let partial = false;
  let unsupportedLogs = 0;
  let anchorRecordsUsed = 0;
  const started = Date.now();
  while (from <= range.resolvedEndBlock) {
    if (historyRuntimeDeadlineReached(input.deadlineMs)) {
      partial = true;
      break;
    }
    const to = from + BigInt(chunk - 1) > range.resolvedEndBlock ? range.resolvedEndBlock : from + BigInt(chunk - 1);
    try {
      const logs = await client.getLogs({
        address: pair.id.toLowerCase() as `0x${string}`,
        event: v2SwapEventAbi,
        fromBlock: from,
        toBlock: to,
      });
      scannedFromBlock = scannedFromBlock === null ? from : scannedFromBlock < from ? scannedFromBlock : from;
      scannedToBlock = scannedToBlock === null ? to : scannedToBlock > to ? scannedToBlock : to;
      for (const log of logs) {
        if (historyRuntimeDeadlineReached(input.deadlineMs)) {
          partial = true;
          break;
        }
        if (log.blockNumber === undefined) {
          unsupportedLogs += 1;
          continue;
        }
        const info = await cachedBlockInfo(client, log.blockNumber, range.blockTimestampCache);
        if (info.timestamp < input.startTimestamp || info.timestamp > input.endTimestamp) continue;
        let decoded: {
          args: {
            amount0In: bigint;
            amount1In: bigint;
            amount0Out: bigint;
            amount1Out: bigint;
          };
        };
        try {
          decoded = decodeEventLog({
            abi: [v2SwapEventAbi],
            data: log.data,
            topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
          }) as {
            args: {
              amount0In: bigint;
              amount1In: bigint;
              amount0Out: bigint;
              amount1Out: bigint;
            };
          };
        } catch {
          unsupportedLogs += 1;
          continue;
        }
        const amount0Raw = (decoded.args.amount0In + decoded.args.amount0Out).toString();
        const amount1Raw = (decoded.args.amount1In + decoded.args.amount1Out).toString();
        const amount0Human = Number(formatUnits(BigInt(amount0Raw), pairTokenDecimals(pair, pair.token0.id, 18)));
        const amount1Human = Number(formatUnits(BigInt(amount1Raw), pairTokenDecimals(pair, pair.token1.id, 18)));
        const token0 = pairTokenAddress(pair, 0);
        const token1 = pairTokenAddress(pair, 1);
        const candidateToken = input.candidate.executionTokenAddress.toLowerCase();
        const candidateAmount =
          sameAddress(token0, candidateToken) ? amount0Human :
            sameAddress(token1, candidateToken) ? amount1Human :
              input.candidate.candidateId === "PLS" && sameAddress(token0, WPLS_ADDRESS) ? amount0Human :
                input.candidate.candidateId === "PLS" && sameAddress(token1, WPLS_ADDRESS) ? amount1Human : 0;
        const eusdcAmount =
          sameAddress(token0, EUSDC_ADDRESS) ? amount0Human :
            sameAddress(token1, EUSDC_ADDRESS) ? amount1Human : 0;
        const wplsAmount =
          sameAddress(token0, WPLS_ADDRESS) ? amount0Human :
            sameAddress(token1, WPLS_ADDRESS) ? amount1Human : 0;
        let price: number | null = null;
        let volumeEusdc = eusdcAmount;
        let source = `${input.sourcePool.sourceVersion.toLowerCase()}-rpc-v2-style-swap`;
        let anchor: { price: number; age: number; poolAddress?: `0x${string}` } | null = null;
        if (candidateAmount > 0 && eusdcAmount > 0) {
          price = eusdcAmount / candidateAmount;
        } else if (candidateAmount > 0 && wplsAmount > 0) {
          anchor = nearestAnchorPrice(
            input.anchorObservations ?? [],
            info.timestamp,
            ANCHOR_MAX_AGE_SECONDS,
            log.blockNumber.toString(),
          );
          if (!anchor) continue;
          price = (wplsAmount / candidateAmount) * anchor.price;
          volumeEusdc = wplsAmount * anchor.price;
          source = `${input.sourcePool.sourceVersion.toLowerCase()}-rpc-v2-style-swap-anchored-wpls-eusdc`;
          anchorRecordsUsed += 1;
        }
        if (price === null || price <= 0 || !Number.isFinite(price) || volumeEusdc <= 0) continue;
        records.push({
          chainId: PULSECHAIN_CHAIN_ID,
          candidateId: input.candidate.candidateId,
          poolAddress: pair.id.toLowerCase() as `0x${string}`,
          factoryAddress: input.sourcePool.factoryAddress,
          protocol: input.sourcePool.protocol,
          sourceVersion: input.sourcePool.sourceVersion,
          eventAdapter: input.sourcePool.eventAdapter,
          anchorPoolAddress: anchor?.poolAddress,
          anchorAgeSeconds: anchor?.age,
          blockNumber: log.blockNumber?.toString() ?? null,
          blockHash: (log.blockHash as `0x${string}` | null) ?? info.hash,
          transactionHash: log.transactionHash as `0x${string}`,
          logIndex: Number(log.logIndex ?? 0n),
          timestamp: info.timestamp,
          token0,
          token1,
          amount0Raw,
          amount1Raw,
          candidatePriceEusdc: round(price, 18),
          eusdcNotionalRaw: decimalHumanToRaw(String(volumeEusdc), 6),
          source,
          fetchedAt: input.fetchedAt,
        });
      }
      if (partial) break;
      from = to + 1n;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (chunk > 100) {
        chunk = reduceLogChunkAfterRangeError(chunk);
        continue;
      }
      errors.push(message);
      break;
    }
  }
  const timestamps = records.map((record) => record.timestamp);
  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : null;
  const completeRange = rangeFullyScanned({
    resolvedStartBlock: range.resolvedStartBlock,
    resolvedEndBlock: range.resolvedEndBlock,
    scannedFromBlock,
    scannedToBlock,
    unresolvedRpcRangeError: errors.length > 0 || partial,
  });
  const boundaryCrossed = completeRange;
  return {
    records,
    reportPatch: {
      fallbackUsed: "RPC_ETH_GETLOGS",
      fallbackRecords: records.length,
      rpcRecordsRetrieved: records.length,
      anchorRecordsUsed,
      unsupportedLogs,
      oldestReturnedRecord: oldest !== null ? isoFromSeconds(oldest) : undefined,
      newestReturnedRecord: newest !== null ? isoFromSeconds(newest) : undefined,
      firstObservedTradeTimestamp: oldest !== null ? isoFromSeconds(oldest) : null,
      lastObservedTradeTimestamp: newest !== null ? isoFromSeconds(newest) : null,
      resolvedStartBlock: range.resolvedStartBlock.toString(),
      resolvedEndBlock: range.resolvedEndBlock.toString(),
      scannedFromBlock: scannedFromBlock?.toString() ?? null,
      scannedToBlock: scannedToBlock?.toString() ?? null,
      rangeFullyScanned: completeRange,
      timestampResolutionMaxErrorSeconds: range.maximumTimestampResolutionErrorSeconds,
      retrievalCompletenessPercent: completeRange ? 100 : 0,
      signalWindowCompletenessPercent:
        completeRange && newest !== null && newest >= input.endTimestamp - 24 * 60 * 60 ? 100 : 0,
      boundaryCrossed,
      exactRemainingTruncationCause: completeRange ? undefined : partial ? "PARTIAL_PROGRESS" : "RPC_LOG_RANGE_LIMITATION",
      nextResumeBlock: partial ? from.toString() : null,
      elapsedMs: Date.now() - started,
      ...(partial ? { truncationReason: "PARTIAL_PROGRESS" as const } : {}),
      ...(completeRange ? { truncationReason: "NONE" as const } : {}),
      ...(errors.length > 0 ? { truncationReason: "RPC_LOG_RANGE_LIMITATION", error: errors.join("; ") } : {}),
    },
    errors,
    partial,
  };
}

async function scanV2SwapLogBlockRange(input: {
  config: AppConfig;
  chainId: number;
  candidate: RotationCandidateRegistryEntry;
  sourcePool: RotationHistorySourcePoolRef;
  fromBlock: bigint;
  toBlock: bigint;
  requestedStartTimestamp: number;
  requestedEndTimestamp: number;
  resolvedStartBlock: bigint;
  resolvedEndBlock: bigint;
  tipStartBlock: bigint;
  tipEndBlock: bigint;
  phase: RotationRecentRefreshPhase;
  fetchedAt: string;
  anchorObservations: RotationPriceObservation[];
  anchorTipComplete: boolean;
  blockTimestampCache: Map<bigint, { timestamp: number; hash: `0x${string}` | null }>;
  existingKeys: Set<string>;
  deadlineMs?: number;
}): Promise<{
  records: RotationHistoryRecord[];
  report: RotationHistoryPoolSyncStatus;
  errors: string[];
}> {
  const started = Date.now();
  const pair = input.sourcePool.pair;
  const poolAddress = pair.id.toLowerCase() as `0x${string}`;
  const token0 = pairTokenAddress(pair, 0);
  const token1 = pairTokenAddress(pair, 1);
  const baseReport = (): Omit<
    RotationHistoryPoolSyncStatus,
    | "oldestReturnedRecord"
    | "newestReturnedRecord"
    | "totalRecordsRetrieved"
    | "deduplicatedRecords"
    | "boundaryCrossed"
    | "truncationReason"
    | "sourceRepeatsOrCapsRecords"
    | "historicalPaginationReliable"
  > => ({
    candidateId: input.candidate.candidateId,
    poolAddress,
    token0,
    token1,
    token0Decimals: pairTokenDecimals(pair, pair.token0.id, 18),
    token1Decimals: pairTokenDecimals(pair, pair.token1.id, 18),
    factoryAddress: input.sourcePool.factoryAddress,
    protocol: input.sourcePool.protocol,
    sourceVersion: input.sourcePool.sourceVersion,
    eventAdapter: input.sourcePool.eventAdapter,
    sourceEndpoint: input.sourcePool.subgraphEndpoint,
    queryType: `${input.sourcePool.protocol} eth_getLogs(Swap) recent range`,
    pageSize: 0,
    maximumPageCount: 0,
    cursorMechanism: "block-range",
    requestedStartTime: isoFromSeconds(input.requestedStartTimestamp) ?? input.fetchedAt,
    requestedEndTime: isoFromSeconds(input.requestedEndTimestamp) ?? input.fetchedAt,
    resolvedStartBlock: input.resolvedStartBlock.toString(),
    resolvedEndBlock: input.resolvedEndBlock.toString(),
    contributesToConsolidatedPrice: input.sourcePool.contributesToConsolidatedPrice,
    classification: input.sourcePool.classification,
    liquidityEusdc: input.sourcePool.liquidityEusdc,
    recentVolumeEusdc: input.sourcePool.recentVolumeEusdc,
    exclusionReason: input.sourcePool.exclusionReason,
    fallbackUsed: "RPC_ETH_GETLOGS",
  });

  if (input.sourcePool.eventAdapter !== "PULSEX_V2_STYLE_SWAP") {
    return {
      records: [],
      errors: ["unsupported event adapter"],
      report: {
        ...baseReport(),
        oldestReturnedRecord: null,
        newestReturnedRecord: null,
        totalRecordsRetrieved: 0,
        deduplicatedRecords: 0,
        boundaryCrossed: false,
        truncationReason: "UNSUPPORTED_EVENT_ABI",
        sourceRepeatsOrCapsRecords: false,
        historicalPaginationReliable: false,
        unsupportedLogs: 0,
        errors: ["unsupported event adapter"],
        exactRemainingTruncationCause: "UNSUPPORTED_EVENT_ABI",
        elapsedMs: Date.now() - started,
      },
    };
  }

  const client = getPublicClient(boundedHistoryRequestConfig(input.config, input.deadlineMs)) as unknown as HistoryPublicClient;
  if (historyRuntimeDeadlineReached(input.deadlineMs)) {
    return {
      records: [],
      errors: ["HISTORY_RUNTIME_DEADLINE_REACHED"],
      report: {
        ...baseReport(),
        oldestReturnedRecord: null,
        newestReturnedRecord: null,
        totalRecordsRetrieved: 0,
        deduplicatedRecords: 0,
        boundaryCrossed: false,
        truncationReason: "PARTIAL_PROGRESS",
        sourceRepeatsOrCapsRecords: false,
        historicalPaginationReliable: false,
        nextResumeBlock: input.fromBlock.toString(),
        exactRemainingTruncationCause: "PARTIAL_PROGRESS",
        error: "HISTORY_RUNTIME_DEADLINE_REACHED",
        errors: ["HISTORY_RUNTIME_DEADLINE_REACHED"],
        elapsedMs: Date.now() - started,
      },
    };
  }

  let logs: Awaited<ReturnType<HistoryPublicClient["getLogs"]>>;
  try {
    logs = await client.getLogs({
      address: poolAddress,
      event: v2SwapEventAbi,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      records: [],
      errors: [message],
      report: {
        ...baseReport(),
        scannedFromBlock: input.fromBlock.toString(),
        scannedToBlock: input.toBlock.toString(),
        oldestReturnedRecord: null,
        newestReturnedRecord: null,
        totalRecordsRetrieved: 0,
        deduplicatedRecords: 0,
        boundaryCrossed: false,
        truncationReason: "SOURCE_ERROR",
        sourceRepeatsOrCapsRecords: false,
        historicalPaginationReliable: false,
        error: message,
        errors: [message],
        exactRemainingTruncationCause: "SOURCE_ERROR",
        elapsedMs: Date.now() - started,
      },
    };
  }

  const recordsByKey = new Map<string, RotationHistoryRecord>();
  const sourceTradeTimestamps: number[] = [];
  let unsupportedLogs = 0;
  let anchorRecordsUsed = 0;
  for (const log of logs) {
    if (log.blockNumber === undefined || log.transactionHash === undefined) {
      unsupportedLogs += 1;
      continue;
    }
    let info: { timestamp: number; hash: `0x${string}` | null };
    try {
      info = await cachedBlockInfo(client, log.blockNumber, input.blockTimestampCache);
    } catch (err) {
      unsupportedLogs += 1;
      continue;
    }
    if (info.timestamp < input.requestedStartTimestamp || info.timestamp > input.requestedEndTimestamp) continue;
    let decoded: {
      args: {
        amount0In: bigint;
        amount1In: bigint;
        amount0Out: bigint;
        amount1Out: bigint;
      };
    };
    try {
      decoded = decodeEventLog({
        abi: [v2SwapEventAbi],
        data: log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      }) as {
        args: {
          amount0In: bigint;
          amount1In: bigint;
          amount0Out: bigint;
          amount1Out: bigint;
        };
      };
    } catch {
      unsupportedLogs += 1;
      continue;
    }
    const amount0Raw = (decoded.args.amount0In + decoded.args.amount0Out).toString();
    const amount1Raw = (decoded.args.amount1In + decoded.args.amount1Out).toString();
    if (BigInt(amount0Raw) > 0n || BigInt(amount1Raw) > 0n) sourceTradeTimestamps.push(info.timestamp);
    const amount0Human = Number(formatUnits(BigInt(amount0Raw), pairTokenDecimals(pair, pair.token0.id, 18)));
    const amount1Human = Number(formatUnits(BigInt(amount1Raw), pairTokenDecimals(pair, pair.token1.id, 18)));
    const candidateToken = input.candidate.executionTokenAddress.toLowerCase();
    const candidateAmount =
      sameAddress(token0, candidateToken) ? amount0Human :
        sameAddress(token1, candidateToken) ? amount1Human :
          input.candidate.candidateId === "PLS" && sameAddress(token0, WPLS_ADDRESS) ? amount0Human :
            input.candidate.candidateId === "PLS" && sameAddress(token1, WPLS_ADDRESS) ? amount1Human : 0;
    const eusdcAmount =
      sameAddress(token0, EUSDC_ADDRESS) ? amount0Human :
        sameAddress(token1, EUSDC_ADDRESS) ? amount1Human : 0;
    const wplsAmount =
      sameAddress(token0, WPLS_ADDRESS) ? amount0Human :
        sameAddress(token1, WPLS_ADDRESS) ? amount1Human : 0;
    let price: number | null = null;
    let volumeEusdc = eusdcAmount;
    let source = `${input.sourcePool.sourceVersion.toLowerCase()}-recent-rpc-v2-style-swap`;
    let anchor: { price: number; age: number; poolAddress?: `0x${string}` } | null = null;
    if (candidateAmount > 0 && eusdcAmount > 0) {
      price = eusdcAmount / candidateAmount;
    } else if (candidateAmount > 0 && wplsAmount > 0) {
      anchor = nearestAnchorPrice(
        input.anchorObservations,
        info.timestamp,
        ANCHOR_MAX_AGE_SECONDS,
        log.blockNumber.toString(),
      );
      if (!anchor) continue;
      price = (wplsAmount / candidateAmount) * anchor.price;
      volumeEusdc = wplsAmount * anchor.price;
      source = `${input.sourcePool.sourceVersion.toLowerCase()}-recent-rpc-v2-style-swap-anchored-wpls-eusdc`;
      anchorRecordsUsed += 1;
    }
    if (price === null || price <= 0 || !Number.isFinite(price) || volumeEusdc <= 0) continue;
    const record: RotationHistoryRecord = {
      chainId: input.chainId,
      candidateId: input.candidate.candidateId,
      poolAddress,
      factoryAddress: input.sourcePool.factoryAddress,
      protocol: input.sourcePool.protocol,
      sourceVersion: input.sourcePool.sourceVersion,
      eventAdapter: input.sourcePool.eventAdapter,
      anchorPoolAddress: anchor?.poolAddress,
      anchorAgeSeconds: anchor?.age,
      blockNumber: log.blockNumber.toString(),
      blockHash: (log.blockHash as `0x${string}` | null) ?? info.hash,
      transactionHash: log.transactionHash as `0x${string}`,
      logIndex: Number(log.logIndex ?? 0n),
      timestamp: info.timestamp,
      token0,
      token1,
      amount0Raw,
      amount1Raw,
      candidatePriceEusdc: round(price, 18),
      eusdcNotionalRaw: decimalHumanToRaw(String(volumeEusdc), 6),
      source,
      fetchedAt: input.fetchedAt,
    };
    recordsByKey.set(historyRecordKey(record), record);
  }

  const records = [...recordsByKey.values()];
  const recordTimestamps = records.map((record) => record.timestamp);
  const sourceTimestamps = sourceTradeTimestamps.length > 0 ? sourceTradeTimestamps : recordTimestamps;
  const oldest = sourceTimestamps.length > 0 ? Math.min(...sourceTimestamps) : null;
  const newest = sourceTimestamps.length > 0 ? Math.max(...sourceTimestamps) : null;
  const duplicateRecordsIgnored = records.filter((record) => input.existingKeys.has(historyRecordKey(record))).length;
  const blocksScanned = Number(input.toBlock - input.fromBlock + 1n);
  const tipRangeTouched = input.toBlock >= input.tipStartBlock && input.fromBlock <= input.tipEndBlock;
  const tipRangeComplete = tipRangeTouched && input.fromBlock <= input.tipStartBlock && input.toBlock >= input.tipEndBlock;
  const recentTradesFound = newest !== null && newest >= input.requestedEndTimestamp - 30 * 60;
  const toInfo = await cachedBlockInfo(client, input.toBlock, input.blockTimestampCache);
  return {
    records,
    errors: [],
    report: {
      ...baseReport(),
      scannedFromBlock: input.fromBlock.toString(),
      scannedToBlock: input.toBlock.toString(),
      completedRangeScanned: true,
      rangeFullyScanned: false,
      firstObservedTradeTimestamp: oldest !== null ? isoFromSeconds(oldest) : null,
      lastObservedTradeTimestamp: newest !== null ? isoFromSeconds(newest) : null,
      oldestReturnedRecord: oldest !== null ? isoFromSeconds(oldest) : null,
      newestReturnedRecord: newest !== null ? isoFromSeconds(newest) : null,
      latestSourceTradeTimestamp: newest !== null ? isoFromSeconds(newest) : null,
      lastScannedBlockTimestamp: isoFromSeconds(toInfo.timestamp),
      totalRecordsRetrieved: logs.length,
      deduplicatedRecords: records.length,
      rpcRecordsRetrieved: logs.length,
      fallbackRecords: records.length,
      anchorRecordsUsed,
      unsupportedLogs,
      blocksScanned,
      logsRetrieved: logs.length,
      validRecordsProduced: records.length,
      recordsAdded: Math.max(0, records.length - duplicateRecordsIgnored),
      duplicateRecordsIgnored,
      boundaryCrossed: false,
      truncationReason: "PARTIAL_PROGRESS",
      sourceRepeatsOrCapsRecords: false,
      historicalPaginationReliable: true,
      retrievalCompletenessPercent: 0,
      signalWindowCompletenessPercent: 0,
      tipCompletenessPercent: tipRangeComplete ? 100 : 0,
      tipFreshnessStatus: classifyTipFreshness({
        tipScanned: tipRangeComplete,
        recentTradesFound,
        anchorComplete: input.sourcePool.classification === "REQUIRED_PRICE_POOL" ? input.anchorTipComplete : true,
        requiredPoolComplete: true,
      }),
      tipLagBlocks: input.tipEndBlock > input.toBlock ? Number(input.tipEndBlock - input.toBlock) : 0,
      ...(input.tipEndBlock > input.toBlock ? {} : { tipLagMinutes: 0 }),
      exactRemainingTruncationCause: "PARTIAL_PROGRESS",
      elapsedMs: Date.now() - started,
    },
  };
}

type NormalizedHistorySyncInput = {
  lookbackMinutes: number;
  maximumBlocksPerChunk: number;
  maximumPagesPerSource: number;
  forceRecentBlockRecheck: boolean;
  maximumRuntimeMs: number;
  candidateIds?: RotationCandidateId[];
  resumeToken?: string;
  maximumPoolsPerRun?: number;
  syncPurpose: RotationHistorySyncPurpose;
};

type NormalizedRecentRefreshInput = {
  lookbackMinutes: number;
  candidateIds?: RotationCandidateId[];
  tipRefreshMinutes: number;
  maximumRuntimeMs: number;
  maximumBlocksPerChunk: number;
  maximumPoolsPerRun: number;
  resumeToken?: string;
  forceRecentBlockRecheck: boolean;
};

function normalizeHistorySyncInput(input: RotationHistorySyncInput): NormalizedHistorySyncInput {
  const maximumRuntimeMs = Math.min(
    Math.max(1_000, input.maximumRuntimeMs ?? DEFAULT_HISTORY_MAX_RUNTIME_MS),
    MAX_HISTORY_MAX_RUNTIME_MS,
  );
  return {
    lookbackMinutes: input.lookbackMinutes ?? DEFAULT_HISTORY_LOOKBACK_MINUTES,
    maximumBlocksPerChunk: input.maximumBlocksPerChunk ?? DEFAULT_LOG_CHUNK_BLOCKS,
    maximumPagesPerSource: input.maximumPagesPerSource ?? DEFAULT_HISTORY_MAX_PAGES,
    forceRecentBlockRecheck: input.forceRecentBlockRecheck ?? true,
    maximumRuntimeMs,
    ...(input.candidateIds ? { candidateIds: [...new Set(input.candidateIds)] } : {}),
    ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
    ...(input.maximumPoolsPerRun !== undefined ? { maximumPoolsPerRun: input.maximumPoolsPerRun } : {}),
    syncPurpose: input.syncPurpose ?? "HISTORICAL_BACKFILL",
  };
}

function normalizeRecentRefreshInput(input: RotationRecentRefreshInput): NormalizedRecentRefreshInput {
  const maximumRuntimeMs = Math.min(
    Math.max(1_000, input.maximumRuntimeMs ?? 120_000),
    Math.min(MAX_HISTORY_MAX_RUNTIME_MS, 180_000),
  );
  return {
    lookbackMinutes: input.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES,
    ...(input.candidateIds ? { candidateIds: [...new Set(input.candidateIds)] } : {}),
    tipRefreshMinutes: input.tipRefreshMinutes ?? 120,
    maximumRuntimeMs,
    maximumBlocksPerChunk: input.maximumBlocksPerChunk ?? 10_000,
    maximumPoolsPerRun: input.maximumPoolsPerRun ?? 6,
    ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
    forceRecentBlockRecheck: input.forceRecentBlockRecheck ?? true,
  };
}

function pairTokensMatch(
  token0: `0x${string}`,
  token1: `0x${string}`,
  a: `0x${string}`,
  b: `0x${string}`,
): boolean {
  return (sameAddress(token0, a) && sameAddress(token1, b)) ||
    (sameAddress(token0, b) && sameAddress(token1, a));
}

function summarizeTipFreshness(reports: RotationHistoryPoolSyncStatus[]): RotationTipFreshnessStatus | undefined {
  if (reports.length === 0) return undefined;
  if (reports.some((report) => report.tipFreshnessStatus === "ANCHOR_TIP_INCOMPLETE")) return "ANCHOR_TIP_INCOMPLETE";
  if (reports.some((report) => report.tipFreshnessStatus === "REQUIRED_POOL_TIP_INCOMPLETE")) return "REQUIRED_POOL_TIP_INCOMPLETE";
  if (reports.some((report) => report.tipFreshnessStatus === "PIPELINE_STALE" || report.tipFreshnessStatus === "TIP_NOT_SCANNED")) {
    return "PIPELINE_STALE";
  }
  if (reports.some((report) => report.tipFreshnessStatus === "TIP_SCANNED_RECENT_TRADES_FOUND")) {
    return "TIP_SCANNED_RECENT_TRADES_FOUND";
  }
  if (reports.every((report) =>
    report.tipFreshnessStatus === "MARKET_QUIET" ||
    report.tipFreshnessStatus === "TIP_SCANNED_NO_RECENT_TRADES"
  )) {
    return "MARKET_QUIET";
  }
  return reports[0]?.tipFreshnessStatus;
}

function latestSourceTradeAgeMinutes(reports: RotationHistoryPoolSyncStatus[]): number | null | undefined {
  const latest = reports
    .map((report) => report.latestSourceTradeTimestamp ?? report.newestReturnedRecord)
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  if (latest === undefined) return undefined;
  return round((Date.now() - latest) / 60_000, 4);
}

function pipelineLagMinutes(reports: RotationHistoryPoolSyncStatus[]): number | null | undefined {
  const lags = reports
    .map((report) => report.tipLagMinutes)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (lags.length === 0) return undefined;
  return round(Math.max(...lags), 4);
}

function summarizeCandidateSync(input: {
  candidate: RotationCandidateRegistryEntry;
  reports: RotationHistoryPoolSyncStatus[];
  records: RotationHistoryRecord[];
  existingRecords: RotationHistoryRecord[];
  requestedStartTime: string;
  requestedEndTime: string;
  forceRecentBlockRecheck: boolean;
  latestBlockNumber?: bigint;
  syncPurpose?: RotationHistorySyncPurpose;
}): RotationHistoryCandidateSyncStatus {
  const existing = new Map(input.existingRecords.map((record) => [historyRecordKey(record), record]));
  const incoming = new Map(input.records.map((record) => [historyRecordKey(record), record]));
  let added = 0;
  let updated = 0;
  let duplicates = 0;
  for (const record of incoming.values()) {
    const prior = existing.get(historyRecordKey(record));
    const block = record.blockNumber ? BigInt(record.blockNumber) : null;
    const recent =
      input.forceRecentBlockRecheck &&
      input.latestBlockNumber !== undefined &&
      block !== null &&
      input.latestBlockNumber >= block &&
      input.latestBlockNumber - block <= HISTORY_RECENT_REORG_BLOCKS;
    if (!prior) added += 1;
    else if (recent && prior.blockHash !== record.blockHash) updated += 1;
    else duplicates += 1;
  }
  const timestamps = [...incoming.values()].map((record) => record.timestamp);
  const completeReports = input.reports.filter((report) =>
    report.rangeFullyScanned ||
    report.boundaryCrossed ||
    report.truncationReason === "NONE" ||
    report.truncationReason === "SPARSE_ACTUAL_TRADING" ||
    report.truncationReason === "STALE_POOL",
  );
  const requiredReports = input.reports.filter((report) =>
    report.classification === "REQUIRED_PRICE_POOL" || report.classification === undefined,
  );
  const completenessReports = requiredReports.length > 0 ? requiredReports : input.reports;
  const completeRequired = completenessReports.filter((report) =>
    report.rangeFullyScanned ||
    report.boundaryCrossed ||
    report.truncationReason === "NONE" ||
    report.truncationReason === "SPARSE_ACTUAL_TRADING" ||
    report.truncationReason === "STALE_POOL"
  );
  const unresolved = input.reports
    .filter((report) =>
      (report.classification === "REQUIRED_PRICE_POOL" || report.classification === undefined) &&
      report.truncationReason !== "NONE" &&
      report.truncationReason !== "SPARSE_ACTUAL_TRADING" &&
      report.truncationReason !== "STALE_POOL",
    )
    .map((report) => `${report.poolAddress}: ${report.truncationReason}`);
  return {
    candidateId: input.candidate.candidateId,
    syncPurpose: input.syncPurpose,
    recordsAdded: added,
    recordsUpdated: updated,
    duplicateRecordsIgnored: duplicates,
    earliestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.min(...timestamps)) : null,
    latestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.max(...timestamps)) : null,
    boundaryCrossed: completenessReports.length > 0 && completenessReports.every((report) =>
      report.rangeFullyScanned ||
      report.boundaryCrossed ||
      report.truncationReason === "SPARSE_ACTUAL_TRADING" ||
      report.truncationReason === "STALE_POOL",
    ),
    sourceCompletenessPercent: completenessReports.length > 0
      ? round(completeRequired.length / completenessReports.length * 100, 4)
      : 0,
    retrievalCompletenessPercent: completenessReports.length > 0
      ? round(completeRequired.length / completenessReports.length * 100, 4)
      : 0,
    signalWindowCompletenessPercent: completenessReports.length > 0
      ? round(completenessReports.filter((report) =>
        (report.signalWindowCompletenessPercent ?? 0) >= 95
      ).length / completenessReports.length * 100, 4)
      : 0,
    sevenDayCompletenessPercent: input.reports.length > 0
      ? round(completeReports.length / input.reports.length * 100, 4)
      : 0,
    tipFreshnessStatus: summarizeTipFreshness(input.reports),
    tipCompletenessPercent: requiredReports.length > 0
      ? round(requiredReports.filter((report) => (report.tipCompletenessPercent ?? 0) >= 95).length / requiredReports.length * 100, 4)
      : undefined,
    latestSourceTradeAgeMinutes: latestSourceTradeAgeMinutes(input.reports),
    pipelineLagMinutes: pipelineLagMinutes(input.reports),
    requiredPoolsComplete: completenessReports.length > 0 && completenessReports.every((report) =>
      report.rangeFullyScanned ||
      report.boundaryCrossed ||
      report.truncationReason === "SPARSE_ACTUAL_TRADING" ||
      report.truncationReason === "STALE_POOL" ||
      (report.tipCompletenessPercent ?? 0) >= 95
    ),
    anchorTipComplete: requiredReports
      .filter((report) => report.poolAddress && report.token0 && report.token1 && pairTokensMatch(report.token0, report.token1, WPLS_ADDRESS, EUSDC_ADDRESS))
      .every((report) => (report.tipCompletenessPercent ?? 0) >= 95),
    unresolvedGaps: unresolved,
    pools: input.reports,
  };
}

async function syncHistoryForCandidate(input: {
  config: AppConfig;
  chainId: number;
  candidate: RotationCandidateRegistryEntry;
  startTimestamp: number;
  endTimestamp: number;
  maximumBlocksPerChunk: number;
  maximumPagesPerSource: number;
  fetchedAt: string;
  existingStore: RotationHistoryFile;
  deadlineMs?: number;
  maximumPoolsPerRun?: number;
  resumeCheckpoint?: RotationHistorySyncCheckpoint | null;
}): Promise<{
  records: RotationHistoryRecord[];
  reports: RotationHistoryPoolSyncStatus[];
  errors: string[];
  partial: boolean;
  nextPoolIndex: number;
  attemptedPools: number;
}> {
  const errors: string[] = [];
  const {
    pools: sourcePools,
    errors: pairErrors,
    partial: sourceDiscoveryPartial,
  } = await fetchSourcePoolsForCandidate(input.config, input.candidate, input.deadlineMs);
  errors.push(...pairErrors);
  const selectedPools = selectedSourcePools(input.candidate, sourcePools);
  if (selectedPools.length === 0) {
    return {
      records: [],
      errors: [...errors, "missing pool discovery"],
      reports: [{
        candidateId: input.candidate.candidateId,
        poolAddress: input.candidate.executionTokenAddress.toLowerCase() as `0x${string}`,
        sourceEndpoint: input.config.pulseXSubgraphV2,
        queryType: "PulseX V1/V2 pairs(token)",
        pageSize: 0,
        maximumPageCount: input.maximumPagesPerSource,
        cursorMechanism: "none",
        oldestReturnedRecord: null,
        newestReturnedRecord: null,
        requestedStartTime: isoFromSeconds(input.startTimestamp) ?? input.fetchedAt,
        requestedEndTime: isoFromSeconds(input.endTimestamp) ?? input.fetchedAt,
        totalRecordsRetrieved: 0,
        deduplicatedRecords: 0,
        boundaryCrossed: false,
        truncationReason: "MISSING_POOL_DISCOVERY",
        sourceRepeatsOrCapsRecords: false,
        historicalPaginationReliable: false,
        fallbackUsed: "NONE",
      }],
      partial: sourceDiscoveryPartial,
      nextPoolIndex: 0,
      attemptedPools: 0,
    };
  }
  const records: RotationHistoryRecord[] = [];
  let fallbackRecords: RotationHistoryRecord[] = [];
  const reports: RotationHistoryPoolSyncStatus[] = [];
  const currentCandidateIndex = EUSDC_ROTATION_CANDIDATES.findIndex((row) =>
    row.candidateId === input.candidate.candidateId
  );
  const startPoolIndex = input.resumeCheckpoint?.sourceCursor?.candidateIndex === currentCandidateIndex
    ? input.resumeCheckpoint.sourceCursor.poolIndex
    : 0;
  let partial = sourceDiscoveryPartial;
  let attemptedPools = 0;
  let nextPoolIndex = startPoolIndex;
  const existingAnchors = observationsFromHistory(
    recordsForCandidate(input.existingStore, getRotationCandidate("PLS"), input.startTimestamp, input.endTimestamp),
  ).filter((obs) => obs.priceEusdc > 0);

  for (let poolIndex = startPoolIndex; poolIndex < selectedPools.length; poolIndex += 1) {
    if (partial) break;
    if (input.maximumPoolsPerRun !== undefined && attemptedPools >= input.maximumPoolsPerRun) {
      partial = true;
      nextPoolIndex = poolIndex;
      break;
    }
    if (historyRuntimeDeadlineReached(input.deadlineMs)) {
      partial = true;
      nextPoolIndex = poolIndex;
      break;
    }
    const sourcePool = selectedPools[poolIndex]!;
    attemptedPools += 1;
    let paged: Awaited<ReturnType<typeof fetchPairSwapsPaginated>>;
    try {
      paged = await fetchPairSwapsPaginated({
        config: input.config,
        candidateId: input.candidate.candidateId,
        sourcePools: [sourcePool],
        startTimestamp: input.startTimestamp,
        endTimestamp: input.endTimestamp,
        maxPagesPerPair: input.maximumPagesPerSource,
        pageSize: DEFAULT_HISTORY_PAGE_SIZE,
        deadlineMs: input.deadlineMs,
      });
      errors.push(...paged.errors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      reports.push({
        candidateId: input.candidate.candidateId,
        poolAddress: sourcePool.pair.id.toLowerCase() as `0x${string}`,
        token0: pairTokenAddress(sourcePool.pair, 0),
        token1: pairTokenAddress(sourcePool.pair, 1),
        token0Decimals: pairTokenDecimals(sourcePool.pair, sourcePool.pair.token0.id, 18),
        token1Decimals: pairTokenDecimals(sourcePool.pair, sourcePool.pair.token1.id, 18),
        factoryAddress: sourcePool.factoryAddress,
        protocol: sourcePool.protocol,
        sourceVersion: sourcePool.sourceVersion,
        eventAdapter: sourcePool.eventAdapter,
        sourceEndpoint: sourcePool.subgraphEndpoint,
        queryType: `${sourcePool.protocol} swaps(pair, first, skip)`,
        pageSize: DEFAULT_HISTORY_PAGE_SIZE,
        maximumPageCount: input.maximumPagesPerSource,
        cursorMechanism: "skip",
        oldestReturnedRecord: null,
        newestReturnedRecord: null,
        requestedStartTime: isoFromSeconds(input.startTimestamp) ?? input.fetchedAt,
        requestedEndTime: isoFromSeconds(input.endTimestamp) ?? input.fetchedAt,
        totalRecordsRetrieved: 0,
        deduplicatedRecords: 0,
        boundaryCrossed: false,
        truncationReason: "SOURCE_ERROR",
        sourceRepeatsOrCapsRecords: false,
        historicalPaginationReliable: false,
        fallbackUsed: "NONE",
        contributesToConsolidatedPrice: sourcePool.contributesToConsolidatedPrice,
        classification: sourcePool.classification,
        liquidityEusdc: sourcePool.liquidityEusdc,
        recentVolumeEusdc: sourcePool.recentVolumeEusdc,
        exclusionReason: sourcePool.exclusionReason,
        exactRemainingTruncationCause: "SOURCE_ERROR",
        error: message,
        errors: [message],
      });
      continue;
    }
    const subgraphPartial = paged.poolReports.some((report) => report.truncationReason === "PARTIAL_PROGRESS");

    const poolSubgraphRecords: RotationHistoryRecord[] = [];
    const anchorObservations = [
      ...existingAnchors,
      ...buildAnchorObservations(paged.swaps).map((obs) => ({
        ...obs,
        poolAddress: sourcePool.pair.id.toLowerCase() as `0x${string}`,
      })),
      ...observationsFromHistory(records.filter((record) => record.candidateId === "PLS")),
    ];
    for (const row of paged.poolSwaps) {
      const rowSourcePool = row.sourcePool ?? sourcePool;
      for (const [index, swap] of row.swaps.entries()) {
        const observation = priceObservationFromSwap({
          swap,
          candidate: input.candidate,
          anchorObservations,
          maxAnchorAgeSeconds: ANCHOR_MAX_AGE_SECONDS,
        });
        if (!observation) continue;
        const record = historyRecordFromSubgraphSwap({
          chainId: input.chainId,
          candidate: input.candidate,
          pair: rowSourcePool.pair,
          sourcePool: rowSourcePool,
          swap,
          observation,
          fetchedAt: input.fetchedAt,
          fallbackLogIndex: index,
        });
        records.push(record);
        poolSubgraphRecords.push(record);
      }
    }
    let fallbackReports = paged.poolReports;
    if (subgraphPartial) {
      partial = true;
      nextPoolIndex = poolIndex;
    }
    for (const report of paged.poolReports) {
      if (partial && report.truncationReason === "PARTIAL_PROGRESS") continue;
      if (!shouldUseRpcLogFallback(report)) continue;
      if (sourcePool.classification === "EXCLUDED_POOL" || sourcePool.eventAdapter !== "PULSEX_V2_STYLE_SWAP") continue;
      try {
        const fallback = await fetchV2SwapLogsFallback({
          config: input.config,
          candidate: input.candidate,
          sourcePool,
          startTimestamp: input.startTimestamp,
          endTimestamp: input.endTimestamp,
          maximumBlocksPerChunk: input.maximumBlocksPerChunk,
          fetchedAt: input.fetchedAt,
          anchorObservations: [
            ...existingAnchors,
            ...observationsFromHistory(records.filter((record) => record.candidateId === "PLS")),
          ],
          resumeFromBlock:
            input.resumeCheckpoint?.sourceCursor?.candidateIndex === currentCandidateIndex &&
              input.resumeCheckpoint.sourceCursor.poolIndex === poolIndex &&
              input.resumeCheckpoint.nextBlock
              ? BigInt(input.resumeCheckpoint.nextBlock)
              : undefined,
          deadlineMs: input.deadlineMs,
        });
        fallbackRecords = fallbackRecords.concat(fallback.records);
        errors.push(...fallback.errors);
        if (fallback.partial) {
          partial = true;
          nextPoolIndex = poolIndex;
        }
        fallbackReports = fallbackReports.map((row) =>
          sameAddress(row.poolAddress, report.poolAddress)
            ? { ...row, ...fallback.reportPatch, historicalPaginationReliable: fallback.errors.length === 0 }
            : row,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        fallbackReports = fallbackReports.map((row) =>
          sameAddress(row.poolAddress, report.poolAddress)
            ? { ...row, fallbackUsed: "RPC_ETH_GETLOGS", truncationReason: "RPC_LOG_RANGE_LIMITATION", error: message }
            : row,
        );
      }
      if (partial) break;
    }
    reports.push(...fallbackReports.map((report) => {
      const poolRecords = [...poolSubgraphRecords, ...fallbackRecords].filter((record) =>
        sameAddress(record.poolAddress, report.poolAddress)
      );
      return {
        ...report,
        rpcRecordsRetrieved: report.rpcRecordsRetrieved ?? report.fallbackRecords ?? 0,
        firstObservedTradeTimestamp: report.firstObservedTradeTimestamp ?? report.oldestReturnedRecord,
        lastObservedTradeTimestamp: report.lastObservedTradeTimestamp ?? report.newestReturnedRecord,
        retrievalCompletenessPercent:
          report.classification === "REQUIRED_PRICE_POOL"
            ? report.rangeFullyScanned || report.boundaryCrossed || report.truncationReason === "NONE" ? 100 : 0
            : 100,
        signalWindowCompletenessPercent:
          poolRecords.some((record) => record.timestamp >= input.endTimestamp - 24 * 60 * 60) ? 100 : 0,
      };
    }));
    if (partial) break;
    nextPoolIndex = poolIndex + 1;
  }
  const byKey = new Map<string, RotationHistoryRecord>();
  for (const record of [...records, ...fallbackRecords]) byKey.set(historyRecordKey(record), record);
  return {
    records: [...byKey.values()],
    reports,
    errors,
    partial,
    nextPoolIndex,
    attemptedPools,
  };
}

export async function runEusdcRotationHistorySync(
  config: AppConfig,
  input: RotationHistorySyncInput = {},
): Promise<RotationHistorySyncResult> {
  const normalized = normalizeHistorySyncInput(input);
  if (normalized.syncPurpose === "RECENT_SIGNAL_WINDOW") {
    return runEusdcRotationRecentRefresh(config, {
      lookbackMinutes: normalized.lookbackMinutes,
      candidateIds: normalized.candidateIds,
      maximumRuntimeMs: normalized.maximumRuntimeMs,
      maximumBlocksPerChunk: normalized.maximumBlocksPerChunk,
      maximumPoolsPerRun: normalized.maximumPoolsPerRun,
      resumeToken: normalized.resumeToken,
      forceRecentBlockRecheck: normalized.forceRecentBlockRecheck,
    });
  }
  const nowMs = Date.now();
  const deadlineMs = nowMs + normalized.maximumRuntimeMs;
  const endTimestamp = Math.floor(nowMs / 1000);
  const startTimestamp = endTimestamp - normalized.lookbackMinutes * 60;
  const requestedStartTime = new Date(startTimestamp * 1000).toISOString();
  const requestedEndTime = new Date(endTimestamp * 1000).toISOString();
  const fetchedAt = new Date(nowMs).toISOString();
  const resolved = resolveEusdcRotationHistoryStorePath(config);
  const reviewCode = historyStoreReviewCode(config);
  const blockedResult = (
    okValue: boolean,
    code: RotationHistorySyncResult["code"],
    reason: string,
    lockStatus: RotationHistoryCrossProcessLockStatus = "not_checked",
  ): RotationHistorySyncResult => {
    const diagnostics = historyPathDiagnostics(config, lockStatus);
    return {
      ok: okValue,
      code,
      reason,
      maximumRuntimeMs: normalized.maximumRuntimeMs,
      lookbackMinutes: normalized.lookbackMinutes,
      requestedStartTime,
      requestedEndTime,
      recordsAdded: 0,
      recordsUpdated: 0,
      duplicateRecordsIgnored: 0,
      earliestTimestamp: null,
      latestTimestamp: null,
      sourceCompleteness: [],
      unresolvedGaps: [],
      syncPurpose: normalized.syncPurpose,
      blocksScanned: 0,
      rangesCompleted: 0,
      rangesWithZeroLogs: 0,
      recordsRetrieved: 0,
      checkpointAdvanced: false,
      repositoryRoot: diagnostics.repositoryRoot,
      currentWorkingDirectory: diagnostics.currentWorkingDirectory,
      historyStoreDirectory: diagnostics.historyStoreDirectory,
      historyStorePath: diagnostics.historyStorePath,
      historyStorePathSource: diagnostics.historyStorePathSource,
      pathMatchesExpectedRepositoryLocalDefault: diagnostics.pathMatchesExpectedRepositoryLocalDefault,
      legacyCwdDerivedStorePath: diagnostics.legacyCwdDerivedStorePath,
      legacyCwdDerivedStoreExists: diagnostics.legacyCwdDerivedStoreExists,
      legacyStoreRecordCount: diagnostics.legacyStoreRecordCount,
      activeStoreRecordCount: diagnostics.activeStoreRecordCount,
      crossProcessLockStatus: diagnostics.crossProcessLockStatus,
      historyStoreFingerprint: rotationHistoryFingerprint(readRotationHistoryStore(config)),
      quoteCallCount: 0,
      noPiteasQuoteUsed: true,
      noWalletWrite: true,
      noLiveTransaction: true,
    };
  };
  if (reviewCode !== "OK") {
    return blockedResult(false, reviewCode, "public history store path review is required before sync");
  }
  return withHistoryLock(resolved.path, async () => {
    let release: (() => RotationHistoryCrossProcessLockStatus) | null = null;
    try {
      const lock = acquireHistoryWriteLock(config);
      release = lock.release;
      if (historyRuntimeDeadlineReached(deadlineMs)) {
        const existing = readRotationHistoryStore(config);
        const historyStoreFingerprint = rotationHistoryFingerprint(existing);
        const resumeToken = fingerprint({
          requestedStartTime,
          requestedEndTime,
          nextCandidateIndex: 0,
          nextPoolIndex: 0,
          historyStoreFingerprint,
        });
        const checkpointUpdatedAt = new Date().toISOString();
        writeHistorySyncCheckpoint(config, {
          schemaVersion: HISTORY_CHECKPOINT_SCHEMA_VERSION,
          resumeToken,
          syncPurpose: normalized.syncPurpose,
          requestedWindow: {
            startTime: requestedStartTime,
            endTime: requestedEndTime,
            lookbackMinutes: normalized.lookbackMinutes,
          },
          storePath: resolved.path,
          chainId: existing.chainId,
          candidateId: EUSDC_ROTATION_CANDIDATES[0]?.candidateId,
          sourceCursor: {
            candidateIndex: 0,
            poolIndex: 0,
          },
          completedBlockRanges: [],
          completedPools: [],
          storeFingerprintBeforeRun: historyStoreFingerprint,
          updatedAt: checkpointUpdatedAt,
        });
        const released = release();
        release = null;
        const diagnostics = historyPathDiagnostics(config, released);
        const timestamps = existing.records.map((record) => record.timestamp);
        return {
          ok: true,
          code: "PARTIAL_PROGRESS",
          reason: "maximumRuntimeMs reached before public history sync work started",
          resumeToken,
          checkpointPath: historySyncCheckpointPath(config),
          checkpointUpdatedAt,
          maximumRuntimeMs: normalized.maximumRuntimeMs,
          lookbackMinutes: normalized.lookbackMinutes,
          requestedStartTime,
          requestedEndTime,
          recordsAdded: 0,
          recordsUpdated: 0,
          duplicateRecordsIgnored: 0,
          earliestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.min(...timestamps)) : null,
          latestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.max(...timestamps)) : null,
          sourceCompleteness: [],
          unresolvedGaps: [],
          syncPurpose: normalized.syncPurpose,
          blocksScanned: 0,
          rangesCompleted: 0,
          rangesWithZeroLogs: 0,
          recordsRetrieved: 0,
          checkpointAdvanced: false,
          repositoryRoot: diagnostics.repositoryRoot,
          currentWorkingDirectory: diagnostics.currentWorkingDirectory,
          historyStoreDirectory: diagnostics.historyStoreDirectory,
          historyStorePath: diagnostics.historyStorePath,
          historyStorePathSource: diagnostics.historyStorePathSource,
          pathMatchesExpectedRepositoryLocalDefault: diagnostics.pathMatchesExpectedRepositoryLocalDefault,
          legacyCwdDerivedStorePath: diagnostics.legacyCwdDerivedStorePath,
          legacyCwdDerivedStoreExists: diagnostics.legacyCwdDerivedStoreExists,
          legacyStoreRecordCount: diagnostics.legacyStoreRecordCount,
          activeStoreRecordCount: diagnostics.activeStoreRecordCount,
          crossProcessLockStatus: diagnostics.crossProcessLockStatus,
          historyStoreFingerprint,
          quoteCallCount: 0,
          noPiteasQuoteUsed: true,
          noWalletWrite: true,
          noLiveTransaction: true,
        };
      }
      const runtimeConfig = boundedHistoryRequestConfig(config, deadlineMs);
      const chainId = await getChainId(runtimeConfig);
      let latestBlockNumber: bigint | undefined;
      try {
        latestBlockNumber = await getPublicClient(boundedHistoryRequestConfig(config, deadlineMs)).getBlockNumber();
      } catch {
        latestBlockNumber = undefined;
      }
      const existing = readRotationHistoryStore(config);
      const checkpointBefore = readHistorySyncCheckpoint(config);
      let resumeCheckpoint: RotationHistorySyncCheckpoint | null = null;
      if (normalized.resumeToken) {
        if (!checkpointBefore || checkpointBefore.resumeToken !== normalized.resumeToken) {
          return blockedResult(true, "CHECKPOINT_WINDOW_MISMATCH", "resume token does not match the active public-history checkpoint");
        }
        if (!checkpointWindowMatches({
          checkpoint: checkpointBefore,
          syncPurpose: normalized.syncPurpose,
          requestedStartTime,
          requestedEndTime,
          lookbackMinutes: normalized.lookbackMinutes,
          candidateIds: normalized.candidateIds,
          storePath: resolved.path,
          chainId,
        })) {
          return blockedResult(true, "CHECKPOINT_WINDOW_MISMATCH", "resume token belongs to a different sync purpose, window, candidate set, store path, or chain");
        }
        resumeCheckpoint = checkpointBefore;
      }
      const candidateSet = normalized.candidateIds
        ? new Set(normalized.candidateIds)
        : null;
      const candidates = EUSDC_ROTATION_CANDIDATES
        .map((candidate, index) => ({ candidate, index }))
        .filter((row) => candidateSet === null || candidateSet.has(row.candidate.candidateId));
      const resumeCandidateIndex = resumeCheckpoint?.sourceCursor?.candidateIndex ?? 0;
      const incoming: RotationHistoryRecord[] = [];
      const sourceCompleteness: RotationHistoryCandidateSyncStatus[] = [];
      const unresolvedGaps: string[] = [];
      let partial = false;
      let nextCandidateIndex = 0;
      let nextPoolIndex = 0;
      for (const { candidate, index: candidateIndex } of candidates) {
        if (candidateIndex < resumeCandidateIndex) continue;
        if (historyRuntimeDeadlineReached(deadlineMs)) {
          partial = true;
          nextCandidateIndex = candidateIndex;
          nextPoolIndex = 0;
          break;
        }
        const synced = await syncHistoryForCandidate({
          config,
          chainId,
          candidate,
          startTimestamp,
          endTimestamp,
          maximumBlocksPerChunk: normalized.maximumBlocksPerChunk,
          maximumPagesPerSource: normalized.maximumPagesPerSource,
          fetchedAt,
          existingStore: existing,
          deadlineMs,
          maximumPoolsPerRun: normalized.maximumPoolsPerRun,
          resumeCheckpoint,
        });
        incoming.push(...synced.records);
        const summary = summarizeCandidateSync({
          candidate,
          reports: synced.reports,
          records: synced.records,
          existingRecords: existing.records.filter((record) => record.candidateId === candidate.candidateId),
          requestedStartTime,
          requestedEndTime,
          forceRecentBlockRecheck: normalized.forceRecentBlockRecheck,
          latestBlockNumber,
          syncPurpose: normalized.syncPurpose,
        });
        sourceCompleteness.push(summary);
        unresolvedGaps.push(...summary.unresolvedGaps.map((gap) => `${candidate.candidateId}: ${gap}`));
        for (const err of synced.errors) unresolvedGaps.push(`${candidate.candidateId}: ${err}`);
        if (synced.partial) {
          partial = true;
          nextCandidateIndex = candidateIndex;
          nextPoolIndex = synced.nextPoolIndex;
          break;
        }
        nextCandidateIndex = candidateIndex + 1;
        nextPoolIndex = 0;
      }
      const merged = mergeRotationHistoryRecords({
        existing: existing.records,
        incoming,
        nowMs,
        retentionDays: existing.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
        protectedStartTimestamp: startTimestamp,
        forceRecentBlockRecheck: normalized.forceRecentBlockRecheck,
        latestBlockNumber,
      });
      const next: RotationHistoryFile = {
        schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
        chainId,
        updatedAt: fetchedAt,
        retentionDays: existing.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
        records: merged.records,
        lastSync: {
          syncPurpose: normalized.syncPurpose,
          requestedStartTime,
          requestedEndTime,
          historyStoreFingerprint: "0x0",
          candidates: sourceCompleteness,
        },
      };
      const historyStoreFingerprint = rotationHistoryFingerprint(next);
      next.lastSync = { ...next.lastSync!, historyStoreFingerprint };
      writeRotationHistoryStore(config, next);
      let resumeToken: string | undefined;
      let checkpointUpdatedAt: string | undefined;
      if (partial) {
        const pendingCandidate = sourceCompleteness.find((candidate) =>
          candidate.candidateId === EUSDC_ROTATION_CANDIDATES[nextCandidateIndex]?.candidateId
        );
        const pendingPool =
          pendingCandidate?.pools[nextPoolIndex] ??
          pendingCandidate?.pools.find((pool) => pool.truncationReason === "PARTIAL_PROGRESS") ??
          pendingCandidate?.pools.find((pool) => pool.nextResumeBlock) ??
          null;
        resumeToken = fingerprint({
          requestedStartTime,
          requestedEndTime,
          nextCandidateIndex,
          nextPoolIndex,
          historyStoreFingerprint,
        });
        checkpointUpdatedAt = new Date().toISOString();
        writeHistorySyncCheckpoint(config, {
          schemaVersion: HISTORY_CHECKPOINT_SCHEMA_VERSION,
          resumeToken,
          syncPurpose: normalized.syncPurpose,
          requestedWindow: {
            startTime: requestedStartTime,
            endTime: requestedEndTime,
            lookbackMinutes: normalized.lookbackMinutes,
          },
          storePath: resolved.path,
          chainId,
          candidateIds: candidates.map((row) => row.candidate.candidateId),
          candidateId: EUSDC_ROTATION_CANDIDATES[nextCandidateIndex]?.candidateId,
          ...(pendingPool ? { poolAddress: pendingPool.poolAddress } : {}),
          ...(pendingPool?.nextResumeBlock ? { nextBlock: pendingPool.nextResumeBlock } : {}),
          sourceCursor: {
            candidateIndex: nextCandidateIndex,
            poolIndex: nextPoolIndex,
          },
          completedBlockRanges: [
            ...(resumeCheckpoint?.completedBlockRanges ?? []),
            ...sourceCompleteness.flatMap((candidate) =>
              candidate.pools
                .filter((pool) => pool.scannedFromBlock && pool.scannedToBlock)
                .map((pool) => ({
                  candidateId: candidate.candidateId,
                  poolAddress: pool.poolAddress,
                  sourceVersion: pool.sourceVersion ?? ("UNKNOWN" as RotationHistorySourceVersion),
                  fromBlock: String(pool.scannedFromBlock),
                  toBlock: String(pool.scannedToBlock),
                })),
            ),
          ],
          completedPools: [
            ...(resumeCheckpoint?.completedPools ?? []),
            ...sourceCompleteness.flatMap((candidate) =>
              candidate.pools
                .filter((pool) => pool.rangeFullyScanned || pool.truncationReason === "NONE")
                .map((pool) => ({
                  candidateId: candidate.candidateId,
                  poolAddress: pool.poolAddress,
                  sourceVersion: pool.sourceVersion ?? ("UNKNOWN" as RotationHistorySourceVersion),
                })),
            ),
          ],
          storeFingerprintBeforeRun: rotationHistoryFingerprint(existing),
          updatedAt: checkpointUpdatedAt,
        });
      } else {
        clearHistorySyncCheckpoint(config);
      }
      const released = release();
      release = null;
      const diagnostics = historyPathDiagnostics(config, released);
      const timestamps = next.records.map((record) => record.timestamp);
      return {
        ok: true,
        code: partial ? "PARTIAL_PROGRESS" : "COMPLETE",
        ...(partial ? { reason: "maximumRuntimeMs reached before all public history pools completed" } : {}),
        ...(resumeToken ? { resumeToken } : {}),
        checkpointPath: historySyncCheckpointPath(config),
        ...(checkpointUpdatedAt ? { checkpointUpdatedAt } : {}),
        maximumRuntimeMs: normalized.maximumRuntimeMs,
        lookbackMinutes: normalized.lookbackMinutes,
        requestedStartTime,
        requestedEndTime,
        recordsAdded: merged.added,
        recordsUpdated: merged.updated,
        duplicateRecordsIgnored: merged.duplicates,
        earliestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.min(...timestamps)) : null,
        latestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.max(...timestamps)) : null,
        sourceCompleteness,
        unresolvedGaps: [...new Set(unresolvedGaps)],
        syncPurpose: normalized.syncPurpose,
        repositoryRoot: diagnostics.repositoryRoot,
        currentWorkingDirectory: diagnostics.currentWorkingDirectory,
        historyStoreDirectory: diagnostics.historyStoreDirectory,
        historyStorePath: diagnostics.historyStorePath,
        historyStorePathSource: diagnostics.historyStorePathSource,
        pathMatchesExpectedRepositoryLocalDefault: diagnostics.pathMatchesExpectedRepositoryLocalDefault,
        legacyCwdDerivedStorePath: diagnostics.legacyCwdDerivedStorePath,
        legacyCwdDerivedStoreExists: diagnostics.legacyCwdDerivedStoreExists,
        legacyStoreRecordCount: diagnostics.legacyStoreRecordCount,
        activeStoreRecordCount: diagnostics.activeStoreRecordCount,
        crossProcessLockStatus: diagnostics.crossProcessLockStatus,
        historyStoreFingerprint,
        quoteCallCount: 0,
        noPiteasQuoteUsed: true,
        noWalletWrite: true,
        noLiveTransaction: true,
      };
    } catch (err) {
      if (err instanceof HistorySyncBusyError) {
        return blockedResult(false, "HISTORY_SYNC_BUSY", err.message, err.status);
      }
      throw err;
    } finally {
      if (release) release();
    }
  });
}

export async function runEusdcRotationRecentRefresh(
  config: AppConfig,
  input: RotationRecentRefreshInput = {},
): Promise<RotationRecentRefreshResult> {
  const normalized = normalizeRecentRefreshInput(input);
  const nowMs = Date.now();
  const deadlineMs = nowMs + normalized.maximumRuntimeMs;
  const checkpointBeforeWindow = normalized.resumeToken ? readHistorySyncCheckpoint(config) : null;
  const resumeWindow = checkpointBeforeWindow &&
    checkpointBeforeWindow.resumeToken === normalized.resumeToken &&
    (checkpointBeforeWindow.syncPurpose ?? "HISTORICAL_BACKFILL") === "RECENT_SIGNAL_WINDOW"
      ? checkpointBeforeWindow.requestedWindow
      : null;
  const endTimestamp = resumeWindow
    ? Math.floor(Date.parse(resumeWindow.endTime) / 1000)
    : Math.floor(nowMs / 1000);
  const startTimestamp = resumeWindow
    ? Math.floor(Date.parse(resumeWindow.startTime) / 1000)
    : endTimestamp - normalized.lookbackMinutes * 60;
  const requestedStartTime = new Date(startTimestamp * 1000).toISOString();
  const requestedEndTime = new Date(endTimestamp * 1000).toISOString();
  const fetchedAt = new Date(nowMs).toISOString();
  const resolvedStore = resolveEusdcRotationHistoryStorePath(config);
  const reviewCode = historyStoreReviewCode(config);
  const blockedResult = (
    okValue: boolean,
    code: RotationHistorySyncResult["code"],
    reason: string,
    lockStatus: RotationHistoryCrossProcessLockStatus = "not_checked",
    extras: Partial<RotationRecentRefreshResult> = {},
  ): RotationRecentRefreshResult => {
    const diagnostics = historyPathDiagnostics(config, lockStatus);
    const store = readRotationHistoryStore(config);
    return {
      ok: okValue,
      code,
      reason,
      maximumRuntimeMs: normalized.maximumRuntimeMs,
      lookbackMinutes: normalized.lookbackMinutes,
      requestedStartTime,
      requestedEndTime,
      recordsAdded: 0,
      recordsUpdated: 0,
      duplicateRecordsIgnored: 0,
      earliestTimestamp: null,
      latestTimestamp: null,
      sourceCompleteness: [],
      unresolvedGaps: [],
      syncPurpose: "RECENT_SIGNAL_WINDOW",
      tipRefreshMinutes: normalized.tipRefreshMinutes,
      phase: "TIP_REFRESH",
      anchorTipComplete: false,
      anchorLatestBlock: null,
      anchorLatestTimestamp: null,
      anchorLagBlocks: null,
      anchorLagMinutes: null,
      blocksScanned: 0,
      rangesCompleted: 0,
      rangesWithZeroLogs: 0,
      recordsRetrieved: 0,
      checkpointAdvanced: false,
      repositoryRoot: diagnostics.repositoryRoot,
      currentWorkingDirectory: diagnostics.currentWorkingDirectory,
      historyStoreDirectory: diagnostics.historyStoreDirectory,
      historyStorePath: diagnostics.historyStorePath,
      historyStorePathSource: diagnostics.historyStorePathSource,
      pathMatchesExpectedRepositoryLocalDefault: diagnostics.pathMatchesExpectedRepositoryLocalDefault,
      legacyCwdDerivedStorePath: diagnostics.legacyCwdDerivedStorePath,
      legacyCwdDerivedStoreExists: diagnostics.legacyCwdDerivedStoreExists,
      legacyStoreRecordCount: diagnostics.legacyStoreRecordCount,
      activeStoreRecordCount: diagnostics.activeStoreRecordCount,
      crossProcessLockStatus: diagnostics.crossProcessLockStatus,
      historyStoreFingerprint: rotationHistoryFingerprint(store),
      quoteCallCount: 0,
      noPiteasQuoteUsed: true,
      noWalletWrite: true,
      noLiveTransaction: true,
      ...extras,
    };
  };
  if (reviewCode !== "OK") {
    return blockedResult(false, reviewCode, "public history store path review is required before recent refresh");
  }

  return withHistoryLock(resolvedStore.path, async () => {
    let release: (() => RotationHistoryCrossProcessLockStatus) | null = null;
    try {
      const lock = acquireHistoryWriteLock(config);
      release = lock.release;
      const runtimeConfig = boundedHistoryRequestConfig(config, deadlineMs);
      const existingAtStart = readRotationHistoryStore(config);
      const chainId = await getChainId(runtimeConfig);
      const checkpointBefore = readHistorySyncCheckpoint(config);
      let resumeCheckpoint: RotationHistorySyncCheckpoint | null = null;
      if (normalized.resumeToken) {
        if (!checkpointBefore || checkpointBefore.resumeToken !== normalized.resumeToken) {
          return blockedResult(
            true,
            "CHECKPOINT_WINDOW_MISMATCH",
            "resume token does not match the active public-history checkpoint",
            lock.acquiredStatus,
          );
        }
        if (!checkpointWindowMatches({
          checkpoint: checkpointBefore,
          syncPurpose: "RECENT_SIGNAL_WINDOW",
          requestedStartTime,
          requestedEndTime,
          lookbackMinutes: normalized.lookbackMinutes,
          candidateIds: normalized.candidateIds,
          storePath: resolvedStore.path,
          chainId,
        })) {
          return blockedResult(
            true,
            "CHECKPOINT_WINDOW_MISMATCH",
            "resume token belongs to a different recent-refresh purpose, window, candidate set, store path, or chain",
            lock.acquiredStatus,
          );
        }
        resumeCheckpoint = checkpointBefore;
      }

      const client = getPublicClient(runtimeConfig) as unknown as HistoryPublicClient;
      const latestBlockNumber = await client.getBlockNumber();
      const fullRange = resumeCheckpoint?.resolvedStartBlock && resumeCheckpoint.resolvedEndBlock
        ? {
            requestedStartTimestamp: startTimestamp,
            requestedEndTimestamp: endTimestamp,
            resolvedStartBlock: BigInt(resumeCheckpoint.resolvedStartBlock),
            resolvedEndBlock: BigInt(resumeCheckpoint.resolvedEndBlock),
            resolvedStartBlockTimestamp: startTimestamp,
            resolvedEndBlockTimestamp: endTimestamp,
            maximumTimestampResolutionErrorSeconds: 0,
            blockTimestampCache: new Map<bigint, { timestamp: number; hash: `0x${string}` | null }>(),
            searchCalls: 0,
          } satisfies TimestampBlockRangeResolution
        : await resolveTimestampBlockRange({
            client,
            startTimestamp,
            endTimestamp,
            latestBlock: latestBlockNumber,
            deadlineMs,
          });
      const tipStartTimestamp = Math.max(startTimestamp, endTimestamp - normalized.tipRefreshMinutes * 60);
      const tipRange = await resolveTimestampBlockRange({
        client,
        startTimestamp: tipStartTimestamp,
        endTimestamp,
        latestBlock: latestBlockNumber,
        deadlineMs,
      });
      const latestBlockInfo = await cachedBlockInfo(client, latestBlockNumber, fullRange.blockTimestampCache);
      const candidateSet = normalized.candidateIds ? new Set(normalized.candidateIds) : null;
      const candidates = EUSDC_ROTATION_CANDIDATES.filter((candidate) =>
        candidateSet === null || candidateSet.has(candidate.candidateId)
      );
      const poolsByCandidate = new Map<RotationCandidateId, RotationHistorySourcePoolRef[]>();
      const discoveryErrors: string[] = [];
      for (const candidate of candidates) {
        if (historyRuntimeDeadlineReached(deadlineMs)) break;
        const discovered = await fetchSourcePoolsForCandidate(config, candidate, deadlineMs);
        poolsByCandidate.set(candidate.candidateId, discovered.pools);
        discoveryErrors.push(...discovered.errors.map((error) => `${candidate.candidateId}: ${error}`));
      }
      const tasks = buildRecentSignalPoolTasks({ candidates, poolsByCandidate });
      if (tasks.length === 0) {
        return blockedResult(
          false,
          "SOURCE_ERROR",
          "no source pools were available for recent refresh",
          lock.acquiredStatus,
          { unresolvedGaps: discoveryErrors },
        );
      }

      let workingStore = existingAtStart;
      const reportsByCandidate = new Map<RotationCandidateId, RotationHistoryPoolSyncStatus[]>();
      if (
        workingStore.lastSync?.syncPurpose === "RECENT_SIGNAL_WINDOW" &&
        workingStore.lastSync.requestedStartTime === requestedStartTime &&
        workingStore.lastSync.requestedEndTime === requestedEndTime
      ) {
        for (const row of workingStore.lastSync.candidates) {
          reportsByCandidate.set(row.candidateId, [...row.pools]);
        }
      }
      let checkpoint: RotationHistorySyncCheckpoint = resumeCheckpoint ?? {
        schemaVersion: HISTORY_CHECKPOINT_SCHEMA_VERSION,
        resumeToken: fingerprint({
          syncPurpose: "RECENT_SIGNAL_WINDOW",
          requestedStartTime,
          requestedEndTime,
          candidateIds: candidates.map((candidate) => candidate.candidateId),
          storePath: resolvedStore.path,
          chainId,
          createdAt: fetchedAt,
        }),
        syncPurpose: "RECENT_SIGNAL_WINDOW",
        requestedWindow: {
          startTime: requestedStartTime,
          endTime: requestedEndTime,
          lookbackMinutes: normalized.lookbackMinutes,
        },
        resolvedStartBlock: fullRange.resolvedStartBlock.toString(),
        resolvedEndBlock: fullRange.resolvedEndBlock.toString(),
        candidateIds: candidates.map((candidate) => candidate.candidateId),
        requiredPoolSet: tasks
          .filter((task) => task.sourcePool.classification === "REQUIRED_PRICE_POOL")
          .map((task) => ({
            candidateId: task.candidateId,
            poolAddress: task.poolAddress,
            sourceVersion: task.sourceVersion,
          })),
        storePath: resolvedStore.path,
        chainId,
        phase: "TIP_REFRESH",
        completedBlockRanges: [],
        completedPools: [],
        sourceCursor: { candidateIndex: 0, poolIndex: 0, taskIndex: 0 },
        storeFingerprintBeforeRun: rotationHistoryFingerprint(existingAtStart),
        updatedAt: fetchedAt,
      };
      const progressFingerprintBefore = checkpoint.progressFingerprint ?? null;
      let phase: RotationRecentRefreshPhase = checkpoint.phase ?? "TIP_REFRESH";
      let taskIndex = checkpoint.sourceCursor?.taskIndex ?? checkpoint.sourceCursor?.candidateIndex ?? 0;
      let blocksScanned = 0;
      let rangesCompleted = 0;
      let rangesWithZeroLogs = 0;
      let recordsRetrieved = 0;
      let checkpointAdvanced = false;
      let recordsAdded = 0;
      let recordsUpdated = 0;
      let duplicateRecordsIgnored = 0;
      const unresolvedGaps = [...discoveryErrors];
      const anchorPoolAddress = tasks.find((task) => task.role === "WPLS_EUSDC_ANCHOR")?.poolAddress ?? null;
      const coverageForTask = (task: RotationRecentPoolTask, fromBlock: bigint, toBlock: bigint) =>
        completedBlockCoveragePercent({
          completedRanges: checkpoint.completedBlockRanges,
          candidateId: task.candidateId,
          poolAddress: task.poolAddress,
          sourceVersion: task.sourceVersion,
          fromBlock,
          toBlock,
        });
      const anchorTipComplete = () =>
        anchorPoolAddress !== null &&
        tasks
          .filter((task) => sameAddress(task.poolAddress, anchorPoolAddress))
          .some((task) => coverageForTask(task, tipRange.resolvedStartBlock, tipRange.resolvedEndBlock) >= 99.999);
      const updateReportCoverage = (task: RotationRecentPoolTask, report: RotationHistoryPoolSyncStatus) => {
        const signalCoverage = coverageForTask(task, fullRange.resolvedStartBlock, fullRange.resolvedEndBlock);
        const tipCoverage = coverageForTask(task, tipRange.resolvedStartBlock, tipRange.resolvedEndBlock);
        const fullComplete = signalCoverage >= 99.999;
        const tipComplete = tipCoverage >= 99.999;
        const anchorComplete = task.role === "CANDIDATE_WPLS" ? anchorTipComplete() : true;
        const latestSource = report.latestSourceTradeTimestamp ?? report.newestReturnedRecord;
        const recentTradesFound =
          latestSource !== null &&
          latestSource !== undefined &&
          Date.parse(latestSource) / 1000 >= endTimestamp - 30 * 60;
        return {
          ...report,
          rangeFullyScanned: fullComplete,
          boundaryCrossed: fullComplete,
          retrievalCompletenessPercent: signalCoverage,
          signalWindowCompletenessPercent: signalCoverage,
          tipCompletenessPercent: tipCoverage,
          truncationReason: fullComplete ? "NONE" as const : "PARTIAL_PROGRESS" as const,
          exactRemainingTruncationCause: fullComplete ? undefined : "PARTIAL_PROGRESS",
          tipFreshnessStatus: classifyTipFreshness({
            tipScanned: tipComplete,
            recentTradesFound,
            anchorComplete,
            requiredPoolComplete: task.sourcePool.classification === "REQUIRED_PRICE_POOL" ? tipComplete : true,
          }),
          nextResumeBlock: fullComplete ? null : report.nextResumeBlock,
        };
      };
      const writeCheckpoint = (nextCheckpoint: RotationHistorySyncCheckpoint) => {
        checkpoint = nextCheckpoint;
        writeHistorySyncCheckpoint(config, checkpoint);
      };
      const summarizeAll = (): RotationHistoryCandidateSyncStatus[] =>
        candidates.map((candidate) => summarizeCandidateSync({
          candidate,
          reports: reportsByCandidate.get(candidate.candidateId) ?? [],
          records: recordsForCandidate(workingStore, candidate, startTimestamp, endTimestamp),
          existingRecords: existingAtStart.records.filter((record) => record.candidateId === candidate.candidateId),
          requestedStartTime,
          requestedEndTime,
          forceRecentBlockRecheck: normalized.forceRecentBlockRecheck,
          latestBlockNumber,
          syncPurpose: "RECENT_SIGNAL_WINDOW",
        }));
      const persistStore = () => {
        const sourceCompleteness = summarizeAll();
        const next: RotationHistoryFile = {
          schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
          chainId,
          updatedAt: fetchedAt,
          retentionDays: workingStore.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
          records: workingStore.records,
          lastSync: {
            syncPurpose: "RECENT_SIGNAL_WINDOW",
            requestedStartTime,
            requestedEndTime,
            historyStoreFingerprint: "0x0",
            candidates: sourceCompleteness,
          },
        };
        const historyStoreFingerprint = rotationHistoryFingerprint(next);
        next.lastSync = { ...next.lastSync!, historyStoreFingerprint };
        writeRotationHistoryStore(config, next);
        workingStore = readRotationHistoryStore(config);
        return sourceCompleteness;
      };

      let attemptedRanges = 0;
      while (phase !== "SIGNAL_WINDOW_COMPLETE" && attemptedRanges < normalized.maximumPoolsPerRun) {
        if (historyRuntimeDeadlineReached(deadlineMs)) break;
        if (taskIndex >= tasks.length) {
          if (phase === "TIP_REFRESH") {
            phase = "SIGNAL_WINDOW_BACKFILL";
            taskIndex = 0;
            checkpoint = {
              ...checkpoint,
              phase,
              nextBlock: tipRange.resolvedStartBlock > fullRange.resolvedStartBlock
                ? (tipRange.resolvedStartBlock - 1n).toString()
                : undefined,
              sourceCursor: { candidateIndex: 0, poolIndex: 0, taskIndex: 0 },
              updatedAt: new Date().toISOString(),
            };
            continue;
          }
          phase = "SIGNAL_WINDOW_COMPLETE";
          break;
        }
        const task = tasks[taskIndex]!;
        let rangeFrom: bigint;
        let rangeTo: bigint;
        let nextBlockAfterSuccess: string | undefined;
        let nextTaskIndex = taskIndex + 1;
        if (phase === "TIP_REFRESH") {
          rangeFrom = tipRange.resolvedStartBlock;
          rangeTo = tipRange.resolvedEndBlock;
          const alreadyComplete = coverageForTask(task, rangeFrom, rangeTo) >= 99.999;
          if (alreadyComplete) {
            taskIndex += 1;
            continue;
          }
        } else {
          const high = checkpoint.nextBlock && checkpoint.sourceCursor?.taskIndex === taskIndex
            ? BigInt(checkpoint.nextBlock)
            : tipRange.resolvedStartBlock - 1n;
          if (high < fullRange.resolvedStartBlock) {
            taskIndex += 1;
            checkpoint = { ...checkpoint, nextBlock: undefined, sourceCursor: { candidateIndex: taskIndex, poolIndex: 0, taskIndex } };
            continue;
          }
          rangeTo = high;
          const chunkFrom = high - BigInt(Math.max(1, normalized.maximumBlocksPerChunk) - 1);
          rangeFrom = chunkFrom < fullRange.resolvedStartBlock ? fullRange.resolvedStartBlock : chunkFrom;
          if (rangeFrom > fullRange.resolvedStartBlock) {
            nextBlockAfterSuccess = (rangeFrom - 1n).toString();
            nextTaskIndex = taskIndex;
          }
        }
        checkpoint = {
          ...checkpoint,
          phase,
          candidateId: task.candidateId,
          poolAddress: task.poolAddress,
          lastAttemptedRange: {
            candidateId: task.candidateId,
            poolAddress: task.poolAddress,
            fromBlock: rangeFrom.toString(),
            toBlock: rangeTo.toString(),
          },
          sourceCursor: { candidateIndex: taskIndex, poolIndex: 0, taskIndex },
          nextBlock: phase === "SIGNAL_WINDOW_BACKFILL" ? rangeTo.toString() : undefined,
          updatedAt: new Date().toISOString(),
        };
        writeHistorySyncCheckpoint(config, checkpoint);
        const existingKeys = new Set(workingStore.records.map((record) => historyRecordKey(record)));
        const anchorObservations = observationsFromHistory(
          recordsForCandidate(workingStore, getRotationCandidate("PLS"), startTimestamp, endTimestamp),
        ).filter((obs) => obs.priceEusdc > 0);
        const scan = await scanV2SwapLogBlockRange({
          config,
          chainId,
          candidate: getRotationCandidate(task.candidateId),
          sourcePool: task.sourcePool,
          fromBlock: rangeFrom,
          toBlock: rangeTo,
          requestedStartTimestamp: startTimestamp,
          requestedEndTimestamp: endTimestamp,
          resolvedStartBlock: fullRange.resolvedStartBlock,
          resolvedEndBlock: fullRange.resolvedEndBlock,
          tipStartBlock: tipRange.resolvedStartBlock,
          tipEndBlock: tipRange.resolvedEndBlock,
          phase,
          fetchedAt,
          anchorObservations,
          anchorTipComplete: task.role === "CANDIDATE_WPLS" ? anchorTipComplete() : true,
          blockTimestampCache: fullRange.blockTimestampCache,
          existingKeys,
          deadlineMs,
        });
        unresolvedGaps.push(...scan.errors.map((error) => `${task.candidateId}: ${task.poolAddress}: ${error}`));
        if (scan.report.completedRangeScanned) {
          attemptedRanges += 1;
          blocksScanned += scan.report.blocksScanned ?? 0;
          rangesCompleted += 1;
          recordsRetrieved += scan.report.totalRecordsRetrieved;
          if (scan.report.totalRecordsRetrieved === 0) rangesWithZeroLogs += 1;
          const completedRange = completedRangeFromReport({
            candidateId: task.candidateId,
            report: scan.report,
            completedAt: new Date().toISOString(),
          });
          if (completedRange) {
            const appended = appendCompletedRecentRange({
              checkpoint,
              completedRange,
              phase,
              nextBlock: nextBlockAfterSuccess,
              taskIndex: nextTaskIndex,
              anchorTipComplete: anchorTipComplete(),
              updatedAt: new Date().toISOString(),
            });
            checkpointAdvanced = checkpointAdvanced || appended.advanced;
            writeCheckpoint(appended.checkpoint);
          }
          const updatedReport = updateReportCoverage(task, scan.report);
          const rows = reportsByCandidate.get(task.candidateId) ?? [];
          reportsByCandidate.set(task.candidateId, [
            ...rows.filter((row) =>
              !(
                sameAddress(row.poolAddress, updatedReport.poolAddress) &&
                row.sourceVersion === updatedReport.sourceVersion &&
                row.scannedFromBlock === updatedReport.scannedFromBlock &&
                row.scannedToBlock === updatedReport.scannedToBlock
              )
            ),
            updatedReport,
          ]);
          const merged = mergeRotationHistoryRecords({
            existing: workingStore.records,
            incoming: scan.records,
            nowMs,
            retentionDays: workingStore.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
            protectedStartTimestamp: startTimestamp,
            forceRecentBlockRecheck: normalized.forceRecentBlockRecheck,
            latestBlockNumber,
          });
          recordsAdded += merged.added;
          recordsUpdated += merged.updated;
          duplicateRecordsIgnored += merged.duplicates;
          workingStore = {
            ...workingStore,
            chainId,
            updatedAt: fetchedAt,
            retentionDays: workingStore.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
            records: merged.records,
          };
          persistStore();
          taskIndex = nextTaskIndex;
        } else {
          const rows = reportsByCandidate.get(task.candidateId) ?? [];
          reportsByCandidate.set(task.candidateId, [...rows, scan.report]);
          break;
        }
      }

      const sourceCompleteness = persistStore();
      const allTasksComplete = phase === "SIGNAL_WINDOW_COMPLETE" ||
        (phase === "SIGNAL_WINDOW_BACKFILL" && taskIndex >= tasks.length);
      const progressFingerprintAfter = rotationCheckpointProgressFingerprint({
        syncPurpose: "RECENT_SIGNAL_WINDOW",
        phase: allTasksComplete ? "SIGNAL_WINDOW_COMPLETE" : phase,
        candidateId: tasks[taskIndex]?.candidateId,
        poolAddress: tasks[taskIndex]?.poolAddress,
        nextBlock: checkpoint.nextBlock ?? null,
        completedBlockRanges: checkpoint.completedBlockRanges,
        anchorTipComplete: anchorTipComplete(),
      });
      const stalled = checkpointWouldStall({
        code: "PARTIAL_PROGRESS",
        previousProgressFingerprint: progressFingerprintBefore,
        nextProgressFingerprint: progressFingerprintAfter,
      });
      let code: RotationHistorySyncCode = allTasksComplete ? "COMPLETE" : stalled ? "CHECKPOINT_STALLED" : "PARTIAL_PROGRESS";
      let resumeToken: string | undefined;
      let checkpointUpdatedAt: string | undefined;
      if (code === "COMPLETE") {
        clearHistorySyncCheckpoint(config);
      } else {
        resumeToken = stalled && resumeCheckpoint ? resumeCheckpoint.resumeToken : fingerprint({
          syncPurpose: "RECENT_SIGNAL_WINDOW",
          requestedStartTime,
          requestedEndTime,
          phase,
          taskIndex,
          nextBlock: checkpoint.nextBlock ?? null,
          progressFingerprintAfter,
        });
        checkpointUpdatedAt = new Date().toISOString();
        writeCheckpoint({
          ...checkpoint,
          resumeToken,
          phase,
          sourceCursor: { candidateIndex: taskIndex, poolIndex: 0, taskIndex },
          progressFingerprint: progressFingerprintAfter,
          previousProgressFingerprint: progressFingerprintBefore ?? undefined,
          repeatedRange: stalled ? checkpoint.lastAttemptedRange : undefined,
          updatedAt: checkpointUpdatedAt,
        });
      }

      const released = release();
      release = null;
      const diagnostics = historyPathDiagnostics(config, released);
      const finalStore = readRotationHistoryStore(config);
      const historyStoreFingerprint = rotationHistoryFingerprint(finalStore);
      const timestamps = finalStore.records.map((record) => record.timestamp);
      const anchorRecords = anchorPoolAddress
        ? finalStore.records.filter((record) => sameAddress(record.poolAddress, anchorPoolAddress))
        : [];
      const latestAnchor = anchorRecords
        .filter((record) => record.blockNumber !== null)
        .sort((a, b) => BigInt(b.blockNumber!) > BigInt(a.blockNumber!) ? 1 : -1)[0];
      const anchorLatestBlock = latestAnchor?.blockNumber ?? null;
      const anchorLatestTimestamp = latestAnchor ? isoFromSeconds(latestAnchor.timestamp) : null;
      const anchorLagBlocks = anchorLatestBlock ? Number(latestBlockNumber - BigInt(anchorLatestBlock)) : null;
      const anchorLagMinutes = anchorLatestTimestamp
        ? round((latestBlockInfo.timestamp - Math.floor(Date.parse(anchorLatestTimestamp) / 1000)) / 60, 4)
        : null;
      return {
        ok: true,
        code,
        ...(code === "PARTIAL_PROGRESS" ? { reason: "recent signal-window refresh made bounded progress and returned before timeout" } : {}),
        ...(code === "CHECKPOINT_STALLED"
          ? {
              reason: "recent refresh checkpoint did not make effective block-range progress",
              repeatedRange: checkpoint.lastAttemptedRange,
            }
          : {}),
        ...(resumeToken ? { resumeToken } : {}),
        checkpointPath: historySyncCheckpointPath(config),
        ...(checkpointUpdatedAt ? { checkpointUpdatedAt } : {}),
        maximumRuntimeMs: normalized.maximumRuntimeMs,
        lookbackMinutes: normalized.lookbackMinutes,
        requestedStartTime,
        requestedEndTime,
        recordsAdded,
        recordsUpdated,
        duplicateRecordsIgnored,
        earliestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.min(...timestamps)) : null,
        latestTimestamp: timestamps.length > 0 ? isoFromSeconds(Math.max(...timestamps)) : null,
        sourceCompleteness,
        unresolvedGaps: [...new Set(unresolvedGaps)],
        syncPurpose: "RECENT_SIGNAL_WINDOW",
        tipRefreshMinutes: normalized.tipRefreshMinutes,
        phase: code === "COMPLETE" ? "SIGNAL_WINDOW_COMPLETE" : phase,
        anchorTipComplete: anchorTipComplete(),
        anchorLatestBlock,
        anchorLatestTimestamp,
        anchorLagBlocks,
        anchorLagMinutes,
        blocksScanned,
        rangesCompleted,
        rangesWithZeroLogs,
        recordsRetrieved,
        checkpointAdvanced,
        tipLagBlocksBefore: null,
        tipLagBlocksAfter: anchorLagBlocks,
        tipLagMinutesBefore: null,
        tipLagMinutesAfter: anchorLagMinutes,
        progressFingerprintBefore,
        progressFingerprintAfter,
        repositoryRoot: diagnostics.repositoryRoot,
        currentWorkingDirectory: diagnostics.currentWorkingDirectory,
        historyStoreDirectory: diagnostics.historyStoreDirectory,
        historyStorePath: diagnostics.historyStorePath,
        historyStorePathSource: diagnostics.historyStorePathSource,
        pathMatchesExpectedRepositoryLocalDefault: diagnostics.pathMatchesExpectedRepositoryLocalDefault,
        legacyCwdDerivedStorePath: diagnostics.legacyCwdDerivedStorePath,
        legacyCwdDerivedStoreExists: diagnostics.legacyCwdDerivedStoreExists,
        legacyStoreRecordCount: diagnostics.legacyStoreRecordCount,
        activeStoreRecordCount: diagnostics.activeStoreRecordCount,
        crossProcessLockStatus: diagnostics.crossProcessLockStatus,
        historyStoreFingerprint,
        quoteCallCount: 0,
        noPiteasQuoteUsed: true,
        noWalletWrite: true,
        noLiveTransaction: true,
      };
    } catch (err) {
      if (err instanceof HistorySyncBusyError) {
        return blockedResult(false, "HISTORY_SYNC_BUSY", err.message, err.status);
      }
      throw err;
    } finally {
      if (release) release();
    }
  });
}

function statusForCandidateFromStore(input: {
  store: RotationHistoryFile;
  candidate: RotationCandidateRegistryEntry;
  lookbackMinutes: number;
  candleMinutes: number;
  nowMs: number;
}): RotationHistoryCandidateStatus {
  const endTimestamp = Math.floor(input.nowMs / 1000);
  const startTimestamp = endTimestamp - input.lookbackMinutes * 60;
  const records = recordsForCandidate(input.store, input.candidate, startTimestamp, endTimestamp);
  const observations = observationsFromHistory(records);
  const candleResult = buildFiveMinuteCandles({
    observations,
    lookbackMinutes: input.lookbackMinutes,
    candleMinutes: input.candleMinutes,
    nowMs: input.nowMs,
  });
  const syncStatus = input.store.lastSync?.candidates.find((row) => row.candidateId === input.candidate.candidateId);
  const completeness = sourceCompletenessForRecords({
    records,
    startTimestamp,
    endTimestamp,
    syncStatus,
  });
  const routeConnected = syncStatus
    ? syncStatus.pools.some((pool) => pool.historicalPaginationReliable)
    : records.length > 0;
  const historyQuality = buildHistoryQuality({
    records,
    observations,
    coverage: candleResult.coverage,
    sourceCompletenessPercent: completeness.percent,
    sourceTruncated: completeness.truncated,
    unresolvedGaps: completeness.unresolvedGaps,
    routeConnected,
    liquidityPasses: records.length > 0,
    priceDispersionPercent: null,
    nowMs: input.nowMs,
    lookbackMinutes: input.lookbackMinutes,
    candleMinutes: input.candleMinutes,
  });
  const timestamps = records.map((record) => record.timestamp);
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : null;
  return {
    candidateId: input.candidate.candidateId,
    recordsStored: records.length,
    earliestRecord: isoFromSeconds(earliest),
    latestRecord: isoFromSeconds(latest),
    historyDurationMinutes: earliest !== null && latest !== null ? round((latest - earliest) / 60, 4) : 0,
    sourceCompletenessPercent: historyQuality.sourceCompletenessPercent,
    activeCandleCoveragePercent: historyQuality.activeTradeCandlePercent,
    priceContinuityPercent: historyQuality.priceContinuityPercent,
    analysisMode: historyQuality.analysisMode,
    latestTradeAgeMinutes: historyQuality.latestTradeAgeMinutes,
    unresolvedGaps: historyQuality.unresolvedGaps,
    tipFreshnessStatus: syncStatus?.tipFreshnessStatus ?? "TIP_NOT_SCANNED",
    tipCompletenessPercent: syncStatus?.tipCompletenessPercent ?? 0,
    currentSignalWindowCompletenessPercent:
      syncStatus?.signalWindowCompletenessPercent ?? historyQuality.sourceCompletenessPercent,
    sevenDayCompletenessPercent: syncStatus?.sevenDayCompletenessPercent ?? 0,
    latestSourceTradeAgeMinutes: syncStatus?.latestSourceTradeAgeMinutes,
    pipelineLagMinutes: syncStatus?.pipelineLagMinutes,
    requiredPoolsComplete: syncStatus?.requiredPoolsComplete ?? false,
    readinessForLiveScanning: historyQuality.readinessForLiveScanning,
  };
}

export async function runEusdcRotationHistoryStatus(
  config: AppConfig,
  input: { lookbackMinutes?: number; candleMinutes?: number } = {},
): Promise<RotationHistoryStatusResult> {
  const nowMs = Date.now();
  const lookbackMinutes = input.lookbackMinutes ?? DEFAULT_HISTORY_LOOKBACK_MINUTES;
  const candleMinutes = input.candleMinutes ?? DEFAULT_CANDLE_MINUTES;
  const lockPath = join(historyStoreDirectory(config), "market-history.lock");
  const diagnostics = historyPathDiagnostics(config, inspectHistoryWriteLock(lockPath));
  const store = readRotationHistoryStore(config);
  const historyStoreFingerprint = rotationHistoryFingerprint(store);
  return {
    ok: diagnostics.historyStoreReviewCode === "OK",
    ...(diagnostics.historyStoreReviewCode !== "OK"
      ? {
          code: diagnostics.historyStoreReviewCode,
          reason: "public history store path review is required",
        }
      : {}),
    checkedAt: new Date(nowMs).toISOString(),
    lookbackMinutes,
    candidates: EUSDC_ROTATION_CANDIDATES.map((candidate) =>
      statusForCandidateFromStore({
        store,
        candidate,
        lookbackMinutes,
        candleMinutes,
        nowMs,
      }),
    ),
    repositoryRoot: diagnostics.repositoryRoot,
    currentWorkingDirectory: diagnostics.currentWorkingDirectory,
    historyStoreDirectory: diagnostics.historyStoreDirectory,
    historyStorePath: diagnostics.historyStorePath,
    historyStorePathSource: diagnostics.historyStorePathSource,
    pathMatchesExpectedRepositoryLocalDefault: diagnostics.pathMatchesExpectedRepositoryLocalDefault,
    legacyCwdDerivedStorePath: diagnostics.legacyCwdDerivedStorePath,
    legacyCwdDerivedStoreExists: diagnostics.legacyCwdDerivedStoreExists,
    legacyStoreRecordCount: diagnostics.legacyStoreRecordCount,
    activeStoreRecordCount: diagnostics.activeStoreRecordCount,
    crossProcessLockStatus: diagnostics.crossProcessLockStatus,
    historyStoreFingerprint,
    quoteCallCount: 0,
    noPiteasQuoteUsed: true,
    noWalletWrite: true,
    noLiveTransaction: true,
  };
}

function marketMetricNumber(
  metrics: Record<string, RotationMetric<unknown> | RotationUnavailableMetric>,
  key: string,
): number | null {
  const value = metrics[key];
  if (!value || ("status" in value && value.status === "UNAVAILABLE")) return null;
  if (!("value" in value)) return null;
  return typeof value.value === "number" ? value.value : null;
}

async function defaultMarketEvidence(
  config: AppConfig,
  candidate: RotationCandidateRegistryEntry,
  input: Required<RotationScanInput>,
  eUsdcBalanceRaw: string,
): Promise<RotationMarketEvidence> {
  const endTimestamp = Math.floor(Date.now() / 1000);
  const startTimestamp = endTimestamp - input.lookbackMinutes * 60;
  const { pairs: mergedPairs, errors } = await fetchPairsForCandidate(config, candidate);
  const routeAvailabilityStatus = deriveRouteConnectivity({ candidate, pairs: mergedPairs });
  const anchor = findAnchorWplsEusdcPair(mergedPairs);
  const wplsPrice = deriveWplsEusdcPrice(anchor);
  const priceMap = new Map<string, number>([
    [EUSDC_ADDRESS.toLowerCase(), 1],
    ...(wplsPrice ? ([[WPLS_ADDRESS.toLowerCase(), wplsPrice]] as Array<[string, number]>) : []),
  ]);
  for (const pair of mergedPairs) {
    const p0 = pairPriceEusdc(pair, tokenId(pair.token0), priceMap);
    if (p0 && !priceMap.has(tokenId(pair.token0))) priceMap.set(tokenId(pair.token0), p0);
    const p1 = pairPriceEusdc(pair, tokenId(pair.token1), priceMap);
    if (p1 && !priceMap.has(tokenId(pair.token1))) priceMap.set(tokenId(pair.token1), p1);
  }
  const pairIds = selectedSwapPairIds(candidate, mergedPairs);
  const poolBytecode = await verifyPoolBytecode(config, pairIds);
  const consolidation = consolidateRotationPools({
    candidate,
    pairs: mergedPairs,
    priceMap,
    poolBytecode,
  });
  const historyStore = readRotationHistoryStore(config);
  const historySyncStatus = historyStore.lastSync?.candidates.find((row) => row.candidateId === candidate.candidateId);
  const historyRecords = recordsForCandidate(historyStore, candidate, startTimestamp, endTimestamp);
  let swaps: SubgraphSwap[] = [];
  let pageCount = 0;
  let truncated = false;
  let poolReports: RotationHistoryPoolSyncStatus[] = [];
  let observations: RotationPriceObservation[];
  const usingHistory = historyRecords.length > 0 || historySyncStatus !== undefined;
  if (usingHistory) {
    observations = observationsFromHistory(historyRecords);
    pageCount = historySyncStatus?.pools.reduce((sum, pool) => sum + Math.max(0, pool.maximumPageCount), 0) ?? 0;
    poolReports = historySyncStatus?.pools ?? [];
  } else {
    try {
      const paged = await fetchPairSwapsPaginated({
        config,
        candidateId: candidate.candidateId,
        pairIds,
        startTimestamp,
        endTimestamp,
        maxPagesPerPair: 4,
      });
      swaps = paged.swaps;
      pageCount = paged.pageCount;
      truncated = paged.truncated;
      poolReports = paged.poolReports;
      errors.push(...paged.errors);
    } catch (err) {
      errors.push(`paginated swaps: ${err instanceof Error ? err.message : String(err)}`);
    }
    const anchorObservations = buildAnchorObservations(swaps);
    observations = observationsForCandidate(candidate, swaps, anchorObservations);
  }
  const candleResult = buildFiveMinuteCandles({
    observations,
    lookbackMinutes: input.lookbackMinutes,
    candleMinutes: input.candleMinutes,
    nowMs: Date.now(),
  });
  const historyCompleteness = usingHistory
    ? sourceCompletenessForRecords({
        records: historyRecords,
        startTimestamp,
        endTimestamp,
        syncStatus: historySyncStatus,
      })
    : {
        percent: poolReports.length > 0
          ? round(poolReports.filter((report) =>
            report.boundaryCrossed ||
            report.truncationReason === "NONE" ||
            report.truncationReason === "SPARSE_ACTUAL_TRADING" ||
            report.truncationReason === "STALE_POOL",
          ).length / poolReports.length * 100, 4)
          : 0,
        unresolvedGaps: poolReports
          .filter((report) =>
            report.truncationReason !== "NONE" &&
            report.truncationReason !== "SPARSE_ACTUAL_TRADING" &&
            report.truncationReason !== "STALE_POOL",
          )
          .map((report) => `${report.poolAddress}: ${report.truncationReason}`),
        truncated,
      };
  truncated = truncated || historyCompleteness.truncated;
  candleResult.coverage.truncated = truncated;
  const analysis = analyzeRotationCandles({
    candles: candleResult.candles,
    scanInput: input,
    pageCount,
    truncated,
  });
  const uniqueTransactionCount = new Set(
    observations.map((obs) => obs.swapId.split(":")[0] || obs.swapId),
  ).size;
  const recentVolumeUsd = swapsVolume(swaps);
  const recentVolumeEusdc = observations.reduce((sum, obs) => sum + obs.volumeEusdc, 0);
  const largestPoolLiquidityEusdc = consolidation.largestPoolLiquidityEusdc;
  const aggregateLiquidityEusdc = consolidation.aggregateLiquidityEusdc;
  const latestTimestamp = observations[observations.length - 1]?.timestamp ?? null;
  const stale = latestTimestamp === null || endTimestamp - latestTimestamp > 30 * 60;
  const coverage = candleResult.coverage.coveragePercent;
  const historyQuality = buildHistoryQuality({
    records: usingHistory ? historyRecords : [],
    observations,
    coverage: candleResult.coverage,
    sourceCompletenessPercent: historyCompleteness.percent,
    sourceTruncated: truncated,
    unresolvedGaps: historyCompleteness.unresolvedGaps,
    routeConnected: isRouteConnected(routeAvailabilityStatus),
    liquidityPasses: aggregateLiquidityEusdc >= candidate.minimumLiquidityUsd,
    priceDispersionPercent: consolidation.priceDispersionPercent,
    nowMs: Date.now(),
    lookbackMinutes: input.lookbackMinutes,
    candleMinutes: input.candleMinutes,
  });
  candleResult.coverage.activeTradeCandlePercent = historyQuality.activeTradeCandlePercent;
  candleResult.coverage.sourceCompletenessPercent = historyQuality.sourceCompletenessPercent;
  candleResult.coverage.priceContinuityPercent = historyQuality.priceContinuityPercent;
  candleResult.coverage.analysisMode = historyQuality.analysisMode;
  candleResult.coverage.sparseMarketMethodUsed = historyQuality.analysisMode === "SPARSE_EVENT_TIME";
  candleResult.coverage.unresolvedGaps = historyQuality.unresolvedGaps;
  const enoughCoverage = historyQuality.analysisMode !== "UNUSABLE_HISTORY";
  const historyReversionRecords = usingHistory
    ? recordsForCandidate(
        historyStore,
        candidate,
        endTimestamp - DEFAULT_HISTORY_LOOKBACK_MINUTES * 60,
        endTimestamp,
      )
    : [];
  const targetObservations = historyReversionRecords.length > 0
    ? observationsFromHistory(historyReversionRecords)
    : observations;
  const economicFeasibility = computeScanEconomicFeasibility({
    startingEusdcRaw: eUsdcBalanceRaw,
    minimumNetTargetBps: input.minimumNetTargetBps,
    wplsPriceEusdc: wplsPrice,
  });
  const targetAwareReversion = buildTargetAwareReversion({
    observations: targetObservations,
    dipReboundEvidence: analysis.dipReboundEvidence,
    economicFeasibility,
    requestedNetTargetBps: input.minimumNetTargetBps,
    lookbackMinutes: historyReversionRecords.length > 0 ? DEFAULT_HISTORY_LOOKBACK_MINUTES : input.lookbackMinutes,
  });
  const metrics: Record<string, RotationMetric<unknown> | RotationUnavailableMetric> = {
    ...analysis.metrics,
    aggregateLiquidityEusdc: makeMetric({
      value: aggregateLiquidityEusdc,
      unit: "eusdc",
      source: "pool reserves * reserve-derived token prices",
      sourceTimestamp: isoFromSeconds(endTimestamp),
      startTimestamp: isoFromSeconds(startTimestamp),
      endTimestamp: isoFromSeconds(endTimestamp),
      sampleCount: consolidation.eligiblePools.length,
      pageCount: 0,
      truncated: false,
      coveragePercent: 100,
      stale: false,
      confidence: aggregateLiquidityEusdc > 0 ? "medium" : "none",
      warnings: consolidation.excludedPools.map((row) => `${row.pool}: ${row.reason}`),
    }),
    recentVolumeEusdc: makeMetric({
      value: round(recentVolumeEusdc, 6),
      unit: "eusdc",
      source: "paginated pair swaps converted to eUSDC",
      sourceTimestamp: isoFromSeconds(latestTimestamp),
      startTimestamp: isoFromSeconds(startTimestamp),
      endTimestamp: isoFromSeconds(endTimestamp),
      sampleCount: observations.length,
      pageCount,
      truncated,
      coveragePercent: coverage,
      stale,
      confidence: observations.length > 0 && !stale ? "medium" : "none",
      warnings: historyQuality.unresolvedGaps,
    }),
    sourceCompletenessPercent: makeMetric({
      value: historyQuality.sourceCompletenessPercent,
      unit: "percent",
      source: usingHistory ? "local public rotation history" : "live subgraph pagination diagnostics",
      sourceTimestamp: isoFromSeconds(latestTimestamp),
      startTimestamp: isoFromSeconds(startTimestamp),
      endTimestamp: isoFromSeconds(endTimestamp),
      sampleCount: observations.length,
      pageCount,
      truncated,
      coveragePercent: historyQuality.sourceCompletenessPercent,
      stale,
      confidence: historyQuality.sourceCompletenessPercent >= 95 ? "high" : "low",
      warnings: historyQuality.unresolvedGaps,
    }),
    priceContinuityPercent: makeMetric({
      value: historyQuality.priceContinuityPercent,
      unit: "percent",
      source: "bounded carry-forward continuity; not used to create dip/rebound signals",
      sourceTimestamp: isoFromSeconds(latestTimestamp),
      startTimestamp: isoFromSeconds(startTimestamp),
      endTimestamp: isoFromSeconds(endTimestamp),
      sampleCount: observations.length,
      pageCount,
      truncated,
      coveragePercent: historyQuality.priceContinuityPercent,
      stale,
      confidence: historyQuality.priceContinuityPercent > 0 ? "medium" : "none",
      warnings: [],
    }),
  };
  const fiveMinuteReturnBps = marketMetricNumber(metrics, "fiveMinuteReturnBps");
  const fifteenMinuteReturnBps = marketMetricNumber(metrics, "fifteenMinuteReturnBps");
  const oneHourReturnBps = marketMetricNumber(metrics, "oneHourReturnBps");
  const sixHourReturnBps = marketMetricNumber(metrics, "sixHourReturnBps");
  const distanceFromOneHourHighBps = marketMetricNumber(metrics, "distanceFromOneHourHighBps");
  const distanceFromOneHourLowBps = marketMetricNumber(metrics, "distanceFromOneHourLowBps");
  const reboundFromRecentLocalLowBps = marketMetricNumber(metrics, "reboundFromRecentLocalLowBps");
  const realizedVolatilityBps = marketMetricNumber(metrics, "realizedVolatilityBps");
  const tradeCount = observations.length;
  return {
    relevantPools: uniqueLower(mergedPairs.map((pair) => pair.id)),
    largestPoolLiquidityUsd: largestPoolLiquidityEusdc,
    aggregateLiquidityUsd: aggregateLiquidityEusdc,
    largestPoolLiquidityEusdc,
    aggregateLiquidityEusdc,
    recentVolumeUsd: recentVolumeEusdc || recentVolumeUsd,
    recentVolumeEusdc,
    tradeCount,
    uniqueTransactionCount,
    fiveMinuteReturnBps,
    fifteenMinuteReturnBps,
    oneHourReturnBps,
    sixHourReturnBps,
    distanceFromOneHourHighBps,
    distanceFromOneHourLowBps,
    reboundFromRecentLocalLowBps,
    realizedVolatilityBps,
    directionalTrendScore: analysis.directionalTrendScore,
    meanReversionScore: analysis.meanReversionScore,
    liquidityScore: Math.min(100, (aggregateLiquidityEusdc / Math.max(1, candidate.minimumLiquidityUsd)) * 50),
    volumeScore: Math.min(100, (recentVolumeEusdc / Math.max(1, candidate.minimumRecentVolumeUsd)) * 50),
    routeQualityScore:
      routeAvailabilityStatus === "DIRECT_POOL" ? 100 :
        routeAvailabilityStatus === "MULTIHOP_VIA_WPLS" ? 85 :
          routeAvailabilityStatus === "MULTIHOP_OTHER_VERIFIED" ? 70 : 0,
    volatilitySuitabilityScore: analysis.volatilitySuitabilityScore,
    estimatedPriceImpactPercent: estimatedImpactPercent(eUsdcBalanceRaw, largestPoolLiquidityEusdc),
    routeAvailabilityStatus,
    entryRouteAvailability: routeAvailabilityStatus,
    exitRouteAvailability: routeAvailabilityStatus,
    evidenceFresh: errors.length === 0 && tradeCount > 0 && !stale && enoughCoverage,
    dataSourceErrors: errors,
    poolsUsed: consolidation.eligiblePools,
    tokenPath:
      routeAvailabilityStatus === "MULTIHOP_VIA_WPLS"
        ? [candidate.baseAssetAddress.toLowerCase(), WPLS_ADDRESS.toLowerCase(), candidate.executionTokenAddress.toLowerCase()]
        : [candidate.baseAssetAddress.toLowerCase(), candidate.executionTokenAddress.toLowerCase()],
    metrics,
    candleCoverage: candleResult.coverage,
    dipReboundEvidence: analysis.dipReboundEvidence,
    historyQuality,
    targetAwareReversion,
    poolConsolidation: consolidation,
    dataSourcesUsed: [
      "PulseX V1/V2 pairs",
      usingHistory ? "local public rotation history" : "PulseX V2 paginated pair swaps",
      "PulseChain RPC bytecode/metadata",
    ],
    dataFreshness: stale ? "stale" : "fresh",
    diagnosticRankReason: enoughCoverage ? `${historyQuality.analysisMode} history available` : "unusable or incomplete history",
  };
}

export const defaultRotationDeps: RotationDeps = {
  nowMs: () => Date.now(),
  getChainId,
  getAgentWalletInfo,
  listAgentWallets,
  agentWalletSystemStatus,
  getTokenValidation: defaultTokenValidation,
  fetchCandidateMarketEvidence: defaultMarketEvidence,
  readTokenBalance: readErc20Balance,
  readTokenAllowance: readErc20Allowance,
  readNativeBalanceWei,
  getPiteasQuote,
  preparePiteasSwap,
  decodePiteasRouterSwapCalldata,
  inspectTokenNotional,
  buildAgentIntentView,
  simulateSameBlock: simulateSameBlockTwoRpc,
  getFeeData,
  proposeAgentTx,
  executeAgentTx,
  loadProposal: (config, proposalId) => loadProposal(config.agentWalletDir, proposalId),
  getTransactionReceipt,
};

function runtimeBlocked(
  config: AppConfig,
  status: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const ownership = status.walletDirOwnership as
    | { status?: unknown; foreignOwnerPid?: unknown; ownerPid?: unknown }
    | undefined;
  const ownershipStatus = typeof ownership?.status === "string" ? ownership.status : "ours";
  const foreignOwnerPid = ownership?.foreignOwnerPid;
  const multiProcessRisk = status.multiProcessRisk === true;
  const writesBlocked = status.writesBlocked === true;
  const agentWalletEnabled = status.agentWalletEnabled === true || config.agentWalletEnabled === true;
  const masterKeyConfigured = status.masterKeyConfigured === true;
  if (ownershipStatus !== "ours" && ownershipStatus !== "unknown") {
    return { ok: false, reason: `wallet ownership status is ${ownershipStatus}` };
  }
  if (foreignOwnerPid !== undefined && foreignOwnerPid !== null) {
    return { ok: false, reason: "foreign wallet owner PID present" };
  }
  if (multiProcessRisk) return { ok: false, reason: "multiProcessRisk=true" };
  if (writesBlocked) return { ok: false, reason: "writesBlocked=true" };
  if (!config.agentWalletMultiprocStrict) return { ok: false, reason: "AGENT_WALLET_MULTIPROC_STRICT is not enabled" };
  if (!agentWalletEnabled) return { ok: false, reason: "agent wallet mode disabled" };
  if (!masterKeyConfigured) return { ok: false, reason: "master key not configured" };
  return { ok: true };
}

async function getWalletForRotation(
  config: AppConfig,
  walletId: string,
  deps: RotationDeps,
): Promise<AgentWalletPublicInfo> {
  const wallet = await deps.getAgentWalletInfo(config, walletId, { includeBalance: true });
  if (!wallet.policy.enabled) throw new Error("wallet disabled");
  if (wallet.policy.killed) throw new Error("wallet killed");
  return wallet;
}

function getWalletForRotationReadOnly(
  config: AppConfig,
  walletId: string,
  deps: RotationDeps,
): AgentWalletPublicInfo {
  const wallet = deps.listAgentWallets(config).find((entry) => entry.id === walletId);
  if (!wallet) throw new Error("wallet not found");
  if (!wallet.policy.enabled) throw new Error("wallet disabled");
  if (wallet.policy.killed) throw new Error("wallet killed");
  return wallet;
}

export async function runEusdcRotationScan(
  config: AppConfig,
  input: RotationScanInput,
  deps: RotationDeps = defaultRotationDeps,
): Promise<RotationScanResult> {
  const scanInput = normalizeScanInput(input);
  const scannedAtMs = deps.nowMs();
  const scannedAt = new Date(scannedAtMs).toISOString();
  const expiresAt = new Date(scannedAtMs + SCAN_FRESHNESS_MS).toISOString();
  const ledger = readRotationLedger(config);
  const openCycle = getOpenRotationCycle(ledger, scanInput.walletId);
  const state: RotationCycleState = openCycle?.state ?? "EUSDC_IDLE";
  let walletAddress: `0x${string}` | undefined;
  let eUsdcBalanceRaw = "0";
  try {
    const wallet = getWalletForRotationReadOnly(config, scanInput.walletId, deps);
    walletAddress = wallet.address;
    eUsdcBalanceRaw = await deps.readTokenBalance(config, EUSDC_TOKEN_ADDRESS, wallet.address);
  } catch {
    // Keep the scan output complete; candidate rows will explain insufficient evidence.
  }

  const rows: RotationCandidateScanRow[] = [];
  for (const candidate of EUSDC_ROTATION_CANDIDATES) {
    let tokenValidation: RotationTokenValidation;
    let market: RotationMarketEvidence;
    try {
      tokenValidation = walletAddress
        ? await deps.getTokenValidation(config, candidate, walletAddress)
        : {
            chainId: PULSECHAIN_CHAIN_ID,
            codeExists: false,
            symbol: candidate.expectedSymbol,
            name: "",
            decimals: candidate.expectedDecimals,
            transferProbeOk: false,
            balanceOfReadable: false,
            allowanceReadable: false,
            routeToBaseAvailable: false,
            routeFromBaseAvailable: false,
            ok: false,
            rejectionReasons: ["wallet address unavailable"],
          };
      market = await deps.fetchCandidateMarketEvidence(
        config,
        candidate,
        scanInput,
        eUsdcBalanceRaw,
      );
    } catch (err) {
      tokenValidation = {
        chainId: PULSECHAIN_CHAIN_ID,
        codeExists: false,
        symbol: candidate.expectedSymbol,
        name: "",
        decimals: candidate.expectedDecimals,
        transferProbeOk: false,
        balanceOfReadable: false,
        allowanceReadable: false,
        routeToBaseAvailable: false,
        routeFromBaseAvailable: false,
        ok: false,
        rejectionReasons: ["token validation failed"],
      };
      market = {
        relevantPools: [],
        largestPoolLiquidityUsd: 0,
        aggregateLiquidityUsd: 0,
        recentVolumeUsd: 0,
        tradeCount: 0,
        fiveMinuteReturnBps: null,
        fifteenMinuteReturnBps: null,
        oneHourReturnBps: null,
        sixHourReturnBps: null,
        distanceFromOneHourHighBps: null,
        distanceFromOneHourLowBps: null,
        reboundFromRecentLocalLowBps: null,
        realizedVolatilityBps: null,
        directionalTrendScore: 0,
        meanReversionScore: 0,
        liquidityScore: 0,
        volumeScore: 0,
        routeQualityScore: 0,
        volatilitySuitabilityScore: 0,
        estimatedPriceImpactPercent: null,
        routeAvailabilityStatus: "none",
        evidenceFresh: false,
        dataSourceErrors: [err instanceof Error ? err.message : String(err)],
      };
    }
    rows.push(
      buildCandidateScanRow({
        candidate,
        tokenValidation,
        market,
        scanInput,
        state,
        hasOpenCycle: openCycle !== null,
      }),
    );
  }
  const selection = selectRotationWinner(rows);
  const wplsPrice =
    rows.find((row) => row.candidateId === "PLS")?.poolConsolidation?.consolidatedPriceEusdc ??
    null;
  const hasProductionMarketEvidence = rows.some((row) => row.poolConsolidation || row.metrics);
  const economicFeasibility = computeScanEconomicFeasibility({
    startingEusdcRaw: eUsdcBalanceRaw,
    minimumNetTargetBps: scanInput.minimumNetTargetBps,
    wplsPriceEusdc: wplsPrice,
  });
  const finalDecision =
    selection.decision === "CANDIDATE_SELECTED" &&
    hasProductionMarketEvidence &&
    !economicFeasibility.onePercentTargetEconomicallyPlausible
      ? "TARGET_ECONOMICALLY_INFEASIBLE"
      : selection.decision;
  const result: RotationScanResult = {
    ok: true,
    decision: finalDecision,
    walletId: scanInput.walletId,
    ...(walletAddress ? { walletAddress } : {}),
    state,
    scannedAt,
    expiresAt,
    scanFingerprint: fingerprint({
      scanInput,
      state,
      candidates: rows.map(stableScanPayload),
      selectionScope: selection.selectionScope,
      candidateReadiness: selection.candidateReadiness,
      readyCandidateIds: selection.readyCandidateIds,
      incompleteCandidateIds: selection.incompleteCandidateIds,
      selectionCandidateIds: selection.selectionCandidateIds,
      decision: finalDecision,
      winner: selection.winner ?? null,
      historyDecisionReason: selection.historyDecisionReason,
      economicFeasibility,
    }),
    quoteCallCount: quoteCounter.count,
    candidates: rows,
    ...(finalDecision === "CANDIDATE_SELECTED" && selection.winner ? { winner: selection.winner } : {}),
    rankedCandidateIds: finalDecision === "CANDIDATE_SELECTED" ? selection.rankedCandidateIds : [],
    diagnosticOrdering: selection.diagnosticOrdering,
    readyCandidateRanking: selection.readyCandidateRanking,
    eligibleCandidateRanking: selection.eligibleCandidateRanking,
    historyReady: selection.historyReady,
    readyCandidateIds: selection.readyCandidateIds,
    incompleteCandidateIds: selection.incompleteCandidateIds,
    selectionCandidateIds: selection.selectionCandidateIds,
    selectionScope: selection.selectionScope,
    candidateReadiness: selection.candidateReadiness,
    historyDecisionReason: selection.historyDecisionReason,
    ...(selection.tiedCandidateIds ? { tiedCandidateIds: selection.tiedCandidateIds } : {}),
    economicFeasibility,
    noPiteasQuoteUsed: true,
    noLiveTransaction: true,
    ...(finalDecision === "TARGET_ECONOMICALLY_INFEASIBLE"
      ? { reason: "dynamic gas-adjusted target makes a normal 1% cycle economically infeasible" }
      : selection.reason
        ? { reason: selection.reason }
        : {}),
  };
  lastScanByWallet.set(scanInput.walletId, result);
  return result;
}

function failureProposal(
  classification: Exclude<RotationProposalClassification, "READY_FOR_HUMAN_CONFIRMATION">,
  failureStage: string,
  reason: string,
  partial: Partial<RotationPiteasProposalOutput>,
): RotationPiteasProposalOutput {
  return {
    ok: false,
    classification,
    failureStage,
    reason,
    walletId: partial.walletId ?? "",
    leg: partial.leg ?? "entry",
    quoteCallCount: quoteCounter.count,
    readyForHumanConfirmation: false,
    ...partial,
  };
}

function selectedPiteasFields(params: {
  walletId: string;
  walletAddress: `0x${string}`;
  cycleId?: string;
  candidateId: RotationCandidateId;
  leg: "entry" | "exit";
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  inputAmountRaw: string;
  inputBalanceRaw: string;
  currentAllowanceRaw: string;
  minimumExecutableOutputFloorRaw?: string;
  maximumEstimatedGasCostPls?: string;
  quoteRequestedAt: string;
  quoteReceivedAt: string;
  quoteResponseTimeMs: number;
  quote: PiteasQuoteData;
  methodParameterFingerprint: `0x${string}`;
  checkpoints: Record<string, CalldataCheckpoint>;
  decoded?: PiteasTopLevelSwapIntent;
  review?: AgentIntentView;
  twoRpcSimulation?: RpcPinnedSimulationRow[];
  estimatedGas?: string;
  estimatedGasCostPls?: string;
  proposal?: TxProposalWithReview | TxProposal;
  savedProposalCalldataFingerprint?: `0x${string}`;
}): Partial<RotationPiteasProposalOutput> {
  const checkpoints = params.checkpoints;
  const allKnown = Object.values(checkpoints);
  const handoff = assertCalldataHandoffIntegrity(allKnown);
  const routeTokens = params.quote.route?.tokenPath ?? [];
  const intermediates = routeTokens
    .filter(
      (token) =>
        !sameAddress(token, params.tokenIn) &&
        !sameAddress(token, params.tokenOut) &&
        /^0x[a-fA-F0-9]{40}$/.test(token),
    )
    .map((token) => token.toLowerCase());
  return {
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    cycleId: params.cycleId,
    candidateId: params.candidateId,
    leg: params.leg,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    inputAmountRaw: params.inputAmountRaw,
    inputBalanceRaw: params.inputBalanceRaw,
    currentAllowanceRaw: params.currentAllowanceRaw,
    expectedOutputRaw: params.quote.amountOut,
    executableMinimumOutputRaw:
      params.decoded?.destinationMinimumAmountRaw ?? params.quote.amountOutMin,
    minimumExecutableOutputFloorRaw: params.minimumExecutableOutputFloorRaw,
    maximumEstimatedGasCostPls: params.maximumEstimatedGasCostPls,
    routeProtocols: routeProtocols(params.quote),
    routeIntermediates: uniqueLower(intermediates),
    quoteCallCount: quoteCounter.count,
    quoteRequestedAt: params.quoteRequestedAt,
    quoteReceivedAt: params.quoteReceivedAt,
    quoteResponseTimeMs: params.quoteResponseTimeMs,
    quoteResponseFingerprint: params.quote.responseFingerprint ?? fingerprint(params.quote),
    methodParameterFingerprint: params.methodParameterFingerprint,
    upstreamCalldataFingerprint: checkpoints.upstream?.fingerprint,
    preparedCalldataFingerprint: checkpoints.prepared?.fingerprint,
    decoderInputFingerprint: checkpoints.decoder?.fingerprint,
    walletInspectionInputFingerprint: checkpoints.walletInspection?.fingerprint,
    simulationInputFingerprint: checkpoints.simulation?.fingerprint,
    proposalInputFingerprint: checkpoints.proposal?.fingerprint,
    savedProposalCalldataFingerprint: params.savedProposalCalldataFingerprint,
    everyCalldataFingerprintMatched: handoff.ok,
    calldataByteLength: checkpoints.upstream?.byteLength,
    topLevelDecodeStatus: params.decoded?.topLevelDecodeStatus,
    canonicalReencodingStatus:
      params.decoded?.topLevelDecodeStatus === "PASSED_CANONICAL" &&
      params.decoded.viemCrossCheckStatus === "passed"
        ? "passed"
        : undefined,
    decodeKnowledge: params.review?.decodeKnowledge.status,
    agentGuidance: params.review?.agentGuidance,
    twoRpcSimulation: params.twoRpcSimulation,
    internalProposalSimulation: params.proposal?.simulation,
    estimatedGas: params.estimatedGas,
    estimatedGasCostPls: params.estimatedGasCostPls,
    proposalId: params.proposal?.id,
    proposalStatus: params.proposal?.status,
    proposalCreatedAt: params.proposal?.createdAt,
    proposalExpiresAt: params.proposal?.expiresAt,
  };
}

function quoteFailureClassification(result: Extract<PiteasQuoteResult, { ok: false }>) {
  if (/calldata|not even-length|missing methodParameters|malformed/i.test(result.reason)) {
    return "PITEAS_MALFORMED_CALLDATA" as const;
  }
  return "INFRASTRUCTURE_REQUOTE_REQUIRED" as const;
}

function reservePiteasQuoteSlot(nowMs: number): { ok: true } | { ok: false; reason: string } {
  while (
    quoteWindowTimestamps.length > 0 &&
    nowMs - quoteWindowTimestamps[0]! > PITEAS_QUOTE_RATE_WINDOW_MS
  ) {
    quoteWindowTimestamps.shift();
  }
  if (quoteWindowTimestamps.length >= PITEAS_QUOTE_RATE_LIMIT) {
    return {
      ok: false,
      reason: `Piteas quote rate limit reached: ${PITEAS_QUOTE_RATE_LIMIT}/${PITEAS_QUOTE_RATE_WINDOW_MS}ms`,
    };
  }
  quoteWindowTimestamps.push(nowMs);
  return { ok: true };
}

async function guardedPiteasProposal(input: {
  config: AppConfig;
  deps: RotationDeps;
  walletId: string;
  walletAddress: `0x${string}`;
  cycleId?: string;
  candidateId: RotationCandidateId;
  leg: "entry" | "exit";
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountRaw: string;
  inputBalanceRaw: string;
  currentAllowanceRaw: string;
  allowedSlippagePercent: number;
  maximumQuoteAgeMs: number;
  minimumExecutableOutputRaw?: string;
  maximumGasCostPls: string;
}): Promise<RotationPiteasProposalOutput> {
  const {
    config,
    deps,
    walletId,
    walletAddress,
    candidateId,
    leg,
    tokenIn,
    tokenOut,
    amountRaw,
    inputBalanceRaw,
    currentAllowanceRaw,
  } = input;
  const partial = {
    walletId,
    walletAddress,
    cycleId: input.cycleId,
    candidateId,
    leg,
    tokenIn,
    tokenOut,
    inputAmountRaw: amountRaw,
    inputBalanceRaw,
    currentAllowanceRaw,
    minimumExecutableOutputFloorRaw: input.minimumExecutableOutputRaw,
    maximumEstimatedGasCostPls: input.maximumGasCostPls,
  };
  try {
    const amount = decimalUint(amountRaw, "amountRaw");
    if (decimalUint(inputBalanceRaw, "inputBalanceRaw") < amount) {
      return failureProposal("INSUFFICIENT_BALANCE", "wallet_state", "insufficient input-token balance", partial);
    }
    if (decimalUint(currentAllowanceRaw, "currentAllowanceRaw") < amount) {
      return failureProposal(
        leg === "entry" ? "ENTRY_BOUNDED_APPROVAL_REQUIRED" : "EXIT_BOUNDED_APPROVAL_REQUIRED",
        "wallet_state",
        leg === "entry" ? "ENTRY_BOUNDED_APPROVAL_REQUIRED" : "EXIT_BOUNDED_APPROVAL_REQUIRED",
        {
          ...partial,
          verifiedSpender: ROUTER,
          requiredAllowanceRaw: amountRaw,
          unlimitedApproval: false,
        },
      );
    }
    if (!Number.isFinite(input.allowedSlippagePercent) || input.allowedSlippagePercent < 0 || input.allowedSlippagePercent > 0.5) {
      return failureProposal("INVALID_SLIPPAGE", "input_validation", "allowedSlippagePercent must be between 0 and 0.5", partial);
    }
    const gasLimitWei = positivePlainDecimalToWei(input.maximumGasCostPls, "maximumGasCostPls");
    const nativeBalance = decimalUint(await deps.readNativeBalanceWei(config, walletAddress), "nativeBalanceWei");
    if (nativeBalance < gasLimitWei) {
      return failureProposal("GAS_COST_ABOVE_LIMIT", "wallet_state", "PLS balance is below gas cap", partial);
    }

    const quoteRequestedMs = deps.nowMs();
    const quoteRequestedAt = new Date(quoteRequestedMs).toISOString();
    const quoteSlot = reservePiteasQuoteSlot(quoteRequestedMs);
    if (!quoteSlot.ok) {
      return failureProposal("INFRASTRUCTURE_REQUOTE_REQUIRED", "quote_rate_limit", quoteSlot.reason, {
        ...partial,
        quoteRequestedAt,
      });
    }
    quoteCounter.count += 1;
    const quote = await deps.getPiteasQuote(config, {
      tokenIn,
      tokenOut,
      amount: amountRaw,
      allowedSlippage: input.allowedSlippagePercent,
      account: walletAddress,
    });
    const quoteReceivedMs = deps.nowMs();
    const quoteReceivedAt = new Date(quoteReceivedMs).toISOString();
    if (!quote.ok) {
      return failureProposal(quoteFailureClassification(quote), "quote", quote.reason, {
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
      });
    }
    const quoteData = quote.data;
    const quoteFields = validateQuoteFields(quoteData, {
      tokenIn,
      tokenOut,
      amountRaw,
      walletAddress,
    });
    if (!quoteFields.ok) {
      return failureProposal("INFRASTRUCTURE_REQUOTE_REQUIRED", "quote_validation", quoteFields.reason, {
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
        quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
      });
    }
    const calldataValidation = validateExecutableCalldata({
      sourceField: "quote.data.methodParameters.calldata",
      calldata: quoteData.methodParameters.calldata,
      requiredSelector: PITEAS_ROUTER_SWAP_SELECTOR,
    });
    if (!calldataValidation.ok) {
      return failureProposal("PITEAS_MALFORMED_CALLDATA", "quote_calldata", calldataValidation.reason, {
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
        quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
      });
    }
    const checkpoints: Record<string, CalldataCheckpoint> = {
      upstream: buildCalldataCheckpoint("upstream", calldataValidation.calldata),
    };
    const methodParameterFingerprint = fingerprint(quoteData.methodParameters);
    const prepared: PiteasPrepareResult = deps.preparePiteasSwap(quoteData, { account: walletAddress });
    if (!prepared.ok) {
      return failureProposal("PITEAS_MALFORMED_CALLDATA", "prepare", prepared.reason, {
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
        quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
      });
    }
    checkpoints.prepared = buildCalldataCheckpoint("prepared", prepared.intent.data);
    const preparedHandoff = assertCalldataHandoffIntegrity([checkpoints.upstream, checkpoints.prepared]);
    if (!preparedHandoff.ok) {
      return failureProposal("CALLDATA_HANDOFF_MISMATCH", "prepare", preparedHandoff.reason, {
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
        upstreamCalldataFingerprint: checkpoints.upstream.fingerprint,
        preparedCalldataFingerprint: checkpoints.prepared.fingerprint,
        everyCalldataFingerprintMatched: false,
      });
    }
    if (!sameAddress(prepared.intent.to, ROUTER)) {
      return failureProposal("UNKNOWN_FAIL_CLOSED", "prepare", "prepared destination is not verified Piteas router", partial);
    }

    checkpoints.decoder = buildCalldataCheckpoint("decoder", prepared.intent.data);
    const decodedResult = deps.decodePiteasRouterSwapCalldata({
      to: prepared.intent.to,
      data: prepared.intent.data,
      valueWei: prepared.intent.valueWei,
    });
    if (!decodedResult.ok) {
      return failureProposal("PITEAS_MALFORMED_CALLDATA", "strict_decode", decodedResult.reason, {
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
        quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
      });
    }
    const decoded = decodedResult.intent;
    const decodedValidation = validateDecodedIntent(decoded, {
      tokenIn,
      tokenOut,
      amountRaw,
      walletAddress,
      valueWei: prepared.intent.valueWei,
    });
    if (!decodedValidation.ok) {
      return failureProposal("PITEAS_MALFORMED_CALLDATA", "strict_decode", decodedValidation.reason, {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
        }),
      });
    }
    if (
      input.minimumExecutableOutputRaw &&
      decimalUint(decoded.destinationMinimumAmountRaw, "destinationMinimumAmountRaw") <
        decimalUint(input.minimumExecutableOutputRaw, "minimumExecutableOutputRaw")
    ) {
      return failureProposal("MINIMUM_OUTPUT_BELOW_FLOOR", "strict_decode", "MINIMUM_OUTPUT_BELOW_FLOOR", {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
        }),
      });
    }
    checkpoints.walletInspection = buildCalldataCheckpoint("walletInspection", prepared.intent.data);
    const inspection = deps.inspectTokenNotional({
      to: prepared.intent.to,
      data: prepared.intent.data,
      valueWei: prepared.intent.valueWei,
    });
    const review = deps.buildAgentIntentView({
      to: prepared.intent.to,
      data: prepared.intent.data,
      valueWei: prepared.intent.valueWei,
      inspection,
    });
    const reviewValidation = validateWalletInspection(review, decoded);
    if (!reviewValidation.ok) {
      return failureProposal("PITEAS_MALFORMED_CALLDATA", "wallet_inspection", reviewValidation.reason, {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
        }),
      });
    }
    checkpoints.simulation = buildCalldataCheckpoint("simulation", prepared.intent.data);
    const handoffBeforeSimulation = assertCalldataHandoffIntegrity([
      checkpoints.upstream,
      checkpoints.prepared,
      checkpoints.decoder,
      checkpoints.walletInspection,
      checkpoints.simulation,
    ]);
    if (!handoffBeforeSimulation.ok) {
      return failureProposal("CALLDATA_HANDOFF_MISMATCH", "pre_simulation_handoff", handoffBeforeSimulation.reason, {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
        }),
      });
    }
    const twoRpcSimulation = await deps.simulateSameBlock(
      config,
      {
        from: walletAddress,
        to: prepared.intent.to,
        data: prepared.intent.data as `0x${string}`,
        valueWei: prepared.intent.valueWei,
      },
      true,
    );
    const simulationValidation = validateTwoRpcSimulation(
      twoRpcSimulation,
      true,
      input.minimumExecutableOutputRaw,
    );
    if (!simulationValidation.ok) {
      return failureProposal(
        simulationValidation.classification as Exclude<
          RotationProposalClassification,
          "READY_FOR_HUMAN_CONFIRMATION"
        >,
        "same_block_simulation",
        simulationValidation.reason,
        selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
        }),
      );
    }
    const gasEstimateBig = maxGasEstimate(twoRpcSimulation);
    if (gasEstimateBig === null) {
      return failureProposal("UNKNOWN_FAIL_CLOSED", "gas", "missing gas estimate after simulation", {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
        }),
      });
    }
    const gasCost = await estimateGasCost(deps, config, gasEstimateBig);
    if (gasCost.costWei > gasLimitWei) {
      return failureProposal("GAS_COST_ABOVE_LIMIT", "gas", "GAS_COST_ABOVE_LIMIT", {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
          estimatedGas: gasEstimateBig.toString(),
          estimatedGasCostPls: gasCost.costPls,
        }),
      });
    }
    checkpoints.proposal = buildCalldataCheckpoint("proposal", prepared.intent.data);
    const handoffBeforeProposal = assertCalldataHandoffIntegrity([
      checkpoints.upstream,
      checkpoints.prepared,
      checkpoints.decoder,
      checkpoints.walletInspection,
      checkpoints.simulation,
      checkpoints.proposal,
    ]);
    if (!handoffBeforeProposal.ok) {
      return failureProposal("CALLDATA_HANDOFF_MISMATCH", "pre_proposal_handoff", handoffBeforeProposal.reason, {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
          estimatedGas: gasEstimateBig.toString(),
          estimatedGasCostPls: gasCost.costPls,
        }),
      });
    }
    if (deps.nowMs() - quoteReceivedMs > input.maximumQuoteAgeMs) {
      return failureProposal("QUOTE_STALE", "quote_freshness", "quote stale before proposal creation", {
        ...selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
          estimatedGas: gasEstimateBig.toString(),
          estimatedGasCostPls: gasCost.costPls,
        }),
      });
    }
    const proposalExpiresAt = new Date(quoteReceivedMs + input.maximumQuoteAgeMs).toISOString();
    let proposal: TxProposalWithReview;
    try {
      proposal = await deps.proposeAgentTx(config, {
        walletId,
        to: prepared.intent.to,
        valuePls: prepared.intent.valuePls,
        data: prepared.intent.data as `0x${string}`,
        requireSimulationSuccess: true,
        proposalExpiresAt,
        provenance: {
          kind: leg === "entry" ? "eusdc_rotation_entry_v1" : "eusdc_rotation_exit_v1",
          cycleId: input.cycleId,
          candidateId,
          quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
          quoteReceivedAt,
          quoteCallCount: quoteCounter.count,
          calldataFingerprint: checkpoints.upstream.fingerprint,
          methodParameterFingerprint,
          calldataByteLength: checkpoints.upstream.byteLength,
          calldataFirst10: checkpoints.upstream.first10,
          calldataFinal10: checkpoints.upstream.final10,
          tokenIn,
          tokenOut,
          inputAmountRaw: amountRaw,
          inputBalanceRaw,
          currentAllowanceRaw,
          expectedOutputRaw: quoteData.amountOut,
          executableMinimumOutputRaw: decoded.destinationMinimumAmountRaw,
          minimumExecutableOutputFloorRaw: input.minimumExecutableOutputRaw,
          maximumEstimatedGasCostPls: input.maximumGasCostPls,
          router: ROUTER,
          walletRecipient: walletAddress,
          routeProtocols: routeProtocols(quoteData),
          routeIntermediates: uniqueLower(
            (quoteData.route?.tokenPath ?? []).filter(
              (token) =>
                !sameAddress(token, tokenIn) &&
                !sameAddress(token, tokenOut) &&
                /^0x[a-fA-F0-9]{40}$/.test(token),
            ),
          ),
          residualUncertainty: decoded.residualUncertainty,
        },
      });
    } catch (err) {
      return failureProposal(
        "PROPOSAL_INTERNAL_SIMULATION_FAILED",
        "proposal_internal_simulation",
        err instanceof Error ? err.message : String(err),
        selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
          estimatedGas: gasEstimateBig.toString(),
          estimatedGasCostPls: gasCost.costPls,
        }),
      );
    }
    const saved = deps.loadProposal(config, proposal.id);
    const savedCheckpoint = buildCalldataCheckpoint("savedProposal", saved.data);
    checkpoints.savedProposal = savedCheckpoint;
    const savedHandoff = assertCalldataHandoffIntegrity([
      checkpoints.upstream,
      checkpoints.proposal,
      savedCheckpoint,
    ]);
    const savedIntegrityOk =
      savedHandoff.ok &&
      sameAddress(saved.to, prepared.intent.to) &&
      saved.valueWei === prepared.intent.valueWei &&
      saved.walletId === walletId &&
      sameAddress(saved.from, walletAddress) &&
      saved.status === "pending" &&
      saved.expiresAt === proposalExpiresAt;
    if (!savedIntegrityOk) {
      return failureProposal(
        "SAVED_PROPOSAL_INTEGRITY_MISMATCH",
        "saved_proposal_integrity",
        savedHandoff.ok ? "saved proposal fields do not match prepared transaction" : savedHandoff.reason,
        selectedPiteasFields({
          ...partial,
          quoteRequestedAt,
          quoteReceivedAt,
          quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
          estimatedGas: gasEstimateBig.toString(),
          estimatedGasCostPls: gasCost.costPls,
          proposal: saved,
          savedProposalCalldataFingerprint: savedCheckpoint.fingerprint,
        }),
      );
    }
    const ready =
      proposal.simulation.ok &&
      saved.status === "pending" &&
      Date.parse(saved.expiresAt) > deps.nowMs() &&
      review.decodeKnowledge.status === "known_top_level_with_opaque_route" &&
      review.agentGuidance === "review_carefully";
    return {
      ok: true,
      classification: "READY_FOR_HUMAN_CONFIRMATION",
      ...selectedPiteasFields({
        ...partial,
        quoteRequestedAt,
        quoteReceivedAt,
        quoteResponseTimeMs: quoteReceivedMs - quoteRequestedMs,
        quote: quoteData,
        methodParameterFingerprint,
        checkpoints,
        decoded,
        review,
        twoRpcSimulation,
        estimatedGas: gasEstimateBig.toString(),
        estimatedGasCostPls: gasCost.costPls,
        proposal,
        savedProposalCalldataFingerprint: savedCheckpoint.fingerprint,
      }),
      walletId,
      leg,
      quoteCallCount: quoteCounter.count,
      readyForHumanConfirmation: ready,
    };
  } catch (err) {
    return failureProposal("UNKNOWN_FAIL_CLOSED", "unexpected", err instanceof Error ? err.message : String(err), partial);
  }
}

export async function runEusdcRotationProposeEntry(
  config: AppConfig,
  input: {
    walletId: string;
    expectedCandidateId: RotationCandidateId;
    scanFingerprint: string;
    maximumQuoteAgeMs?: number;
    allowedSlippagePercent?: number;
    maximumGasCostPls?: string;
    useFullEusdcBalance?: boolean;
  },
  deps: RotationDeps = defaultRotationDeps,
): Promise<RotationPiteasProposalOutput> {
  return withWalletLock(input.walletId, async () => {
    const scan = lastScanByWallet.get(input.walletId);
    const leg = "entry" as const;
    if (!scan) {
      return failureProposal("SCAN_NOT_FOUND", "scan", "no fresh scan is available in this MCP process", {
        walletId: input.walletId,
        leg,
      });
    }
    if (scan.scanFingerprint !== input.scanFingerprint) {
      return failureProposal("SCAN_FINGERPRINT_MISMATCH", "scan", "scan fingerprint mismatch", {
        walletId: input.walletId,
        leg,
      });
    }
    if (Date.parse(scan.expiresAt) <= deps.nowMs()) {
      return failureProposal("SCAN_STALE", "scan", "scan expired", {
        walletId: input.walletId,
        leg,
      });
    }
    if (scan.decision !== "CANDIDATE_SELECTED" || scan.winner !== input.expectedCandidateId) {
      return failureProposal("CANDIDATE_MISMATCH", "scan", "expected candidate is not the scan winner", {
        walletId: input.walletId,
        leg,
      });
    }
    const status = deps.agentWalletSystemStatus(config);
    const runtime = runtimeBlocked(config, status);
    if (!runtime.ok) {
      return failureProposal("WALLET_RUNTIME_BLOCKED", "wallet_runtime", runtime.reason, {
        walletId: input.walletId,
        leg,
      });
    }
    const wallet = await getWalletForRotation(config, input.walletId, deps);
    const chainId = await deps.getChainId(config);
    if (chainId !== PULSECHAIN_CHAIN_ID) {
      return failureProposal("WALLET_RUNTIME_BLOCKED", "wallet_runtime", `chain ID ${chainId} is not 369`, {
        walletId: input.walletId,
        walletAddress: wallet.address,
        leg,
      });
    }
    const ledger = readRotationLedger(config);
    if (getOpenRotationCycle(ledger, input.walletId)) {
      return failureProposal("OPEN_POSITION_EXISTS", "ledger", "one open cycle already exists", {
        walletId: input.walletId,
        walletAddress: wallet.address,
        leg,
      });
    }
    const candidate = getRotationCandidate(input.expectedCandidateId);
    const validation = await deps.getTokenValidation(config, candidate, wallet.address);
    if (!validation.ok) {
      return failureProposal("TOKEN_VALIDATION_FAILED", "token_validation", validation.rejectionReasons.join("; "), {
        walletId: input.walletId,
        walletAddress: wallet.address,
        candidateId: input.expectedCandidateId,
        leg,
      });
    }
    const eUsdcBalanceRaw = await deps.readTokenBalance(config, EUSDC_TOKEN_ADDRESS, wallet.address);
    if (decimalUint(eUsdcBalanceRaw, "eUsdcBalanceRaw") <= 0n) {
      return failureProposal("INSUFFICIENT_BALANCE", "wallet_state", "eUSDC balance is zero", {
        walletId: input.walletId,
        walletAddress: wallet.address,
        candidateId: input.expectedCandidateId,
        leg,
      });
    }
    if (input.useFullEusdcBalance === false) {
      return failureProposal("UNKNOWN_FAIL_CLOSED", "input_validation", "version 1 only supports full eUSDC balance entries", {
        walletId: input.walletId,
        walletAddress: wallet.address,
        candidateId: input.expectedCandidateId,
        leg,
      });
    }
    const allowanceRaw = await deps.readTokenAllowance(config, EUSDC_TOKEN_ADDRESS, wallet.address, ROUTER);
    const cycleId = generateCycleId(deps.nowMs(), input.walletId, input.expectedCandidateId);
    const proposal = await guardedPiteasProposal({
      config,
      deps,
      walletId: input.walletId,
      walletAddress: wallet.address,
      cycleId,
      candidateId: input.expectedCandidateId,
      leg,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: candidate.executionTokenAddress,
      amountRaw: eUsdcBalanceRaw,
      inputBalanceRaw: eUsdcBalanceRaw,
      currentAllowanceRaw: allowanceRaw,
      allowedSlippagePercent: input.allowedSlippagePercent ?? DEFAULT_ALLOWED_SLIPPAGE_PERCENT,
      maximumQuoteAgeMs: input.maximumQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS,
      maximumGasCostPls: input.maximumGasCostPls ?? candidate.maximumGasCostPlsPerLeg,
    });
    if (proposal.ok && proposal.proposalId) {
      const nextLedger = readRotationLedger(config);
      if (getOpenRotationCycle(nextLedger, input.walletId)) {
        return failureProposal("OPEN_POSITION_EXISTS", "ledger", "open cycle appeared before ledger write", proposal);
      }
      nextLedger.cycles.push({
        cycleId,
        walletId: input.walletId,
        state: "ENTRY_PROPOSAL_READY",
        cycleStartTime: new Date(deps.nowMs()).toISOString(),
        startingEusdcRaw: eUsdcBalanceRaw,
        selectedCandidate: input.expectedCandidateId,
        candidateTokenAddress: candidate.executionTokenAddress,
        entrySignalEvidence: {
          scanFingerprint: scan.scanFingerprint,
          selectedCandidate: scan.winner,
          rankedCandidateIds: scan.rankedCandidateIds,
        },
        entryQuoteFingerprint: proposal.quoteResponseFingerprint,
        entryProposalId: proposal.proposalId,
        exitTargetRaw: computeSimpleBalanceTargetRaw(eUsdcBalanceRaw),
      });
      writeRotationLedger(config, nextLedger);
    }
    return proposal;
  });
}

function proposalProvenanceKind(proposal: TxProposal): string | undefined {
  const kind = proposal.provenance?.kind;
  return typeof kind === "string" ? kind : undefined;
}

function findCycleByProposal(
  ledger: RotationLedgerFile,
  walletId: string,
  proposalId: string,
  leg: "entry" | "exit",
): RotationCycleLedgerEntry | null {
  const field = leg === "entry" ? "entryProposalId" : "exitProposalId";
  return (
    ledger.cycles.find(
      (cycle) => cycle.walletId === walletId && cycle[field] === proposalId,
    ) ?? null
  );
}

export async function runEusdcRotationExecuteEntry(
  config: AppConfig,
  input: { proposalId: string; confirm?: boolean },
  deps: RotationDeps = defaultRotationDeps,
): Promise<RotationExecutionOutput> {
  const proposal = deps.loadProposal(config, input.proposalId);
  if (input.confirm !== true) {
    return {
      ok: false,
      walletId: proposal.walletId,
      leg: "entry",
      proposalId: input.proposalId,
      reason: "confirm=true required",
    };
  }
  if (proposalProvenanceKind(proposal) !== "eusdc_rotation_entry_v1") {
    return {
      ok: false,
      walletId: proposal.walletId,
      leg: "entry",
      proposalId: input.proposalId,
      reason: "proposal did not originate from eusdc_rotation_propose_entry",
    };
  }
  return withWalletLock(proposal.walletId, async () => {
    const ledger = readRotationLedger(config);
    const cycle = findCycleByProposal(ledger, proposal.walletId, input.proposalId, "entry");
    if (!cycle || cycle.state !== "ENTRY_PROPOSAL_READY") {
      return {
        ok: false,
        walletId: proposal.walletId,
        leg: "entry",
        proposalId: input.proposalId,
        reason: "ledger state does not permit entry execution",
      };
    }
    const candidate = getRotationCandidate(cycle.selectedCandidate!);
    const beforeEusdc = decimalUint(await deps.readTokenBalance(config, EUSDC_TOKEN_ADDRESS, proposal.from), "beforeEusdc");
    const beforeCandidate = decimalUint(await deps.readTokenBalance(config, candidate.executionTokenAddress, proposal.from), "beforeCandidate");
    const result = await deps.executeAgentTx(config, input.proposalId, true);
    const afterEusdc = decimalUint(await deps.readTokenBalance(config, EUSDC_TOKEN_ADDRESS, proposal.from), "afterEusdc");
    const afterCandidate = decimalUint(await deps.readTokenBalance(config, candidate.executionTokenAddress, proposal.from), "afterCandidate");
    cycle.state = "POSITION_OPEN";
    cycle.entryTransactionHash = result.txHash;
    cycle.entryEusdcSpentRaw = (beforeEusdc > afterEusdc ? beforeEusdc - afterEusdc : 0n).toString();
    cycle.candidateReceivedRaw = (afterCandidate > beforeCandidate ? afterCandidate - beforeCandidate : 0n).toString();
    cycle.positionOpenedAt = new Date(deps.nowMs()).toISOString();
    cycle.entryGasPls = result.simulation.estimatedFeePlsApprox?.toString();
    writeRotationLedger(config, ledger);
    const receipt = await deps.getTransactionReceipt(config, result.txHash).catch(() => null);
    return {
      ok: true,
      walletId: proposal.walletId,
      cycleId: cycle.cycleId,
      candidateId: cycle.selectedCandidate,
      leg: "entry",
      proposalId: input.proposalId,
      txHash: result.txHash,
      receiptStatus: receipt?.status,
      blockNumber: typeof receipt?.blockNumber === "string" ? receipt.blockNumber : undefined,
      gasUsed: typeof receipt?.gasUsed === "string" ? receipt.gasUsed : undefined,
      eUsdcBalanceRaw: afterEusdc.toString(),
      candidateBalanceRaw: afterCandidate.toString(),
      finalState: "POSITION_OPEN",
    };
  });
}

export async function runEusdcRotationPositionStatus(
  config: AppConfig,
  input: { walletId: string },
  deps: RotationDeps = defaultRotationDeps,
): Promise<RotationPositionStatus> {
  const ledger = readRotationLedger(config);
  const cycle = getOpenRotationCycle(ledger, input.walletId);
  if (!cycle || cycle.state !== "POSITION_OPEN") {
    return {
      ok: true,
      walletId: input.walletId,
      state: cycle?.state ?? "EUSDC_IDLE",
      exitSignalStatus: "NO_OPEN_POSITION",
      quoteCallCount: quoteCounter.count,
    };
  }
  const wallet = await getWalletForRotation(config, input.walletId, deps);
  const candidate = getRotationCandidate(cycle.selectedCandidate!);
  const amountRaw = await deps.readTokenBalance(config, candidate.executionTokenAddress, wallet.address);
  const estimatedExecutableSellOutputRaw = cycle.startingEusdcRaw;
  const target = computeRequiredFinalEusdcRaw({
    startingEusdcRaw: cycle.startingEusdcRaw,
    projectedExitSwapGasEusdcEquivalentRaw: cycle.exitGasEusdcEquivalentRaw ?? "0",
    safetyBufferRaw: "0",
    gasConversionAvailable: cycle.exitGasEusdcEquivalentRaw !== undefined,
    gasConversionSource: cycle.exitGasEusdcEquivalentRaw !== undefined ? "ledger" : "unavailable",
  });
  const distance =
    decimalUint(target.requiredFinalEusdcRaw, "requiredFinalEusdcRaw") -
    decimalUint(estimatedExecutableSellOutputRaw, "estimatedExecutableSellOutputRaw");
  const openedAt = Date.parse(cycle.positionOpenedAt ?? cycle.cycleStartTime);
  return {
    ok: true,
    walletId: input.walletId,
    state: cycle.state,
    candidateId: cycle.selectedCandidate,
    amountRaw,
    entryEusdcSpentRaw: cycle.entryEusdcSpentRaw,
    currentReadOnlyEusdcValuationRaw: estimatedExecutableSellOutputRaw,
    unrealizedEusdcChangeRaw: (
      decimalUint(estimatedExecutableSellOutputRaw, "estimatedExecutableSellOutputRaw") -
      decimalUint(cycle.startingEusdcRaw, "startingEusdcRaw")
    ).toString(),
    unrealizedPercent: 0,
    entryGasPls: cycle.entryGasPls,
    projectedExitGasPls: candidate.maximumGasCostPlsPerLeg,
    requiredFinalEusdcRaw: target.requiredFinalEusdcRaw,
    estimatedExecutableSellOutputRaw,
    distanceFromTargetRaw: distance.toString(),
    holdingDurationSeconds: Math.max(0, Math.floor((deps.nowMs() - openedAt) / 1000)),
    adverseMovementBps: 0,
    exitSignalStatus:
      distance <= 0n && target.gasConversionAvailable
        ? "CHECK_EXECUTABLE_EXIT"
        : "HOLD_POSITION",
    quoteCallCount: quoteCounter.count,
  };
}

export async function runEusdcRotationProposeExit(
  config: AppConfig,
  input: {
    walletId: string;
    maximumQuoteAgeMs?: number;
    allowedSlippagePercent?: number;
    maximumGasCostPls?: string;
    minimumExecutableEusdcOutputRaw?: string;
  },
  deps: RotationDeps = defaultRotationDeps,
): Promise<RotationPiteasProposalOutput> {
  return withWalletLock(input.walletId, async () => {
    const leg = "exit" as const;
    const status = deps.agentWalletSystemStatus(config);
    const runtime = runtimeBlocked(config, status);
    if (!runtime.ok) {
      return failureProposal("WALLET_RUNTIME_BLOCKED", "wallet_runtime", runtime.reason, {
        walletId: input.walletId,
        leg,
      });
    }
    const wallet = await getWalletForRotation(config, input.walletId, deps);
    const ledger = readRotationLedger(config);
    const cycle = getOpenRotationCycle(ledger, input.walletId);
    if (!cycle || cycle.state !== "POSITION_OPEN") {
      return failureProposal("NO_OPEN_POSITION", "ledger", "no open position is available for exit", {
        walletId: input.walletId,
        walletAddress: wallet.address,
        leg,
      });
    }
    const candidate = getRotationCandidate(cycle.selectedCandidate!);
    const candidateBalanceRaw = await deps.readTokenBalance(config, candidate.executionTokenAddress, wallet.address);
    if (candidateBalanceRaw !== cycle.candidateReceivedRaw) {
      return failureProposal("INSUFFICIENT_BALANCE", "wallet_state", "candidate balance does not match ledger", {
        walletId: input.walletId,
        walletAddress: wallet.address,
        cycleId: cycle.cycleId,
        candidateId: candidate.candidateId,
        leg,
        inputBalanceRaw: candidateBalanceRaw,
      });
    }
    const allowanceRaw = await deps.readTokenAllowance(config, candidate.executionTokenAddress, wallet.address, ROUTER);
    const target = computeRequiredFinalEusdcRaw({
      startingEusdcRaw: cycle.startingEusdcRaw,
      entryApprovalGasEusdcEquivalentRaw: cycle.entryGasEusdcEquivalentRaw ?? "0",
      entrySwapGasEusdcEquivalentRaw: "0",
      exitApprovalGasEusdcEquivalentRaw: "0",
      projectedExitSwapGasEusdcEquivalentRaw: cycle.exitGasEusdcEquivalentRaw ?? "0",
      safetyBufferRaw: "0",
      gasConversionAvailable: cycle.exitGasEusdcEquivalentRaw !== undefined,
      gasConversionSource: cycle.exitGasEusdcEquivalentRaw !== undefined ? "ledger" : "unavailable",
    });
    if (!target.gasConversionAvailable && !input.minimumExecutableEusdcOutputRaw) {
      return failureProposal("MINIMUM_OUTPUT_BELOW_FLOOR", "target", "gas conversion unavailable; profitability unproven", {
        walletId: input.walletId,
        walletAddress: wallet.address,
        cycleId: cycle.cycleId,
        candidateId: candidate.candidateId,
        leg,
      });
    }
    const floor = input.minimumExecutableEusdcOutputRaw ?? target.requiredFinalEusdcRaw;
    const proposal = await guardedPiteasProposal({
      config,
      deps,
      walletId: input.walletId,
      walletAddress: wallet.address,
      cycleId: cycle.cycleId,
      candidateId: candidate.candidateId,
      leg,
      tokenIn: candidate.executionTokenAddress,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: candidateBalanceRaw,
      inputBalanceRaw: candidateBalanceRaw,
      currentAllowanceRaw: allowanceRaw,
      allowedSlippagePercent: input.allowedSlippagePercent ?? DEFAULT_ALLOWED_SLIPPAGE_PERCENT,
      maximumQuoteAgeMs: input.maximumQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS,
      minimumExecutableOutputRaw: floor,
      maximumGasCostPls: input.maximumGasCostPls ?? candidate.maximumGasCostPlsPerLeg,
    });
    if (proposal.ok && proposal.proposalId) {
      cycle.state = "EXIT_PROPOSAL_READY";
      cycle.exitQuoteFingerprint = proposal.quoteResponseFingerprint;
      cycle.exitProposalId = proposal.proposalId;
      cycle.exitTargetRaw = floor;
      writeRotationLedger(config, ledger);
    }
    return proposal;
  });
}

export async function runEusdcRotationExecuteExit(
  config: AppConfig,
  input: { proposalId: string; confirm?: boolean },
  deps: RotationDeps = defaultRotationDeps,
): Promise<RotationExecutionOutput> {
  const proposal = deps.loadProposal(config, input.proposalId);
  if (input.confirm !== true) {
    return {
      ok: false,
      walletId: proposal.walletId,
      leg: "exit",
      proposalId: input.proposalId,
      reason: "confirm=true required",
    };
  }
  if (proposalProvenanceKind(proposal) !== "eusdc_rotation_exit_v1") {
    return {
      ok: false,
      walletId: proposal.walletId,
      leg: "exit",
      proposalId: input.proposalId,
      reason: "proposal did not originate from eusdc_rotation_propose_exit",
    };
  }
  return withWalletLock(proposal.walletId, async () => {
    const ledger = readRotationLedger(config);
    const cycle = findCycleByProposal(ledger, proposal.walletId, input.proposalId, "exit");
    if (!cycle || cycle.state !== "EXIT_PROPOSAL_READY") {
      return {
        ok: false,
        walletId: proposal.walletId,
        leg: "exit",
        proposalId: input.proposalId,
        reason: "ledger state does not permit exit execution",
      };
    }
    const candidate = getRotationCandidate(cycle.selectedCandidate!);
    const beforeEusdc = decimalUint(await deps.readTokenBalance(config, EUSDC_TOKEN_ADDRESS, proposal.from), "beforeEusdc");
    const beforeCandidate = decimalUint(await deps.readTokenBalance(config, candidate.executionTokenAddress, proposal.from), "beforeCandidate");
    const result = await deps.executeAgentTx(config, input.proposalId, true);
    const afterEusdc = decimalUint(await deps.readTokenBalance(config, EUSDC_TOKEN_ADDRESS, proposal.from), "afterEusdc");
    const afterCandidate = decimalUint(await deps.readTokenBalance(config, candidate.executionTokenAddress, proposal.from), "afterCandidate");
    const received = afterEusdc > beforeEusdc ? afterEusdc - beforeEusdc : 0n;
    cycle.state = "CYCLE_COMPLETE";
    cycle.exitTransactionHash = result.txHash;
    cycle.candidateSoldRaw = (beforeCandidate > afterCandidate ? beforeCandidate - afterCandidate : 0n).toString();
    cycle.finalEusdcReceivedRaw = received.toString();
    cycle.endingEusdcRaw = afterEusdc.toString();
    cycle.grossEusdcGainRaw = (afterEusdc - decimalUint(cycle.startingEusdcRaw, "startingEusdcRaw")).toString();
    cycle.netEusdcEquivalentGainRaw = cycle.grossEusdcGainRaw;
    cycle.netGainBps = Number((afterEusdc - decimalUint(cycle.startingEusdcRaw, "startingEusdcRaw")) * 10_000n / decimalUint(cycle.startingEusdcRaw, "startingEusdcRaw"));
    cycle.completedAt = new Date(deps.nowMs()).toISOString();
    writeRotationLedger(config, ledger);
    const receipt = await deps.getTransactionReceipt(config, result.txHash).catch(() => null);
    return {
      ok: true,
      walletId: proposal.walletId,
      cycleId: cycle.cycleId,
      candidateId: cycle.selectedCandidate,
      leg: "exit",
      proposalId: input.proposalId,
      txHash: result.txHash,
      receiptStatus: receipt?.status,
      blockNumber: typeof receipt?.blockNumber === "string" ? receipt.blockNumber : undefined,
      gasUsed: typeof receipt?.gasUsed === "string" ? receipt.gasUsed : undefined,
      eUsdcBalanceRaw: afterEusdc.toString(),
      candidateBalanceRaw: afterCandidate.toString(),
      finalState: "CYCLE_COMPLETE",
    };
  });
}

export function resetEusdcRotationForTests(): void {
  quoteCounter.count = 0;
  quoteWindowTimestamps.length = 0;
  lastScanByWallet.clear();
  historyLocks.clear();
}

function humanTokenAmount(raw: string | undefined, decimals: number): string | undefined {
  if (!raw) return undefined;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return undefined;
  }
}

export function registerEusdcRotationTools(server: McpServer, config: AppConfig): void {
  registerTool(server, config, {
    name: "eusdc_rotation_history_sync",
    description:
      "Read-only public market-history backfill for the five eUSDC rotation candidates. Writes only normalized public swap history under data/eusdc-rotation-history, never calls Piteas, never proposes, signs, broadcasts, approves, or executes.",
    category: "wallet",
    inputSchema: {
      lookbackMinutes: z.number().int().positive().optional().default(DEFAULT_HISTORY_LOOKBACK_MINUTES),
      maximumBlocksPerChunk: z.number().int().positive().optional().default(DEFAULT_LOG_CHUNK_BLOCKS),
      maximumPagesPerSource: z.number().int().positive().optional().default(DEFAULT_HISTORY_MAX_PAGES),
      forceRecentBlockRecheck: z.boolean().optional().default(true),
      maximumRuntimeMs: z.number().int().positive().max(MAX_HISTORY_MAX_RUNTIME_MS).optional().default(DEFAULT_HISTORY_MAX_RUNTIME_MS),
      candidateIds: z.array(candidateIdSchema).optional(),
      resumeToken: z.string().optional(),
      maximumPoolsPerRun: z.number().int().positive().optional(),
      syncPurpose: z.enum(["RECENT_SIGNAL_WINDOW", "HISTORICAL_BACKFILL"]).optional().default("HISTORICAL_BACKFILL"),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationHistorySync(cfg, {
            lookbackMinutes: args.lookbackMinutes as number | undefined,
            maximumBlocksPerChunk: args.maximumBlocksPerChunk as number | undefined,
            maximumPagesPerSource: args.maximumPagesPerSource as number | undefined,
            forceRecentBlockRecheck: args.forceRecentBlockRecheck as boolean | undefined,
            maximumRuntimeMs: args.maximumRuntimeMs as number | undefined,
            candidateIds: args.candidateIds as RotationCandidateId[] | undefined,
            resumeToken: args.resumeToken as string | undefined,
            maximumPoolsPerRun: args.maximumPoolsPerRun as number | undefined,
            syncPurpose: args.syncPurpose as RotationHistorySyncPurpose | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_recent_refresh",
    description:
      "Freshness-first public market-history refresh for the current eUSDC rotation signal window. Scans newest blocks first, refreshes WPLS/eUSDC anchors before anchored pools, writes only public history/checkpoint data, and never calls Piteas or creates wallet actions.",
    category: "wallet",
    inputSchema: {
      lookbackMinutes: z.number().int().positive().optional().default(DEFAULT_LOOKBACK_MINUTES),
      candidateIds: z.array(candidateIdSchema).optional(),
      tipRefreshMinutes: z.number().int().positive().optional().default(120),
      maximumRuntimeMs: z.number().int().positive().max(180_000).optional().default(120_000),
      maximumBlocksPerChunk: z.number().int().positive().optional().default(10_000),
      maximumPoolsPerRun: z.number().int().positive().optional().default(6),
      resumeToken: z.string().optional(),
      forceRecentBlockRecheck: z.boolean().optional().default(true),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationRecentRefresh(cfg, {
            lookbackMinutes: args.lookbackMinutes as number | undefined,
            candidateIds: args.candidateIds as RotationCandidateId[] | undefined,
            tipRefreshMinutes: args.tipRefreshMinutes as number | undefined,
            maximumRuntimeMs: args.maximumRuntimeMs as number | undefined,
            maximumBlocksPerChunk: args.maximumBlocksPerChunk as number | undefined,
            maximumPoolsPerRun: args.maximumPoolsPerRun as number | undefined,
            resumeToken: args.resumeToken as string | undefined,
            forceRecentBlockRecheck: args.forceRecentBlockRecheck as boolean | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_history_status",
    description:
      "Read-only status for the public eUSDC rotation market-history store. Reports completeness, sparse/dense analysis mode, gaps, and scan readiness for all five candidates without wallet writes or Piteas calls.",
    category: "wallet",
    inputSchema: {
      lookbackMinutes: z.number().int().positive().optional().default(DEFAULT_HISTORY_LOOKBACK_MINUTES),
      candleMinutes: z.number().int().positive().optional().default(DEFAULT_CANDLE_MINUTES),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationHistoryStatus(cfg, {
            lookbackMinutes: args.lookbackMinutes as number | undefined,
            candleMinutes: args.candleMinutes as number | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_scan",
    description:
      "Read-only five-candidate eUSDC rotation scan. Scans PLS exposure via WPLS, PLSX, INC, pHEX, and PRVX using inexpensive on-chain/subgraph evidence only. Does not call Piteas, propose, sign, broadcast, approve, or execute.",
    category: "wallet",
    inputSchema: {
      walletId: walletIdSchema,
      lookbackMinutes: z.number().int().positive().optional().default(DEFAULT_LOOKBACK_MINUTES),
      candleMinutes: z.number().int().positive().optional().default(DEFAULT_CANDLE_MINUTES),
      minimumDipBps: z.number().int().nonnegative().optional().default(DEFAULT_MINIMUM_DIP_BPS),
      minimumReboundConfirmationBps: z.number().int().nonnegative().optional().default(DEFAULT_MINIMUM_REBOUND_BPS),
      minimumNetTargetBps: z.number().int().positive().optional().default(DEFAULT_MINIMUM_NET_TARGET_BPS),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationScan(cfg, {
            walletId: String(args.walletId),
            lookbackMinutes: args.lookbackMinutes as number | undefined,
            candleMinutes: args.candleMinutes as number | undefined,
            minimumDipBps: args.minimumDipBps as number | undefined,
            minimumReboundConfirmationBps:
              args.minimumReboundConfirmationBps as number | undefined,
            minimumNetTargetBps: args.minimumNetTargetBps as number | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_propose_entry",
    description:
      "Create one guarded Piteas entry proposal for the winner of a fresh eUSDC rotation scan. Makes at most one Piteas quote request, never creates approvals, never signs, and never broadcasts.",
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      expectedCandidateId: candidateIdSchema,
      scanFingerprint: z.string().min(1),
      maximumQuoteAgeMs: z.number().int().positive().optional().default(DEFAULT_MAX_QUOTE_AGE_MS),
      allowedSlippagePercent: z.number().min(0).max(0.5).optional().default(DEFAULT_ALLOWED_SLIPPAGE_PERCENT),
      maximumGasCostPls: positiveDecimalPlsSchema.optional().default(DEFAULT_MAX_GAS_COST_PLS),
      useFullEusdcBalance: z.boolean().optional().default(true),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationProposeEntry(cfg, {
            walletId: String(args.walletId),
            expectedCandidateId: args.expectedCandidateId as RotationCandidateId,
            scanFingerprint: String(args.scanFingerprint),
            maximumQuoteAgeMs: args.maximumQuoteAgeMs as number | undefined,
            allowedSlippagePercent: args.allowedSlippagePercent as number | undefined,
            maximumGasCostPls: args.maximumGasCostPls as string | undefined,
            useFullEusdcBalance: args.useFullEusdcBalance as boolean | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_execute_entry",
    description:
      "Execute a pending proposal created by eusdc_rotation_propose_entry. Delegates to executeAgentTx; requires confirm=true and never implements independent signing.",
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
      confirm: z.boolean().optional(),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationExecuteEntry(cfg, {
            proposalId: String(args.proposalId),
            confirm: args.confirm as boolean | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_position_status",
    description:
      "Read one open eUSDC rotation position and report target distance without requesting a Piteas quote or switching candidates.",
    category: "wallet",
    inputSchema: {
      walletId: walletIdSchema,
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationPositionStatus(cfg, {
            walletId: String(args.walletId),
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_propose_exit",
    description:
      "Create one guarded Piteas exit proposal for the currently open eUSDC rotation position only when executable min eUSDC meets the dynamic target. Makes at most one Piteas quote request and never creates approvals.",
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      maximumQuoteAgeMs: z.number().int().positive().optional().default(DEFAULT_MAX_QUOTE_AGE_MS),
      allowedSlippagePercent: z.number().min(0).max(0.5).optional().default(DEFAULT_ALLOWED_SLIPPAGE_PERCENT),
      maximumGasCostPls: positiveDecimalPlsSchema.optional().default(DEFAULT_MAX_GAS_COST_PLS),
      minimumExecutableEusdcOutputRaw: decimalUintSchema.optional(),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationProposeExit(cfg, {
            walletId: String(args.walletId),
            maximumQuoteAgeMs: args.maximumQuoteAgeMs as number | undefined,
            allowedSlippagePercent: args.allowedSlippagePercent as number | undefined,
            maximumGasCostPls: args.maximumGasCostPls as string | undefined,
            minimumExecutableEusdcOutputRaw:
              args.minimumExecutableEusdcOutputRaw as string | undefined,
          }),
        ),
      ),
  });

  registerTool(server, config, {
    name: "eusdc_rotation_execute_exit",
    description:
      "Execute a pending proposal created by eusdc_rotation_propose_exit. Delegates to executeAgentTx; requires confirm=true and never implements independent signing.",
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
      confirm: z.boolean().optional(),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runEusdcRotationExecuteExit(cfg, {
            proposalId: String(args.proposalId),
            confirm: args.confirm as boolean | undefined,
          }),
        ),
      ),
  });
}

export function describeRotationOutputAmounts(output: RotationPiteasProposalOutput): Record<string, string | undefined> {
  const tokenOutDecimals = output.leg === "entry" ? 18 : 6;
  return {
    expectedHuman: humanTokenAmount(output.expectedOutputRaw, tokenOutDecimals),
    executableMinimumHuman: humanTokenAmount(output.executableMinimumOutputRaw, tokenOutDecimals),
    estimatedGasCostPls: output.estimatedGasCostPls
      ? formatEther(positivePlainDecimalToWei(output.estimatedGasCostPls, "estimatedGasCostPls"))
      : undefined,
  };
}
