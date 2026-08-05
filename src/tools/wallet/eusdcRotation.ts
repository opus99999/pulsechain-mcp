import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, formatEther, formatUnits } from "viem";
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
  | "INSUFFICIENT_EVIDENCE"
  | "DATA_SOURCE_FAILURE";

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
    expectedNamePatterns: ["prvx"],
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
  recentVolumeUsd: number;
  tradeCount: number;
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
  routeAvailabilityStatus: "both_directions" | "missing_entry" | "missing_exit" | "none";
  evidenceFresh: boolean;
  dataSourceErrors: string[];
  poolsUsed?: string[];
  tokenPath?: string[];
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
  recentVolumeUsd: number;
  tradeCount: number;
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
  eligibility: boolean;
  score: number;
  rejectionReasons: string[];
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
  noPiteasQuoteUsed: true;
  noLiveTransaction: true;
  reason?: string;
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

function stableScanPayload(row: RotationCandidateScanRow): Record<string, unknown> {
  return {
    candidateId: row.candidateId,
    executionTokenAddress: row.executionTokenAddress.toLowerCase(),
    largestPoolLiquidityUsd: row.largestPoolLiquidityUsd,
    aggregateLiquidityUsd: row.aggregateLiquidityUsd,
    recentVolumeUsd: row.recentVolumeUsd,
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
  if (market.routeAvailabilityStatus !== "both_directions") {
    rejectionReasons.push("read-only route availability missing in one or both directions");
  }
  if (market.largestPoolLiquidityUsd < candidate.minimumLiquidityUsd) {
    rejectionReasons.push("largest-pool liquidity below threshold");
  }
  if (market.recentVolumeUsd < candidate.minimumRecentVolumeUsd) {
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
    recentVolumeUsd: market.recentVolumeUsd,
    tradeCount: market.tradeCount,
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
    eligibility,
    score: eligibility ? Math.round(clampScore(rawScore) * 100) / 100 : 0,
    rejectionReasons,
  };
}

export function selectRotationWinner(rows: RotationCandidateScanRow[]): {
  decision: RotationScanDecision;
  winner?: RotationCandidateId;
  rankedCandidateIds: RotationCandidateId[];
  reason?: string;
} {
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  const eligible = ranked.filter((row) => row.eligibility);
  if (rows.some((row) => row.rejectionReasons.includes("market data source failure"))) {
    return {
      decision: "DATA_SOURCE_FAILURE",
      rankedCandidateIds: ranked.map((row) => row.candidateId),
      reason: "one or more candidate data sources failed",
    };
  }
  if (eligible.length === 0) {
    const allInsufficient = rows.every((row) =>
      row.rejectionReasons.some((reason) =>
        /evidence|liquidity|volume|route|declined|rebound|impact/i.test(reason),
      ),
    );
    return {
      decision: allInsufficient ? "INSUFFICIENT_EVIDENCE" : "HOLD_EUSDC",
      rankedCandidateIds: ranked.map((row) => row.candidateId),
      reason: "no candidate satisfied the guarded entry signal",
    };
  }
  return {
    decision: "CANDIDATE_SELECTED",
    winner: eligible[0]!.candidateId,
    rankedCandidateIds: ranked.map((row) => row.candidateId),
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

  const routeEvidence = await defaultMarketEvidence(config, candidate, {
    walletId: "aw_00000000000000000000000000000000",
    lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
    candleMinutes: DEFAULT_CANDLE_MINUTES,
    minimumDipBps: DEFAULT_MINIMUM_DIP_BPS,
    minimumReboundConfirmationBps: DEFAULT_MINIMUM_REBOUND_BPS,
    minimumNetTargetBps: DEFAULT_MINIMUM_NET_TARGET_BPS,
  }, "0");
  const routeToBaseAvailable = routeEvidence.routeAvailabilityStatus === "both_directions";
  const routeFromBaseAvailable = routeEvidence.routeAvailabilityStatus === "both_directions";
  if (!routeToBaseAvailable || !routeFromBaseAvailable) {
    rejectionReasons.push("read-only route availability failed");
  }

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

function pairHasToken(pair: SubgraphPair, token: string): boolean {
  const lower = token.toLowerCase();
  return pair.token0.id.toLowerCase() === lower || pair.token1.id.toLowerCase() === lower;
}

function pairLiquidityUsd(pair: SubgraphPair): number {
  return Math.max(0, num(pair.reserveUSD));
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

async function defaultMarketEvidence(
  config: AppConfig,
  candidate: RotationCandidateRegistryEntry,
  _input: Required<RotationScanInput>,
  eUsdcBalanceRaw: string,
): Promise<RotationMarketEvidence> {
  const errors: string[] = [];
  const pairs: SubgraphPair[] = [];
  for (const version of ["v1", "v2"] as const) {
    try {
      pairs.push(...(await fetchPairsForToken(config, candidate.executionTokenAddress, 12, version)));
    } catch (err) {
      errors.push(`${version} pairs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const byId = new Map<string, SubgraphPair>();
  for (const pair of pairs) byId.set(pair.id.toLowerCase(), pair);
  const mergedPairs = [...byId.values()];
  const basePairs = mergedPairs.filter(
    (pair) => pairHasToken(pair, candidate.baseAssetAddress) && pairHasToken(pair, candidate.executionTokenAddress),
  );
  const largestPoolLiquidityUsd = Math.max(0, ...mergedPairs.map(pairLiquidityUsd));
  const aggregateLiquidityUsd = mergedPairs.reduce((sum, pair) => sum + pairLiquidityUsd(pair), 0);
  let swaps: SubgraphSwap[] = [];
  try {
    swaps = (await fetchSwapsAdvanced(config, {
      token: candidate.executionTokenAddress,
      first: 50,
      version: "v2",
    })).swaps;
  } catch (err) {
    errors.push(`v2 swaps: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recentVolumeUsd = swapsVolume(swaps);
  const tradeCount = swaps.length;
  const routeAvailabilityStatus =
    basePairs.length > 0 ? "both_directions" : "none";
  return {
    relevantPools: uniqueLower(mergedPairs.map((pair) => pair.id)),
    largestPoolLiquidityUsd,
    aggregateLiquidityUsd,
    recentVolumeUsd,
    tradeCount,
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
    liquidityScore: Math.min(100, (aggregateLiquidityUsd / Math.max(1, candidate.minimumLiquidityUsd)) * 50),
    volumeScore: Math.min(100, (recentVolumeUsd / Math.max(1, candidate.minimumRecentVolumeUsd)) * 50),
    routeQualityScore: routeAvailabilityStatus === "both_directions" ? 70 : 0,
    volatilitySuitabilityScore: 0,
    estimatedPriceImpactPercent: estimatedImpactPercent(eUsdcBalanceRaw, largestPoolLiquidityUsd),
    routeAvailabilityStatus,
    evidenceFresh: errors.length === 0 && tradeCount > 0,
    dataSourceErrors: errors,
    poolsUsed: uniqueLower(basePairs.map((pair) => pair.id)),
    tokenPath: [candidate.baseAssetAddress.toLowerCase(), candidate.executionTokenAddress.toLowerCase()],
  };
}

export const defaultRotationDeps: RotationDeps = {
  nowMs: () => Date.now(),
  getChainId,
  getAgentWalletInfo,
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
    const wallet = await getWalletForRotation(config, scanInput.walletId, deps);
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
  const result: RotationScanResult = {
    ok: true,
    decision: selection.decision,
    walletId: scanInput.walletId,
    ...(walletAddress ? { walletAddress } : {}),
    state,
    scannedAt,
    expiresAt,
    scanFingerprint: fingerprint({
      scanInput,
      state,
      candidates: rows.map(stableScanPayload),
      decision: selection.decision,
      winner: selection.winner ?? null,
    }),
    quoteCallCount: quoteCounter.count,
    candidates: rows,
    ...(selection.winner ? { winner: selection.winner } : {}),
    rankedCandidateIds: selection.rankedCandidateIds,
    noPiteasQuoteUsed: true,
    noLiveTransaction: true,
    ...(selection.reason ? { reason: selection.reason } : {}),
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
