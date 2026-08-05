import { formatEther } from "viem";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PULSECHAIN_CHAIN_ID } from "../../constants.js";
import type { AppConfig } from "../../types.js";
import {
  getFeeData,
  getNativeBalance,
  getPiteasQuote,
  getPublicClient,
  preparePiteasSwap,
  type PiteasQuoteData,
  type PiteasQuoteResult,
  type PiteasPrepareResult,
} from "../../data/index.js";
import {
  buildAgentIntentView,
  getAgentWalletInfo,
  inspectTokenNotional,
  proposeAgentTx,
  type AgentIntentView,
  type TxProposalWithReview,
} from "../../wallet/index.js";
import { loadProposal, saveProposal } from "../../wallet/store.js";
import type {
  AgentWalletPublicInfo,
  SimulationResult,
  TxProposal,
} from "../../wallet/types.js";
import {
  decodePiteasRouterSwapCalldata,
  EUSDC_TOKEN_ADDRESS,
  fingerprint,
  PHIAT_TOKEN_ADDRESS,
  PITEAS_ROUTER_SWAP_SELECTOR,
  sameAddress,
  VERIFIED_PITEAS_ROUTER,
  type PiteasTopLevelSwapIntent,
} from "../../piteas/routerIntent.js";
import { ok } from "../../utils/result.js";
import { assertAddress, neverReturnPrivateKey } from "../../utils/safety.js";
import { registerTool } from "../define.js";

const DEFAULT_ALLOWED_SLIPPAGE = 0.5;
const DEFAULT_MAX_QUOTE_AGE_MS = 60_000;
const RPC_SIMULATION_TIMEOUT_MS = 20_000;

export type PiteasPhiatSwapDirection = "BUY_PHIAT" | "SELL_PHIAT";

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type PiteasAgentSwapClassification =
  | "READY_FOR_HUMAN_CONFIRMATION"
  | "UNSUPPORTED_TOKEN_PAIR"
  | "SLIPPAGE_LIMIT_EXCEEDED"
  | "MINIMUM_OUTPUT_BELOW_FLOOR"
  | "GAS_COST_ABOVE_LIMIT"
  | "INPUT_BALANCE_CHANGED"
  | "NEEDS_BOUNDED_ALLOWANCE"
  | "INFRASTRUCTURE_REQUOTE_REQUIRED"
  | "PITEAS_MALFORMED_CALLDATA"
  | "CALLDATA_HANDOFF_MISMATCH"
  | "ROUTE_NOT_EXECUTABLE"
  | "RPC_STATE_DISAGREEMENT"
  | "QUOTE_STALE"
  | "PROPOSAL_INTERNAL_SIMULATION_FAILED"
  | "SAVED_PROPOSAL_INTEGRITY_MISMATCH"
  | "UNKNOWN_FAIL_CLOSED";

export interface PiteasProposeAgentSwapInput {
  walletId: string;
  tokenIn: string;
  tokenOut: string;
  amountRaw: string;
  allowedSlippage?: number;
  maximumQuoteAgeMs?: number;
  requireTwoRpcSimulation?: boolean;
  minimumExecutableOutputRaw?: string;
  maximumEstimatedGasCostPls?: string;
  requireInputAmountEqualsBalance?: boolean;
}

export interface CalldataCheckpoint {
  stage: string;
  fingerprint: `0x${string}`;
  hexCharacterCount: number;
  byteLength: number;
  first10: string;
  final10: string;
  jsType: string;
}

export interface RpcPinnedSimulationRow {
  rpc: string;
  pinnedBlock: string;
  ethCallPassed: boolean;
  outputRaw: string | null;
  revertData: string | null;
  decodedRevert: string | null;
  estimateGasPassed: boolean;
  gasEstimate: string | null;
  error: string | null;
}

export interface PiteasProposeAgentSwapOutput {
  ok: boolean;
  classification: PiteasAgentSwapClassification;
  failureStage?: string;
  reason?: string;
  walletId?: string;
  walletAddress?: `0x${string}`;
  swapDirection?: PiteasPhiatSwapDirection;
  tokenIn?: `0x${string}`;
  tokenOut?: `0x${string}`;
  inputAmountRaw?: string;
  inputBalanceRaw?: string;
  currentAllowanceRaw?: string;
  verifiedSpender?: `0x${string}`;
  requiredAllowanceRaw?: string;
  unlimitedApproval?: boolean;
  quoteReceivedAt?: string;
  quoteResponseFingerprint?: string;
  expectedOutputRaw?: string;
  executableMinimumOutputRaw?: string;
  minimumExecutableOutputFloorRaw?: string;
  maximumEstimatedGasCostPls?: string;
  routeProtocols?: string[];
  methodParameterFingerprint?: `0x${string}`;
  upstreamCalldataFingerprint?: `0x${string}`;
  preparedCalldataFingerprint?: `0x${string}`;
  decoderInputFingerprint?: `0x${string}`;
  walletInspectionInputFingerprint?: `0x${string}`;
  simulationInputFingerprint?: `0x${string}`;
  proposalInputFingerprint?: `0x${string}`;
  savedProposalCalldataFingerprint?: `0x${string}`;
  calldataHexCharacterCount?: number;
  calldataByteLength?: number;
  topLevelDecodeStatus?: string;
  decodeKnowledge?: string;
  agentGuidance?: string;
  twoRpcSimulation?: RpcPinnedSimulationRow[];
  internalProposalSimulation?: SimulationResult;
  proposalId?: string;
  proposalCreatedAt?: string;
  proposalExpiresAt?: string;
  proposalStatus?: TxProposal["status"];
  estimatedGas?: string;
  estimatedGasCostPls?: string;
  everyCalldataFingerprintMatched?: boolean;
  readyForHumanConfirmation: boolean;
}

export interface PiteasAgentSwapDeps {
  nowMs: () => number;
  getAgentWalletInfo: typeof getAgentWalletInfo;
  getPiteasQuote: typeof getPiteasQuote;
  preparePiteasSwap: typeof preparePiteasSwap;
  decodePiteasRouterSwapCalldata: typeof decodePiteasRouterSwapCalldata;
  inspectTokenNotional: typeof inspectTokenNotional;
  buildAgentIntentView: typeof buildAgentIntentView;
  proposeAgentTx: typeof proposeAgentTx;
  loadProposal: (config: AppConfig, proposalId: string) => TxProposal;
  saveProposal: (config: AppConfig, proposal: TxProposal) => void;
  readTokenBalance: (
    config: AppConfig,
    token: `0x${string}`,
    owner: `0x${string}`,
  ) => Promise<string>;
  readTokenAllowance: (
    config: AppConfig,
    token: `0x${string}`,
    owner: `0x${string}`,
    spender: `0x${string}`,
  ) => Promise<string>;
  readNativeBalanceWei: (
    config: AppConfig,
    owner: `0x${string}`,
  ) => Promise<string>;
  getFeeData: typeof getFeeData;
  simulateSameBlock: (
    config: AppConfig,
    tx: {
      from: `0x${string}`;
      to: `0x${string}`;
      data: `0x${string}`;
      valueWei: string;
    },
    requireTwoRpcSimulation: boolean,
  ) => Promise<RpcPinnedSimulationRow[]>;
}

export async function readErc20Balance(
  config: AppConfig,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<string> {
  const balance = await getPublicClient(config).readContract({
    address: token,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [owner],
  });
  return (balance as bigint).toString();
}

export async function readErc20Allowance(
  config: AppConfig,
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<string> {
  const allowance = await getPublicClient(config).readContract({
    address: token,
    abi: erc20AllowanceAbi,
    functionName: "allowance",
    args: [owner, spender],
  });
  return (allowance as bigint).toString();
}

async function readNativeBalanceWei(
  config: AppConfig,
  owner: `0x${string}`,
): Promise<string> {
  const balance = await getNativeBalance(config, owner);
  return balance.balanceWei;
}

export const defaultPiteasAgentSwapDeps: PiteasAgentSwapDeps = {
  nowMs: () => Date.now(),
  getAgentWalletInfo,
  getPiteasQuote,
  preparePiteasSwap,
  decodePiteasRouterSwapCalldata,
  inspectTokenNotional,
  buildAgentIntentView,
  proposeAgentTx,
  loadProposal: (config, proposalId) =>
    loadProposal(config.agentWalletDir, proposalId),
  saveProposal: (config, proposal) => saveProposal(config.agentWalletDir, proposal),
  readTokenBalance: readErc20Balance,
  readTokenAllowance: readErc20Allowance,
  readNativeBalanceWei,
  getFeeData,
  simulateSameBlock: simulateSameBlockTwoRpc,
};

function failure(
  classification: Exclude<PiteasAgentSwapClassification, "READY_FOR_HUMAN_CONFIRMATION">,
  failureStage: string,
  reason: string,
  partial: Partial<PiteasProposeAgentSwapOutput> = {},
): PiteasProposeAgentSwapOutput {
  return {
    ok: false,
    classification,
    failureStage,
    reason,
    readyForHumanConfirmation: false,
    ...partial,
  };
}

function isDecimalUint(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function parseDecimalUint(value: string, label: string): bigint {
  if (!isDecimalUint(value)) {
    throw new Error(`${label} must be a decimal unsigned integer string`);
  }
  return BigInt(value);
}

export function classifyPiteasPhiatSwapDirection(
  tokenIn: string,
  tokenOut: string,
): PiteasPhiatSwapDirection | null {
  if (sameAddress(tokenIn, EUSDC_TOKEN_ADDRESS) && sameAddress(tokenOut, PHIAT_TOKEN_ADDRESS)) {
    return "BUY_PHIAT";
  }
  if (sameAddress(tokenIn, PHIAT_TOKEN_ADDRESS) && sameAddress(tokenOut, EUSDC_TOKEN_ADDRESS)) {
    return "SELL_PHIAT";
  }
  return null;
}

function isPositivePlainDecimal(value: string): boolean {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) > 0n || /[1-9]/.test(fraction);
}

function parsePlainDecimalPlsToWei(value: string, label: string): bigint {
  if (!isPositivePlainDecimal(value)) {
    throw new Error(`${label} must be a positive plain decimal string`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 18) {
    throw new Error(`${label} cannot have more than 18 decimal places`);
  }
  return BigInt(whole) * 1_000_000_000_000_000_000n + BigInt(fraction.padEnd(18, "0"));
}

function quoteFailureClassification(result: Extract<PiteasQuoteResult, { ok: false }>) {
  if (/calldata|not even-length|missing methodParameters|malformed/i.test(result.reason)) {
    return "PITEAS_MALFORMED_CALLDATA" as const;
  }
  return "INFRASTRUCTURE_REQUOTE_REQUIRED" as const;
}

export function buildCalldataCheckpoint(
  stage: string,
  calldata: string,
): CalldataCheckpoint {
  return {
    stage,
    fingerprint: fingerprint(calldata),
    hexCharacterCount:
      typeof calldata === "string" && calldata.startsWith("0x")
        ? calldata.length - 2
        : Math.max(0, calldata.length),
    byteLength:
      typeof calldata === "string" && calldata.startsWith("0x")
        ? Math.floor((calldata.length - 2) / 2)
        : Math.floor(calldata.length / 2),
    first10: calldata.slice(0, 10),
    final10: calldata.slice(Math.max(0, calldata.length - 10)),
    jsType: typeof calldata,
  };
}

export function validateExecutableCalldata(input: {
  sourceField: string;
  calldata: unknown;
  requiredSelector?: string;
}): { ok: true; calldata: `0x${string}` } | { ok: false; reason: string } {
  if (typeof input.calldata !== "string") {
    return {
      ok: false,
      reason: `${input.sourceField} must be a string`,
    };
  }
  if (!input.calldata.startsWith("0x")) {
    return {
      ok: false,
      reason: `${input.sourceField} must start with 0x`,
    };
  }
  const hex = input.calldata.slice(2);
  if (hex.length < 8) {
    return {
      ok: false,
      reason: `${input.sourceField} must include a nonempty 4-byte selector`,
    };
  }
  if (hex.length % 2 !== 0) {
    return {
      ok: false,
      reason: `${input.sourceField} is not even-length hex`,
    };
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return {
      ok: false,
      reason: `${input.sourceField} contains non-hex characters`,
    };
  }
  if (
    input.requiredSelector &&
    input.calldata.slice(0, 10).toLowerCase() !== input.requiredSelector.toLowerCase()
  ) {
    return {
      ok: false,
      reason: `${input.sourceField} selector is not ${input.requiredSelector}`,
    };
  }
  return { ok: true, calldata: input.calldata as `0x${string}` };
}

export function assertCalldataHandoffIntegrity(
  checkpoints: CalldataCheckpoint[],
): { ok: true } | { ok: false; reason: string } {
  if (checkpoints.length === 0) return { ok: true };
  const baseline = checkpoints[0]!;
  for (const point of checkpoints.slice(1)) {
    if (
      point.fingerprint !== baseline.fingerprint ||
      point.hexCharacterCount !== baseline.hexCharacterCount ||
      point.byteLength !== baseline.byteLength ||
      point.first10 !== baseline.first10 ||
      point.final10 !== baseline.final10
    ) {
      return {
        ok: false,
        reason:
          `calldata handoff mismatch between ${baseline.stage} and ${point.stage}: ` +
          `fingerprint ${baseline.fingerprint} vs ${point.fingerprint}, ` +
          `hex chars ${baseline.hexCharacterCount} vs ${point.hexCharacterCount}, ` +
          `bytes ${baseline.byteLength} vs ${point.byteLength}`,
      };
    }
  }
  return { ok: true };
}

function routeProtocols(quote: PiteasQuoteData): string[] {
  return Array.isArray(quote.route?.protocols)
    ? quote.route.protocols.filter((p): p is string => typeof p === "string")
    : [];
}

function sameDecimalString(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

function validateQuoteFields(
  quote: PiteasQuoteData,
  input: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountRaw: string;
    walletAddress: `0x${string}`;
  },
): { ok: true } | { ok: false; reason: string } {
  if (quote.router.toLowerCase() !== VERIFIED_PITEAS_ROUTER.toLowerCase()) {
    return { ok: false, reason: "Piteas quote router is not the verified router" };
  }
  if (!sameAddress(quote.srcToken.address, input.tokenIn)) {
    return { ok: false, reason: "Piteas quote source token does not match input" };
  }
  if (!sameAddress(quote.destToken.address, input.tokenOut)) {
    return {
      ok: false,
      reason: "Piteas quote destination token does not match input",
    };
  }
  if (!sameDecimalString(quote.amountIn, input.amountRaw)) {
    return { ok: false, reason: "Piteas quote input amount does not match input" };
  }
  if (quote.account && !sameAddress(quote.account, input.walletAddress)) {
    return { ok: false, reason: "Piteas quote account does not match wallet" };
  }
  if (!isDecimalUint(quote.amountOut) || BigInt(quote.amountOut) <= 0n) {
    return { ok: false, reason: "Piteas quote output is zero or malformed" };
  }
  if (quote.quoteReady !== true) {
    return { ok: false, reason: "Piteas quoteReady is false" };
  }
  return { ok: true };
}

function validateDecodedIntent(
  intent: PiteasTopLevelSwapIntent,
  input: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountRaw: string;
    walletAddress: `0x${string}`;
    valueWei: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (intent.topLevelDecodeStatus !== "PASSED_CANONICAL") {
    return { ok: false, reason: "top-level Piteas decode did not pass canonical validation" };
  }
  if (intent.viemCrossCheckStatus !== "passed") {
    return { ok: false, reason: "Piteas viem cross-check did not pass" };
  }
  if (intent.trailingBytes !== 0) {
    return { ok: false, reason: "Piteas calldata has unexpected trailing bytes" };
  }
  if (intent.routeDataStatus !== "OPAQUE_MANAGER_SPECIFIC") {
    return { ok: false, reason: "Piteas route data status is not opaque manager-specific" };
  }
  if (!sameAddress(intent.sourceToken, input.tokenIn)) {
    return { ok: false, reason: "decoded source token does not match input token" };
  }
  if (!sameAddress(intent.destinationToken, input.tokenOut)) {
    return {
      ok: false,
      reason: "decoded destination token does not match output token",
    };
  }
  if (!sameDecimalString(intent.sourceAmountRaw, input.amountRaw)) {
    return { ok: false, reason: "decoded source amount does not match input amount" };
  }
  if (!sameAddress(intent.destinationAccount, input.walletAddress)) {
    return { ok: false, reason: "decoded recipient does not match wallet address" };
  }
  if (!isDecimalUint(intent.destinationMinimumAmountRaw)) {
    return { ok: false, reason: "decoded minimum output is malformed" };
  }
  if (BigInt(intent.destinationMinimumAmountRaw) <= 0n) {
    return { ok: false, reason: "decoded minimum output is not positive" };
  }
  if (!sameDecimalString(intent.nativeValueWei, input.valueWei)) {
    return { ok: false, reason: "decoded native value does not match prepared value" };
  }
  if (BigInt(intent.nativeValueWei) !== 0n) {
    return { ok: false, reason: "native value must be zero for supported PHIAT/eUSDC swaps" };
  }
  return { ok: true };
}

function validateWalletInspection(
  review: AgentIntentView,
  decoded: PiteasTopLevelSwapIntent,
): { ok: true } | { ok: false; reason: string } {
  if (review.inspection.pattern !== "piteas.swap") {
    return { ok: false, reason: "wallet inspection pattern is not piteas.swap" };
  }
  if (review.decodeKnowledge.status !== "known_top_level_with_opaque_route") {
    return {
      ok: false,
      reason: `wallet inspection decodeKnowledge=${review.decodeKnowledge.status}`,
    };
  }
  if (review.agentGuidance !== "review_carefully") {
    return { ok: false, reason: `wallet inspection agentGuidance=${review.agentGuidance}` };
  }
  const piteas = review.piteas;
  if (!piteas) {
    return { ok: false, reason: "wallet inspection did not return Piteas review intent" };
  }
  const checks: Array<[boolean, string]> = [
    [piteas.method === decoded.method, "method mismatch"],
    [sameAddress(piteas.sourceToken, decoded.sourceToken), "source token mismatch"],
    [
      sameAddress(piteas.destinationToken, decoded.destinationToken),
      "destination token mismatch",
    ],
    [sameDecimalString(piteas.sourceAmountRaw, decoded.sourceAmountRaw), "source amount mismatch"],
    [
      sameDecimalString(
        piteas.destinationMinimumAmountRaw,
        decoded.destinationMinimumAmountRaw,
      ),
      "minimum output mismatch",
    ],
    [
      sameAddress(piteas.destinationAccount, decoded.destinationAccount),
      "recipient mismatch",
    ],
    [sameDecimalString(piteas.nativeValueWei, decoded.nativeValueWei), "native value mismatch"],
    [
      piteas.routeDataFingerprint === decoded.routeDataFingerprint,
      "route-data fingerprint mismatch",
    ],
    [piteas.routeDataByteLength === decoded.routeDataByteLength, "route-data length mismatch"],
  ];
  const failed = checks.find(([passed]) => !passed);
  return failed ? { ok: false, reason: `wallet inspection ${failed[1]}` } : { ok: true };
}

function maxGasEstimate(rows: RpcPinnedSimulationRow[]): bigint | null {
  let max: bigint | null = null;
  for (const row of rows) {
    if (!row.estimateGasPassed || row.gasEstimate === null) continue;
    const gas = parseDecimalUint(row.gasEstimate, "gasEstimate");
    max = max === null || gas > max ? gas : max;
  }
  return max;
}

function weiCostToPls(costWei: bigint): string {
  return formatEther(costWei);
}

async function estimateGasCost(
  deps: Pick<PiteasAgentSwapDeps, "getFeeData">,
  config: AppConfig,
  gasEstimate: bigint,
): Promise<{ costWei: bigint; costPls: string; feeBasisWei: string }> {
  const feeData = await deps.getFeeData(config);
  const feeBasisWei = feeData.maxFeePerGas ?? feeData.gasPriceWei;
  const feeWei = parseDecimalUint(feeBasisWei, "feeBasisWei");
  const costWei = gasEstimate * feeWei;
  return {
    costWei,
    costPls: weiCostToPls(costWei),
    feeBasisWei,
  };
}

function positiveSimulationOutputs(rows: RpcPinnedSimulationRow[]): string[] {
  return rows
    .filter((row) => row.ethCallPassed && row.outputRaw !== null)
    .map((row) => row.outputRaw!)
    .filter((out) => isDecimalUint(out) && BigInt(out) > 0n);
}

function simulationClassification(
  rows: RpcPinnedSimulationRow[],
): Exclude<PiteasAgentSwapClassification, "READY_FOR_HUMAN_CONFIRMATION"> {
  const text = rows
    .map((row) => [row.error, row.decodedRevert, row.revertData].filter(Boolean).join(" "))
    .join(" ");
  if (
    /BalancerV2Error|Phux|Balancer|execution reverted|revert|insufficient.?output|output.?minimum|malformed calldata|stale/i.test(
      text,
    )
  ) {
    return "ROUTE_NOT_EXECUTABLE";
  }
  return "RPC_STATE_DISAGREEMENT";
}

function validateTwoRpcSimulation(
  rows: RpcPinnedSimulationRow[],
  requireTwoRpcSimulation: boolean,
  minimumExecutableOutputRaw?: string,
):
  | { ok: true }
  | {
      ok: false;
      classification: Exclude<
        PiteasAgentSwapClassification,
        "READY_FOR_HUMAN_CONFIRMATION"
      >;
      reason: string;
    } {
  const required = requireTwoRpcSimulation ? 2 : 1;
  if (rows.length < required) {
    return {
      ok: false,
      classification: "RPC_STATE_DISAGREEMENT",
      reason: `only ${rows.length} RPC simulation result(s), required ${required}`,
    };
  }
  if (rows.some((row) => !row.ethCallPassed || !row.estimateGasPassed)) {
    return {
      ok: false,
      classification: simulationClassification(rows),
      reason: "one or more RPC simulations failed",
    };
  }
  const outputs = positiveSimulationOutputs(rows);
  if (outputs.length < required) {
    return {
      ok: false,
      classification: "ROUTE_NOT_EXECUTABLE",
      reason: "one or more eth_call outputs were zero or malformed",
    };
  }
  const [first] = outputs;
  if (outputs.some((value) => value !== first)) {
    return {
      ok: false,
      classification: "RPC_STATE_DISAGREEMENT",
      reason: "RPC eth_call outputs disagree",
    };
  }
  if (
    minimumExecutableOutputRaw !== undefined &&
    outputs.some((value) => BigInt(value) < BigInt(minimumExecutableOutputRaw))
  ) {
    return {
      ok: false,
      classification: "MINIMUM_OUTPUT_BELOW_FLOOR",
      reason: "MINIMUM_OUTPUT_BELOW_FLOOR",
    };
  }
  const gasEstimates = rows
    .filter((row) => row.estimateGasPassed && row.gasEstimate !== null)
    .map((row) => row.gasEstimate!);
  if (gasEstimates.length < required) {
    return {
      ok: false,
      classification: "RPC_STATE_DISAGREEMENT",
      reason: "one or more gas estimates were missing or malformed",
    };
  }
  const [firstGas] = gasEstimates;
  if (gasEstimates.some((value) => value !== firstGas)) {
    return {
      ok: false,
      classification: "RPC_STATE_DISAGREEMENT",
      reason: "RPC gas estimates disagree",
    };
  }
  return { ok: true };
}

function selectedOutputFields(params: {
  walletId: string;
  walletAddress: `0x${string}`;
  swapDirection: PiteasPhiatSwapDirection;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  inputAmountRaw: string;
  inputBalanceRaw?: string;
  currentAllowanceRaw?: string;
  minimumExecutableOutputFloorRaw?: string;
  maximumEstimatedGasCostPls?: string;
  quoteReceivedAt: string;
  quoteResponseFingerprint: string;
  quote: PiteasQuoteData;
  methodParameterFingerprint: `0x${string}`;
  checkpoints: Record<string, CalldataCheckpoint>;
  decoded: PiteasTopLevelSwapIntent;
  review?: AgentIntentView;
  twoRpcSimulation?: RpcPinnedSimulationRow[];
  estimatedGas?: string;
  estimatedGasCostPls?: string;
  proposal?: TxProposalWithReview | TxProposal;
  savedProposalCalldataFingerprint?: `0x${string}`;
}): Partial<PiteasProposeAgentSwapOutput> {
  return {
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    swapDirection: params.swapDirection,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    inputAmountRaw: params.inputAmountRaw,
    inputBalanceRaw: params.inputBalanceRaw,
    currentAllowanceRaw: params.currentAllowanceRaw,
    quoteReceivedAt: params.quoteReceivedAt,
    quoteResponseFingerprint: params.quoteResponseFingerprint,
    expectedOutputRaw: params.quote.amountOut,
    executableMinimumOutputRaw: params.decoded.destinationMinimumAmountRaw,
    minimumExecutableOutputFloorRaw: params.minimumExecutableOutputFloorRaw,
    maximumEstimatedGasCostPls: params.maximumEstimatedGasCostPls,
    routeProtocols: routeProtocols(params.quote),
    methodParameterFingerprint: params.methodParameterFingerprint,
    upstreamCalldataFingerprint: params.checkpoints.upstream?.fingerprint,
    preparedCalldataFingerprint: params.checkpoints.prepared?.fingerprint,
    decoderInputFingerprint: params.checkpoints.decoder?.fingerprint,
    walletInspectionInputFingerprint: params.checkpoints.walletInspection?.fingerprint,
    simulationInputFingerprint: params.checkpoints.simulation?.fingerprint,
    proposalInputFingerprint: params.checkpoints.proposal?.fingerprint,
    savedProposalCalldataFingerprint: params.savedProposalCalldataFingerprint,
    calldataHexCharacterCount: params.checkpoints.upstream?.hexCharacterCount,
    calldataByteLength: params.checkpoints.upstream?.byteLength,
    topLevelDecodeStatus: params.decoded.topLevelDecodeStatus,
    decodeKnowledge: params.review?.decodeKnowledge.status,
    agentGuidance: params.review?.agentGuidance,
    twoRpcSimulation: params.twoRpcSimulation,
    internalProposalSimulation: params.proposal?.simulation,
    proposalId: params.proposal?.id,
    proposalCreatedAt: params.proposal?.createdAt,
    proposalExpiresAt: params.proposal?.expiresAt,
    proposalStatus: params.proposal?.status,
    estimatedGas: params.estimatedGas,
    estimatedGasCostPls: params.estimatedGasCostPls,
    everyCalldataFingerprintMatched: assertCalldataHandoffIntegrity(
      Object.values(params.checkpoints),
    ).ok,
  };
}

export async function runPiteasProposeAgentSwap(
  config: AppConfig,
  input: PiteasProposeAgentSwapInput,
  deps: PiteasAgentSwapDeps = defaultPiteasAgentSwapDeps,
): Promise<PiteasProposeAgentSwapOutput> {
  const allowedSlippage = input.allowedSlippage ?? DEFAULT_ALLOWED_SLIPPAGE;
  const maximumQuoteAgeMs = input.maximumQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const requireTwoRpcSimulation = input.requireTwoRpcSimulation ?? true;

  try {
    const amountRaw = parseDecimalUint(input.amountRaw, "amountRaw").toString();
    if (BigInt(amountRaw) <= 0n) {
      return failure("UNKNOWN_FAIL_CLOSED", "input", "amountRaw must be positive");
    }
    const minimumExecutableOutputFloorRaw =
      input.minimumExecutableOutputRaw === undefined
        ? undefined
        : parseDecimalUint(
            input.minimumExecutableOutputRaw,
            "minimumExecutableOutputRaw",
          ).toString();
    const maximumEstimatedGasCostPls = input.maximumEstimatedGasCostPls;
    const maximumEstimatedGasCostWei =
      maximumEstimatedGasCostPls === undefined
        ? undefined
        : parsePlainDecimalPlsToWei(
            maximumEstimatedGasCostPls,
            "maximumEstimatedGasCostPls",
          );
    if (config.network !== "mainnet") {
      return failure(
        "UNKNOWN_FAIL_CLOSED",
        "runtime",
        `Piteas wallet proposals require PulseChain mainnet chain ID ${PULSECHAIN_CHAIN_ID}`,
      );
    }
    if (
      !Number.isFinite(maximumQuoteAgeMs) ||
      maximumQuoteAgeMs <= 0 ||
      maximumQuoteAgeMs > 10 * 60_000
    ) {
      return failure(
        "UNKNOWN_FAIL_CLOSED",
        "input",
        "maximumQuoteAgeMs must be a positive bounded duration",
      );
    }

    const tokenIn = assertAddress(input.tokenIn);
    const tokenOut = assertAddress(input.tokenOut);
    const swapDirection = classifyPiteasPhiatSwapDirection(tokenIn, tokenOut);
    if (!swapDirection) {
      return failure("UNSUPPORTED_TOKEN_PAIR", "input", "UNSUPPORTED_TOKEN_PAIR", {
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }
    if (!Number.isFinite(allowedSlippage) || allowedSlippage < 0) {
      return failure("UNKNOWN_FAIL_CLOSED", "input", "allowedSlippage must be between 0 and 0.5");
    }
    if (allowedSlippage > DEFAULT_ALLOWED_SLIPPAGE) {
      return failure("SLIPPAGE_LIMIT_EXCEEDED", "input", "SLIPPAGE_LIMIT_EXCEEDED", {
        swapDirection,
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }

    const wallet: AgentWalletPublicInfo = await deps.getAgentWalletInfo(
      config,
      input.walletId,
      { includeBalance: false },
    );
    const walletAddress = wallet.address.toLowerCase() as `0x${string}`;
    if (!wallet.policy.enabled) {
      return failure("UNKNOWN_FAIL_CLOSED", "wallet", "wallet is not enabled", {
        walletId: input.walletId,
        walletAddress,
        swapDirection,
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }
    if (wallet.policy.killed) {
      return failure("UNKNOWN_FAIL_CLOSED", "wallet", "wallet is killed", {
        walletId: input.walletId,
        walletAddress,
        swapDirection,
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }

    const [tokenBalanceRaw, nativeBalanceWei, allowanceRaw] = await Promise.all([
      deps.readTokenBalance(config, tokenIn, walletAddress),
      deps.readNativeBalanceWei(config, walletAddress),
      deps.readTokenAllowance(config, tokenIn, walletAddress, VERIFIED_PITEAS_ROUTER),
    ]);
    const amount = BigInt(amountRaw);
    const inputBalance = parseDecimalUint(tokenBalanceRaw, "tokenBalanceRaw");
    const currentAllowance = parseDecimalUint(allowanceRaw, "allowanceRaw");
    if (input.requireInputAmountEqualsBalance === true && inputBalance !== amount) {
      return failure("INPUT_BALANCE_CHANGED", "wallet_state", "INPUT_BALANCE_CHANGED", {
        walletId: input.walletId,
        walletAddress,
        swapDirection,
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        inputBalanceRaw: inputBalance.toString(),
        currentAllowanceRaw: currentAllowance.toString(),
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }
    if (inputBalance < amount) {
      return failure("UNKNOWN_FAIL_CLOSED", "wallet_state", "insufficient input-token balance", {
        walletId: input.walletId,
        walletAddress,
        swapDirection,
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        inputBalanceRaw: inputBalance.toString(),
        currentAllowanceRaw: currentAllowance.toString(),
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }
    if (currentAllowance < amount) {
      return failure("NEEDS_BOUNDED_ALLOWANCE", "wallet_state", "NEEDS_BOUNDED_ALLOWANCE", {
        walletId: input.walletId,
        walletAddress,
        swapDirection,
        tokenIn,
        tokenOut,
        inputAmountRaw: amountRaw,
        inputBalanceRaw: inputBalance.toString(),
        currentAllowanceRaw: currentAllowance.toString(),
        verifiedSpender: VERIFIED_PITEAS_ROUTER,
        requiredAllowanceRaw: amountRaw,
        unlimitedApproval: false,
        minimumExecutableOutputFloorRaw,
        maximumEstimatedGasCostPls,
      });
    }
    const nativeBalance = parseDecimalUint(nativeBalanceWei, "nativeBalanceWei");
    const outputContext = {
      walletId: input.walletId,
      walletAddress,
      swapDirection,
      tokenIn,
      tokenOut,
      inputAmountRaw: amountRaw,
      inputBalanceRaw: inputBalance.toString(),
      currentAllowanceRaw: currentAllowance.toString(),
      minimumExecutableOutputFloorRaw,
      maximumEstimatedGasCostPls,
    };

    const quote = await deps.getPiteasQuote(config, {
      tokenIn,
      tokenOut,
      amount: amountRaw,
      allowedSlippage,
      account: walletAddress,
    });
    const quoteReceivedMs = deps.nowMs();
    const quoteReceivedAt = new Date(quoteReceivedMs).toISOString();
    if (!quote.ok) {
      return failure(quoteFailureClassification(quote), "quote", quote.reason, {
        ...outputContext,
        quoteReceivedAt,
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
      return failure("INFRASTRUCTURE_REQUOTE_REQUIRED", "quote_validation", quoteFields.reason, {
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
      });
    }

    const calldataValidation = validateExecutableCalldata({
      sourceField: "quote.data.methodParameters.calldata",
      calldata: (
        quoteData.methodParameters as { calldata?: unknown } | undefined
      )?.calldata,
      requiredSelector: PITEAS_ROUTER_SWAP_SELECTOR,
    });
    if (!calldataValidation.ok) {
      return failure("PITEAS_MALFORMED_CALLDATA", "quote_calldata", calldataValidation.reason, {
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint: quoteData.responseFingerprint ?? fingerprint(quoteData),
      });
    }

    const upstreamCalldata = calldataValidation.calldata;
    const methodParameterFingerprint = fingerprint(quoteData.methodParameters);
    const quoteResponseFingerprint = quoteData.responseFingerprint ?? fingerprint({
      amountIn: quoteData.amountIn,
      amountOut: quoteData.amountOut,
      methodParameters: quoteData.methodParameters,
      routeSignature: quoteData.route?.signature ?? null,
    });
    const checkpoints: Record<string, CalldataCheckpoint> = {
      upstream: buildCalldataCheckpoint("upstream", upstreamCalldata),
    };

    const prepared: PiteasPrepareResult = deps.preparePiteasSwap(quoteData, {
      account: walletAddress,
    });
    if (!prepared.ok) {
      return failure("PITEAS_MALFORMED_CALLDATA", "prepare", prepared.reason, {
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint,
      });
    }
    checkpoints.prepared = buildCalldataCheckpoint("prepared", prepared.intent.data);
    const preparedHandoff = assertCalldataHandoffIntegrity([
      checkpoints.upstream,
      checkpoints.prepared,
    ]);
    if (!preparedHandoff.ok) {
      return failure("CALLDATA_HANDOFF_MISMATCH", "prepare", preparedHandoff.reason, {
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint,
        upstreamCalldataFingerprint: checkpoints.upstream.fingerprint,
        preparedCalldataFingerprint: checkpoints.prepared.fingerprint,
        calldataByteLength: checkpoints.upstream.byteLength,
        everyCalldataFingerprintMatched: false,
      });
    }
    if (prepared.intent.to.toLowerCase() !== VERIFIED_PITEAS_ROUTER.toLowerCase()) {
      return failure("UNKNOWN_FAIL_CLOSED", "prepare", "prepared destination is not verified Piteas router", {
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint,
      });
    }

    checkpoints.decoder = buildCalldataCheckpoint("decoder", prepared.intent.data);
    const decodedResult = deps.decodePiteasRouterSwapCalldata({
      to: prepared.intent.to,
      data: prepared.intent.data,
      valueWei: prepared.intent.valueWei,
    });
    if (!decodedResult.ok) {
      return failure("PITEAS_MALFORMED_CALLDATA", "strict_decode", decodedResult.reason, {
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint,
        upstreamCalldataFingerprint: checkpoints.upstream.fingerprint,
        preparedCalldataFingerprint: checkpoints.prepared.fingerprint,
        decoderInputFingerprint: checkpoints.decoder.fingerprint,
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
      return failure("PITEAS_MALFORMED_CALLDATA", "strict_decode", decodedValidation.reason, {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
        }),
      });
    }
    if (
      minimumExecutableOutputFloorRaw !== undefined &&
      BigInt(decoded.destinationMinimumAmountRaw) < BigInt(minimumExecutableOutputFloorRaw)
    ) {
      return failure("MINIMUM_OUTPUT_BELOW_FLOOR", "strict_decode", "MINIMUM_OUTPUT_BELOW_FLOOR", {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
        }),
      });
    }

    checkpoints.walletInspection = buildCalldataCheckpoint(
      "walletInspection",
      prepared.intent.data,
    );
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
    const inspectionValidation = validateWalletInspection(review, decoded);
    if (!inspectionValidation.ok) {
      return failure("PITEAS_MALFORMED_CALLDATA", "wallet_inspection", inspectionValidation.reason, {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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
      return failure(
        "CALLDATA_HANDOFF_MISMATCH",
        "pre_simulation_handoff",
        handoffBeforeSimulation.reason,
        selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
        }),
      );
    }

    const twoRpcSimulation = await deps.simulateSameBlock(
      config,
      {
        from: walletAddress,
        to: prepared.intent.to,
        data: prepared.intent.data as `0x${string}`,
        valueWei: prepared.intent.valueWei,
      },
      requireTwoRpcSimulation,
    );
    const simulationValidation = validateTwoRpcSimulation(
      twoRpcSimulation,
      requireTwoRpcSimulation,
      minimumExecutableOutputFloorRaw,
    );
    if (!simulationValidation.ok) {
      return failure(simulationValidation.classification, "same_block_simulation", simulationValidation.reason, {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
          quote: quoteData,
          methodParameterFingerprint,
          checkpoints,
          decoded,
          review,
          twoRpcSimulation,
        }),
      });
    }

    const gasEstimateBig = maxGasEstimate(twoRpcSimulation);
    if (gasEstimateBig === null) {
      return failure("UNKNOWN_FAIL_CLOSED", "gas", "missing gas estimate after simulation", {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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
    if (
      maximumEstimatedGasCostWei !== undefined &&
      gasCost.costWei > maximumEstimatedGasCostWei
    ) {
      return failure("GAS_COST_ABOVE_LIMIT", "gas", "GAS_COST_ABOVE_LIMIT", {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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
    const nativeValue = parseDecimalUint(prepared.intent.valueWei, "prepared.valueWei");
    if (nativeBalance < gasCost.costWei + nativeValue) {
      return failure("UNKNOWN_FAIL_CLOSED", "wallet_state", "insufficient PLS for estimated gas", {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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
      return failure(
        "CALLDATA_HANDOFF_MISMATCH",
        "pre_proposal_handoff",
        handoffBeforeProposal.reason,
        selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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

    const ageBeforeProposalMs = deps.nowMs() - quoteReceivedMs;
    if (ageBeforeProposalMs > maximumQuoteAgeMs) {
      return failure("QUOTE_STALE", "quote_freshness", "quote stale before proposal creation", {
        ...selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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

    const proposalExpiresAt = new Date(quoteReceivedMs + maximumQuoteAgeMs).toISOString();
    let proposal: TxProposalWithReview;
    try {
      proposal = await deps.proposeAgentTx(config, {
        walletId: input.walletId,
        to: prepared.intent.to,
        valuePls: prepared.intent.valuePls,
        data: prepared.intent.data as `0x${string}`,
        requireSimulationSuccess: true,
        proposalExpiresAt,
        provenance: {
          kind: "piteas_inprocess_agent_swap_v1",
          quoteResponseFingerprint,
          quoteReceivedAt,
          sourceField: "quote.data.methodParameters.calldata",
          calldataFingerprint: checkpoints.upstream.fingerprint,
          methodParameterFingerprint,
          calldataHexCharacterCount: checkpoints.upstream.hexCharacterCount,
          calldataByteLength: checkpoints.upstream.byteLength,
          calldataFirst10: checkpoints.upstream.first10,
          calldataFinal10: checkpoints.upstream.final10,
          swapDirection,
          tokenIn,
          tokenOut,
          expectedOutputRaw: quoteData.amountOut,
          executableMinimumOutputRaw: decoded.destinationMinimumAmountRaw,
          minimumExecutableOutputFloorRaw,
          maximumEstimatedGasCostPls,
          inputAmountRaw: amountRaw,
          inputBalanceRaw: inputBalance.toString(),
          currentAllowanceRaw: currentAllowance.toString(),
          router: VERIFIED_PITEAS_ROUTER,
          walletRecipient: walletAddress,
          routeProtocols: routeProtocols(quoteData),
          residualUncertainty: decoded.residualUncertainty,
        },
      });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : "proposal internal simulation failed";
      return failure(
        "PROPOSAL_INTERNAL_SIMULATION_FAILED",
        "proposal_internal_simulation",
        reason,
        selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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
      saved.to.toLowerCase() === prepared.intent.to.toLowerCase() &&
      saved.valueWei === prepared.intent.valueWei &&
      saved.walletId === input.walletId &&
      saved.from.toLowerCase() === walletAddress.toLowerCase() &&
      saved.status === "pending" &&
      saved.expiresAt === proposalExpiresAt;
    if (!savedIntegrityOk) {
      saved.status = "rejected";
      deps.saveProposal(config, saved);
      return failure(
        "SAVED_PROPOSAL_INTEGRITY_MISMATCH",
        "saved_proposal_integrity",
        savedHandoff.ok ? "saved proposal fields do not match prepared transaction" : savedHandoff.reason,
        selectedOutputFields({
          ...outputContext,
          quoteReceivedAt,
          quoteResponseFingerprint,
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

    const unexpired = Date.parse(saved.expiresAt) > deps.nowMs();
    const ready =
      proposal.simulation.ok &&
      saved.status === "pending" &&
      unexpired &&
      review.decodeKnowledge.status === "known_top_level_with_opaque_route" &&
      review.agentGuidance === "review_carefully";

    return {
      ok: true,
      classification: "READY_FOR_HUMAN_CONFIRMATION",
      ...selectedOutputFields({
        ...outputContext,
        quoteReceivedAt,
        quoteResponseFingerprint,
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
      readyForHumanConfirmation: ready,
    };
  } catch (err) {
    return failure(
      "UNKNOWN_FAIL_CLOSED",
      "unexpected",
      err instanceof Error ? err.message : String(err),
    );
  }
}

type JsonRpcErrorObject = {
  code?: number;
  message?: string;
  data?: unknown;
};

class JsonRpcCallError extends Error {
  code?: number;
  data?: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message ?? "JSON-RPC error");
    this.code = error.code;
    this.data = error.data;
  }
}

function toRpcQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

function decimalFromRpcQuantity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} returned malformed hex quantity`);
  }
  return BigInt(value).toString();
}

function uint256OutputToDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error("eth_call returned malformed hex data");
  }
  if (value === "0x") return "0";
  return BigInt(value).toString();
}

function safeErrorString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function revertDataFromError(err: unknown): string | null {
  if (err instanceof JsonRpcCallError && typeof err.data === "string") {
    return err.data;
  }
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string") return data;
  }
  return null;
}

function decodedRevertFromError(err: unknown): string | null {
  const message = safeErrorString(err);
  const data = revertDataFromError(err);
  return data ? `${message}; data=${data}` : message;
}

async function postJsonRpc(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      result?: unknown;
      error?: JsonRpcErrorObject;
    };
    if (json.error) throw new JsonRpcCallError(json.error);
    return json.result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${method} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function uniqueRpcUrls(config: AppConfig): string[] {
  const urls = config.rpcUrls.length > 0 ? config.rpcUrls : [config.rpcUrl];
  return Array.from(new Set(urls.filter((url) => url.trim() !== "")));
}

export async function simulateSameBlockTwoRpc(
  config: AppConfig,
  tx: {
    from: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    valueWei: string;
  },
  requireTwoRpcSimulation: boolean,
): Promise<RpcPinnedSimulationRow[]> {
  const required = requireTwoRpcSimulation ? 2 : 1;
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const probed: Array<{ url: string; block: bigint }> = [];
  const urls = uniqueRpcUrls(config);
  for (const url of urls) {
    try {
      const chainIdHex = await postJsonRpc(
        url,
        "eth_chainId",
        [],
        RPC_SIMULATION_TIMEOUT_MS,
        fetchImpl,
      );
      const chainId = BigInt(decimalFromRpcQuantity(chainIdHex, "eth_chainId"));
      if (chainId !== BigInt(PULSECHAIN_CHAIN_ID)) continue;
      const blockHex = await postJsonRpc(
        url,
        "eth_blockNumber",
        [],
        RPC_SIMULATION_TIMEOUT_MS,
        fetchImpl,
      );
      probed.push({
        url,
        block: BigInt(decimalFromRpcQuantity(blockHex, "eth_blockNumber")),
      });
      if (probed.length >= required) break;
    } catch {
      continue;
    }
  }
  if (probed.length < required) return [];

  const pinnedBlock = probed.reduce(
    (min, entry) => (entry.block < min ? entry.block : min),
    probed[0]!.block,
  );
  const pinnedBlockHex = toRpcQuantity(pinnedBlock);
  const callObject = {
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: toRpcQuantity(parseDecimalUint(tx.valueWei, "valueWei")),
  };

  const rows: RpcPinnedSimulationRow[] = [];
  for (const entry of probed) {
    const row: RpcPinnedSimulationRow = {
      rpc: entry.url,
      pinnedBlock: pinnedBlock.toString(),
      ethCallPassed: false,
      outputRaw: null,
      revertData: null,
      decodedRevert: null,
      estimateGasPassed: false,
      gasEstimate: null,
      error: null,
    };
    try {
      const callResult = await postJsonRpc(
        entry.url,
        "eth_call",
        [callObject, pinnedBlockHex],
        RPC_SIMULATION_TIMEOUT_MS,
        fetchImpl,
      );
      row.outputRaw = uint256OutputToDecimal(callResult);
      row.ethCallPassed = BigInt(row.outputRaw) > 0n;
      if (!row.ethCallPassed) row.error = "eth_call returned zero output";
    } catch (err) {
      row.error = safeErrorString(err);
      row.revertData = revertDataFromError(err);
      row.decodedRevert = decodedRevertFromError(err);
    }
    try {
      const gasResult = await postJsonRpc(
        entry.url,
        "eth_estimateGas",
        [callObject, pinnedBlockHex],
        RPC_SIMULATION_TIMEOUT_MS,
        fetchImpl,
      );
      row.gasEstimate = decimalFromRpcQuantity(gasResult, "eth_estimateGas");
      row.estimateGasPassed = BigInt(row.gasEstimate) > 0n;
      if (!row.estimateGasPassed) {
        row.error = [row.error, "eth_estimateGas returned zero"].filter(Boolean).join("; ");
      }
    } catch (err) {
      row.error = [row.error, safeErrorString(err)].filter(Boolean).join("; ");
      row.revertData ??= revertDataFromError(err);
      row.decodedRevert ??= decodedRevertFromError(err);
    }
    rows.push(row);
  }
  return rows;
}

export function registerPiteasProposeAgentSwapTool(
  server: McpServer,
  config: AppConfig,
): void {
  const addressSchema = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("0x-prefixed token address");

  registerTool(server, config, {
    name: "piteas_propose_agent_swap",
    description:
      "Fetch exactly one fresh Piteas quote and create one unsigned local agent-wallet " +
      "proposal entirely inside this MCP process. The caller supplies walletId, tokenIn, " +
      "tokenOut, and amountRaw for the PHIAT/eUSDC pair only, in either direction; raw calldata is never supplied by or returned to the " +
      "model. The handler preserves exact calldata in memory through strict quote " +
      "validation, Piteas top-level decode, native wallet inspection, same-block multi-RPC " +
      "simulation, and propose_agent_tx with requireSimulationSuccess=true. It never signs, " +
      "submits, broadcasts, executes, creates approvals, or changes allowances.",
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: z
        .string()
        .regex(/^aw_[a-f0-9]{32}$/)
        .describe("Agent wallet id"),
      tokenIn: addressSchema.describe("Input token address; supported pairs are eUSDC->PHIAT and PHIAT->eUSDC"),
      tokenOut: addressSchema.describe("Output token address; supported pairs are eUSDC->PHIAT and PHIAT->eUSDC"),
      amountRaw: z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .describe("Input token raw amount as a decimal integer string"),
      allowedSlippage: z
        .number()
        .min(0)
        .max(DEFAULT_ALLOWED_SLIPPAGE)
        .default(DEFAULT_ALLOWED_SLIPPAGE)
        .describe("Piteas allowed slippage percent for PHIAT/eUSDC swaps; default and maximum 0.5"),
      maximumQuoteAgeMs: z
        .number()
        .int()
        .min(1)
        .max(10 * 60_000)
        .default(DEFAULT_MAX_QUOTE_AGE_MS)
        .describe("Maximum age from quote response to proposal save; default 60000"),
      requireTwoRpcSimulation: z
        .boolean()
        .default(true)
        .describe("Require same-block eth_call and estimateGas to pass on two RPCs"),
      minimumExecutableOutputRaw: z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .optional()
        .describe("Optional raw output floor; decoded minOut and RPC outputs must be at least this amount"),
      maximumEstimatedGasCostPls: z
        .string()
        .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
        .optional()
        .describe("Optional positive plain-decimal PLS gas-cost ceiling compared to conservative estimated cost"),
      requireInputAmountEqualsBalance: z
        .boolean()
        .optional()
        .describe("When true, amountRaw must equal the live input-token balance exactly"),
    },
    handler: async (args, cfg) =>
      ok(
        neverReturnPrivateKey(
          await runPiteasProposeAgentSwap(cfg, {
            walletId: String(args.walletId),
            tokenIn: String(args.tokenIn),
            tokenOut: String(args.tokenOut),
            amountRaw: String(args.amountRaw),
            allowedSlippage:
              (args.allowedSlippage as number | undefined) ?? DEFAULT_ALLOWED_SLIPPAGE,
            maximumQuoteAgeMs:
              (args.maximumQuoteAgeMs as number | undefined) ?? DEFAULT_MAX_QUOTE_AGE_MS,
            requireTwoRpcSimulation:
              (args.requireTwoRpcSimulation as boolean | undefined) ?? true,
            minimumExecutableOutputRaw: args.minimumExecutableOutputRaw as string | undefined,
            maximumEstimatedGasCostPls: args.maximumEstimatedGasCostPls as string | undefined,
            requireInputAmountEqualsBalance:
              args.requireInputAmountEqualsBalance as boolean | undefined,
          }),
        ),
      ),
  });
}
