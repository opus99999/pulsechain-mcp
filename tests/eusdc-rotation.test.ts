import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import type { AppConfig } from "../src/types.js";
import {
  EUSDC_TOKEN_ADDRESS,
  decodePiteasRouterSwapCalldata,
  fingerprint,
  piteasRouterSwapAbi,
  VERIFIED_PITEAS_ROUTER,
} from "../src/piteas/routerIntent.js";
import {
  atomicWriteJson,
  buildAgentIntentView,
  DEFAULT_POLICY,
  inspectTokenNotional,
  type AgentWalletPublicInfo,
  type TxProposal,
  type TxProposalWithReview,
} from "../src/wallet/index.js";
import {
  EUSDC_ROTATION_CANDIDATES,
  PRVX_ADDRESS,
  analyzeRotationCandles,
  analyzeHistoricalReversions,
  buildCandidateScanRow,
  buildFiveMinuteCandles,
  calculatePairLiquidityEusdc,
  calculatePriceContinuityPercent,
  classifyHistoryAnalysisMode,
  computeScanEconomicFeasibility,
  computeRequiredFinalEusdcRaw,
  computeSimpleBalanceTargetRaw,
  consolidateRotationPools,
  deriveRouteConnectivity,
  getRotationCandidate,
  getRotationCandidateRegistry,
  mergeRotationHistoryRecords,
  normalizeTokenAmount,
  priceObservationFromSwap,
  rangeFullyScanned,
  reduceLogChunkAfterRangeError,
  resolveTimestampBlockRange,
  swapQueryPlanForSourcePool,
  dedupeSourcePools,
  legacyCwdDerivedHistoryStorePath,
  readRotationHistoryStore,
  resetEusdcRotationForTests,
  resolveEusdcRotationHistoryStorePath,
  resolveEusdcRotationRepositoryRoot,
  runEusdcRotationHistorySync,
  runEusdcRotationHistoryStatus,
  runEusdcRotationProposeEntry,
  runEusdcRotationProposeExit,
  runEusdcRotationScan,
  selectRotationWinner,
  shouldUseRpcLogFallback,
  type RotationPriceObservation,
  type RotationCandidateId,
  type RotationDeps,
  type RotationHistoryRecord,
  type RotationHistorySourcePoolRef,
  type RotationMarketEvidence,
  type RotationTokenValidation,
} from "../src/tools/wallet/eusdcRotation.js";
import {
  HEX_ADDRESS,
  INC_ADDRESS,
  PLSX_ADDRESS,
  WPLS_ADDRESS,
} from "../src/constants.js";
import type { SubgraphPair, SubgraphSwap } from "../src/data/index.js";

const WALLET_ID = "aw_524fe256dc97aff6b28c1e6992c7a27c";
const WALLET = "0x64443a931c6d6096c8de27711f2a525393c21133" as const;
const STARTING_EUSDC = "5222672";
const BASE_NOW = Date.parse("2026-08-05T12:00:00.000Z");
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  resetEusdcRotationForTests();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "eusdc-rotation-"));
  tempDirs.push(dir);
  return {
    rpcUrl: "https://rpc-a.example",
    rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: "not-used-by-mocked-workflow",
    agentWalletDir: dir,
    agentWalletMultiprocStrict: true,
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5_000,
  };
}

function walletInfo(): AgentWalletPublicInfo {
  return {
    id: WALLET_ID,
    address: WALLET,
    createdAt: new Date(BASE_NOW).toISOString(),
    policy: DEFAULT_POLICY(100, 1000),
    dailySpend: { date: "2026-08-05", spentPls: 0, spentWei: "0" },
    tokenDailySpend: {},
    legacyCapsDisplayOnly: true,
    legacyCapsNote: "display only",
  };
}

function validation(candidateId: RotationCandidateId, overrides: Partial<RotationTokenValidation> = {}): RotationTokenValidation {
  const candidate = getRotationCandidate(candidateId);
  return {
    chainId: 369,
    codeExists: true,
    symbol: candidate.expectedSymbol,
    name: candidate.expectedNamePatterns[0] ?? candidate.expectedSymbol,
    decimals: candidate.expectedDecimals,
    transferProbeOk: true,
    balanceOfReadable: true,
    allowanceReadable: true,
    routeToBaseAvailable: true,
    routeFromBaseAvailable: true,
    ok: true,
    rejectionReasons: [],
    ...overrides,
  };
}

function market(overrides: Partial<RotationMarketEvidence> = {}): RotationMarketEvidence {
  return {
    relevantPools: ["0x1111111111111111111111111111111111111111"],
    largestPoolLiquidityUsd: 100_000,
    aggregateLiquidityUsd: 150_000,
    recentVolumeUsd: 5_000,
    tradeCount: 30,
    fiveMinuteReturnBps: 25,
    fifteenMinuteReturnBps: 45,
    oneHourReturnBps: -125,
    sixHourReturnBps: -90,
    distanceFromOneHourHighBps: -130,
    distanceFromOneHourLowBps: 35,
    reboundFromRecentLocalLowBps: 35,
    realizedVolatilityBps: 80,
    directionalTrendScore: 5,
    meanReversionScore: 80,
    liquidityScore: 75,
    volumeScore: 70,
    routeQualityScore: 80,
    volatilitySuitabilityScore: 75,
    estimatedPriceImpactPercent: 0.12,
    routeAvailabilityStatus: "both_directions",
    evidenceFresh: true,
    dataSourceErrors: [],
    tokenPath: [EUSDC_TOKEN_ADDRESS, WPLS_ADDRESS],
    ...overrides,
  };
}

function pairFixture(input: {
  id: string;
  token0: string;
  token1: string;
  symbol0?: string;
  symbol1?: string;
  decimals0?: string;
  decimals1?: string;
  reserve0: string;
  reserve1: string;
  reserveUSD?: string;
}): SubgraphPair {
  return {
    id: input.id,
    token0: {
      id: input.token0.toLowerCase(),
      symbol: input.symbol0 ?? "T0",
      decimals: input.decimals0 ?? "18",
    },
    token1: {
      id: input.token1.toLowerCase(),
      symbol: input.symbol1 ?? "T1",
      decimals: input.decimals1 ?? "18",
    },
    reserve0: input.reserve0,
    reserve1: input.reserve1,
    reserveUSD: input.reserveUSD ?? "0",
    volumeUSD: "0",
    totalTransactions: "0",
    token0Price: "0",
    token1Price: "0",
  };
}

function swapFixture(input: {
  id: string;
  timestamp: number;
  pair: SubgraphPair;
  amount0In?: string;
  amount1In?: string;
  amount0Out?: string;
  amount1Out?: string;
  amountUSD?: string;
  tx?: string;
}): SubgraphSwap {
  return {
    id: input.id,
    timestamp: String(input.timestamp),
    pair: {
      id: input.pair.id,
      token0: input.pair.token0,
      token1: input.pair.token1,
    },
    amount0In: input.amount0In ?? "0",
    amount1In: input.amount1In ?? "0",
    amount0Out: input.amount0Out ?? "0",
    amount1Out: input.amount1Out ?? "0",
    amountUSD: input.amountUSD ?? "0",
    transaction: { id: input.tx ?? `0xtx${input.id}` },
  };
}

function sourcePoolFixture(input: {
  pair: SubgraphPair;
  sourceVersion: "PULSEX_V1" | "PULSEX_V2";
  endpoint?: string;
  liquidityEusdc?: number;
  recentVolumeEusdc?: number;
}): RotationHistorySourcePoolRef {
  const subgraphVersion = input.sourceVersion === "PULSEX_V1" ? "v1" : "v2";
  return {
    pair: input.pair,
    protocol: input.sourceVersion === "PULSEX_V1" ? "PulseX V1" : "PulseX V2",
    sourceVersion: input.sourceVersion,
    subgraphVersion,
    subgraphEndpoint: input.endpoint ?? `https://example.com/${subgraphVersion}`,
    eventAdapter: "PULSEX_V2_STYLE_SWAP",
    factoryAddress: null,
    classification: "REQUIRED_PRICE_POOL",
    contributesToConsolidatedPrice: true,
    liquidityEusdc: input.liquidityEusdc ?? 10_000,
    recentVolumeEusdc: input.recentVolumeEusdc ?? 1_000,
  };
}

function observation(timestamp: number, price: number, id: string, volumeEusdc = 10): RotationPriceObservation {
  return {
    timestamp,
    priceEusdc: price,
    volumeEusdc,
    swapId: id,
    source: "fixture",
  };
}

function historyRecord(input: {
  candidateId?: RotationCandidateId;
  tx?: `0x${string}`;
  logIndex?: number;
  timestamp: number;
  price?: number;
  blockNumber?: string | null;
  blockHash?: `0x${string}` | null;
  source?: string;
}): RotationHistoryRecord {
  return {
    chainId: 369,
    candidateId: input.candidateId ?? "PLSX",
    poolAddress: "0x3000000000000000000000000000000000000002",
    factoryAddress: null,
    protocol: "PulseX V2",
    blockNumber: input.blockNumber ?? null,
    blockHash: input.blockHash ?? null,
    transactionHash: input.tx ?? (`0x${String(input.logIndex ?? 1).padStart(64, "0")}` as `0x${string}`),
    logIndex: input.logIndex ?? 0,
    timestamp: input.timestamp,
    token0: PLSX_ADDRESS,
    token1: EUSDC_TOKEN_ADDRESS,
    amount0Raw: "1000000000000000000",
    amount1Raw: "1000000",
    candidatePriceEusdc: input.price ?? 1,
    eusdcNotionalRaw: "1000000",
    source: input.source ?? "fixture",
    fetchedAt: new Date(BASE_NOW).toISOString(),
  };
}

function piteasCalldata(params: {
  srcToken: `0x${string}`;
  destToken: `0x${string}`;
  srcAmount: string;
  destMinAmount: string;
  routeData?: Hex;
}): Hex {
  return encodeFunctionData({
    abi: piteasRouterSwapAbi,
    functionName: "swap",
    args: [
      {
        srcToken: params.srcToken,
        destToken: params.destToken,
        destAccount: WALLET,
        srcAmount: BigInt(params.srcAmount),
        destMinAmount: BigInt(params.destMinAmount),
      },
      params.routeData ?? "0x12345678",
    ],
  });
}

function quote(params: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountRaw: string;
  amountOut: string;
  minOut: string;
}) {
  const calldata = piteasCalldata({
    srcToken: params.tokenIn,
    destToken: params.tokenOut,
    srcAmount: params.amountRaw,
    destMinAmount: params.minOut,
  });
  const data = {
    srcToken: { address: params.tokenIn, symbol: "IN", decimals: 18, chainId: 369 },
    destToken: { address: params.tokenOut, symbol: "OUT", decimals: 18, chainId: 369 },
    amountIn: params.amountRaw,
    amountOut: params.amountOut,
    amountOutMin: params.minOut,
    amountOutMinSource: "upstream" as const,
    valueWei: "0",
    valuePls: "0",
    methodParameters: { calldata, value: "0x0" },
    router: VERIFIED_PITEAS_ROUTER,
    route: {
      protocols: ["PulseX V2"],
      pools: ["0x1111111111111111111111111111111111111111"],
      tokenPath: [params.tokenIn, WPLS_ADDRESS, params.tokenOut],
      pathCount: 1,
      swapCount: 2,
    },
    tokenInParam: params.tokenIn,
    tokenOutParam: params.tokenOut,
    allowedSlippage: 0.5,
    account: WALLET,
    chainId: 369,
    quoteReady: true,
    advisory: true,
    note: "mock",
    decodeNote: "mock",
    responseFingerprint: fingerprint({ calldata, amountOut: params.amountOut }),
  };
  return { ok: true as const, source: "piteas" as const, advisory: true as const, data };
}

function proposalFromReq(req: Parameters<RotationDeps["proposeAgentTx"]>[1]): TxProposalWithReview {
  return {
    id: "prop_aaaaaaaaaaaaaaaaaaaaaaaa",
    walletId: req.walletId,
    from: WALLET,
    to: req.to,
    valueWei: "0",
    valuePls: 0,
    data: req.data ?? "0x",
    createdAt: new Date(BASE_NOW).toISOString(),
    expiresAt: req.proposalExpiresAt ?? new Date(BASE_NOW + 60_000).toISOString(),
    simulation: { attempted: true, ok: true, gasEstimate: "1000" },
    policyCheck: {
      allowed: true,
      reasons: [],
      isContractInteraction: true,
      destinationIsContract: true,
      valuePls: 0,
      valueWei: "0",
      projectedDailySpend: 0,
      projectedDailySpendWei: "0",
      remainingDaily: 1000,
      remainingDailyWei: "1000000000000000000000",
      legacyCapsDisplayOnly: true,
      allowlistExpired: false,
    },
    status: "pending",
    provenance: req.provenance,
    reviewSummary: {} as TxProposalWithReview["reviewSummary"],
  };
}

function deps(overrides: Partial<RotationDeps> = {}): RotationDeps {
  let saved: TxProposal | null = null;
  const d: RotationDeps = {
    nowMs: vi.fn(() => BASE_NOW),
    getChainId: vi.fn(async () => 369),
    getAgentWalletInfo: vi.fn(async () => walletInfo()),
    listAgentWallets: vi.fn(() => [walletInfo()]),
    agentWalletSystemStatus: vi.fn(() => ({
      agentWalletEnabled: true,
      masterKeyConfigured: true,
      walletDirOwnership: { status: "ours", ownerPid: process.pid },
      multiProcessRisk: false,
      writesBlocked: false,
    })),
    getTokenValidation: vi.fn(async (_config, candidate) =>
      validation(candidate.candidateId),
    ),
    fetchCandidateMarketEvidence: vi.fn(async (_config, candidate) =>
      candidate.candidateId === "PLSX"
        ? market({ meanReversionScore: 90, liquidityScore: 90, volumeScore: 85 })
        : market({ distanceFromOneHourHighBps: -20, reboundFromRecentLocalLowBps: 0 }),
    ),
    readTokenBalance: vi.fn(async (_config, token) => {
      if (token.toLowerCase() === EUSDC_TOKEN_ADDRESS.toLowerCase()) return STARTING_EUSDC;
      if (token.toLowerCase() === PLSX_ADDRESS.toLowerCase()) return "1000000000000000000000";
      return "0";
    }),
    readTokenAllowance: vi.fn(async () => STARTING_EUSDC),
    readNativeBalanceWei: vi.fn(async () => "2000000000000000000000"),
    getPiteasQuote: vi.fn(async (_config, req) =>
      quote({
        tokenIn: req.tokenIn as `0x${string}`,
        tokenOut: req.tokenOut as `0x${string}`,
        amountRaw: req.amount,
        amountOut: "1000000000000000000000",
        minOut: "990000000000000000000",
      }),
    ),
    preparePiteasSwap: vi.fn((data) => ({
      ok: true,
      source: "piteas",
      advisory: true,
      broadcast: false,
      intent: {
        to: VERIFIED_PITEAS_ROUTER,
        data: data.methodParameters.calldata,
        valueWei: "0",
        valuePls: "0",
      },
      review: {
        tokenIn: data.srcToken.address,
        tokenOut: data.destToken.address,
        tokenInParam: data.tokenInParam,
        tokenOutParam: data.tokenOutParam,
        amountIn: data.amountIn,
        amountOut: data.amountOut,
        amountOutMin: data.amountOutMin,
        recipient: WALLET,
        allowedSlippage: data.allowedSlippage,
        router: VERIFIED_PITEAS_ROUTER,
        sellingNativePls: false,
        localDecodeExpect: "unknown_selector_likely",
      },
      methodParameters: data.methodParameters,
      nextStep: "mock",
      note: "mock",
    })),
    decodePiteasRouterSwapCalldata: vi.fn((params) =>
      decodePiteasRouterSwapCalldata(params),
    ),
    inspectTokenNotional,
    buildAgentIntentView,
    simulateSameBlock: vi.fn(async () => [
      {
        rpc: "https://rpc-a.example",
        pinnedBlock: "100",
        ethCallPassed: true,
        outputRaw: "990000000000000000000",
        revertData: null,
        decodedRevert: null,
        estimateGasPassed: true,
        gasEstimate: "1000",
        error: null,
      },
      {
        rpc: "https://rpc-b.example",
        pinnedBlock: "100",
        ethCallPassed: true,
        outputRaw: "990000000000000000000",
        revertData: null,
        decodedRevert: null,
        estimateGasPassed: true,
        gasEstimate: "1000",
        error: null,
      },
    ]),
    getFeeData: vi.fn(async () => ({
      gasPriceWei: "1000000000000000000",
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    })),
    proposeAgentTx: vi.fn(async (_config, req) => {
      saved = proposalFromReq(req);
      return saved;
    }),
    executeAgentTx: vi.fn(async () => ({
      txHash: "0x" + "12".repeat(32) as `0x${string}`,
      proposalId: "prop_aaaaaaaaaaaaaaaaaaaaaaaa",
      walletId: WALLET_ID,
      from: WALLET,
      to: VERIFIED_PITEAS_ROUTER,
      valuePls: 0,
      valueWei: "0",
      simulation: { attempted: true, ok: true, gasEstimate: "1000" },
      reviewSummary: {} as Awaited<ReturnType<RotationDeps["executeAgentTx"]>>["reviewSummary"],
    })),
    loadProposal: vi.fn((_config, id) => {
      if (!saved || saved.id !== id) throw new Error("missing saved proposal");
      return saved;
    }),
    getTransactionReceipt: vi.fn(async () => ({
      transactionHash: "0x" + "12".repeat(32),
      status: "success",
      blockNumber: "123",
      blockHash: "0x" + "34".repeat(32),
      from: WALLET,
      to: VERIFIED_PITEAS_ROUTER,
      gasUsed: "1000",
      effectiveGasPrice: "1000000000000000000",
      contractAddress: null,
      logsCount: 0,
    })),
  };
  return { ...d, ...overrides };
}

describe("eUSDC five-asset rotation registry and scoring", () => {
  it("contains the strict five-candidate registry with exact execution tokens", () => {
    const registry = getRotationCandidateRegistry();
    expect(registry.map((c) => c.candidateId)).toEqual(["PLS", "PLSX", "INC", "PHEX", "PRVX"]);
    expect(getRotationCandidate("PLS").executionTokenAddress).toBe(WPLS_ADDRESS);
    expect(getRotationCandidate("PLSX").executionTokenAddress).toBe(PLSX_ADDRESS);
    expect(getRotationCandidate("INC").executionTokenAddress).toBe(INC_ADDRESS);
    expect(getRotationCandidate("PHEX").executionTokenAddress).toBe(HEX_ADDRESS);
    expect(getRotationCandidate("PRVX").executionTokenAddress).toBe(PRVX_ADDRESS);
    expect(getRotationCandidate("PLS").displaySymbol).toBe("PLS");
    expect(getRotationCandidate("PLS").expectedSymbol).toBe("WPLS");
    expect(getRotationCandidate("PHEX").expectedDecimals).toBe(8);
  });

  it("calculates the simple 1% eUSDC target exactly and adds gas components", () => {
    expect(computeSimpleBalanceTargetRaw("5222672")).toBe("5274899");
    const target = computeRequiredFinalEusdcRaw({
      startingEusdcRaw: "5222672",
      entryApprovalGasEusdcEquivalentRaw: "10",
      entrySwapGasEusdcEquivalentRaw: "20",
      exitApprovalGasEusdcEquivalentRaw: "30",
      projectedExitSwapGasEusdcEquivalentRaw: "40",
      safetyBufferRaw: "5",
      gasConversionAvailable: true,
      gasConversionSource: "mock WPLS/eUSDC",
    });
    expect(target.requiredFinalEusdcRaw).toBe("5275004");
  });

  it("does not trigger on a one-percent fall without rebound and selects at most one winner when rebound confirms", () => {
    const candidate = getRotationCandidate("PLSX");
    const noRebound = buildCandidateScanRow({
      candidate,
      tokenValidation: validation("PLSX"),
      market: market({ distanceFromOneHourHighBps: -120, reboundFromRecentLocalLowBps: 0 }),
      scanInput: {
        walletId: WALLET_ID,
        lookbackMinutes: 1440,
        candleMinutes: 5,
        minimumDipBps: 100,
        minimumReboundConfirmationBps: 20,
        minimumNetTargetBps: 100,
      },
      state: "EUSDC_IDLE",
      hasOpenCycle: false,
    });
    expect(noRebound.eligibility).toBe(false);
    expect(noRebound.rejectionReasons).toContain("rebound confirmation below threshold");

    const rows = EUSDC_ROTATION_CANDIDATES.map((entry) =>
      buildCandidateScanRow({
        candidate: entry,
        tokenValidation: validation(entry.candidateId),
        market: entry.candidateId === "PLSX" ? market() : market({ recentVolumeUsd: 0 }),
        scanInput: {
          walletId: WALLET_ID,
          lookbackMinutes: 1440,
          candleMinutes: 5,
          minimumDipBps: 100,
          minimumReboundConfirmationBps: 20,
          minimumNetTargetBps: 100,
        },
        state: "EUSDC_IDLE",
        hasOpenCycle: false,
      }),
    );
    const selected = selectRotationWinner(rows);
    expect(selected.decision).toBe("CANDIDATE_SELECTED");
    expect(selected.winner).toBe("PLSX");
    expect(rows.filter((row) => row.eligibility).length).toBe(1);
  });
});

describe("eUSDC rotation scan", () => {
  it("returns all five candidates, never calls Piteas, and can hold when no candidate qualifies", async () => {
    const cfg = testConfig();
    const d = deps({
      fetchCandidateMarketEvidence: vi.fn(async () =>
        market({ distanceFromOneHourHighBps: -10, reboundFromRecentLocalLowBps: 0 }),
      ),
    });
    const result = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    expect(result.candidates.map((row) => row.candidateId)).toEqual(["PLS", "PLSX", "INC", "PHEX", "PRVX"]);
    expect(result.decision).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.noPiteasQuoteUsed).toBe(true);
    expect(d.getPiteasQuote).not.toHaveBeenCalled();
  });

  it("selects a ranked candidate only after full identity, liquidity, route, fall, and rebound evidence pass", async () => {
    const cfg = testConfig();
    const d = deps();
    const result = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    expect(result.decision).toBe("CANDIDATE_SELECTED");
    expect(result.winner).toBe("PLSX");
    expect(result.rankedCandidateIds[0]).toBe("PLSX");
    expect(result.candidates).toHaveLength(5);
  });
});

describe("eUSDC rotation proposal guards", () => {
  it("creates a guarded mocked PLSX entry proposal with one quote and no execution", async () => {
    const cfg = testConfig();
    const d = deps();
    const scan = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    const result = await runEusdcRotationProposeEntry(
      cfg,
      {
        walletId: WALLET_ID,
        expectedCandidateId: "PLSX",
        scanFingerprint: scan.scanFingerprint,
        maximumGasCostPls: "1500",
      },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.classification).toBe("READY_FOR_HUMAN_CONFIRMATION");
    expect(result.candidateId).toBe("PLSX");
    expect(result.tokenIn).toBe(EUSDC_TOKEN_ADDRESS);
    expect(result.tokenOut).toBe(PLSX_ADDRESS);
    expect(result.everyCalldataFingerprintMatched).toBe(true);
    expect(result.proposalStatus).toBe("pending");
    expect(result.quoteCallCount).toBe(1);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(d.executeAgentTx).not.toHaveBeenCalled();
  });

  it.each([
    ["PLS", WPLS_ADDRESS],
    ["PHEX", HEX_ADDRESS],
  ] as const)("creates a mocked %s entry proposal through the registered execution token", async (candidateId, tokenOut) => {
    const cfg = testConfig();
    const d = deps({
      fetchCandidateMarketEvidence: vi.fn(async (_config, candidate) =>
        candidate.candidateId === candidateId
          ? market({
              meanReversionScore: 95,
              liquidityScore: 90,
              volumeScore: 90,
              tokenPath: [EUSDC_TOKEN_ADDRESS, WPLS_ADDRESS, tokenOut],
            })
          : market({ distanceFromOneHourHighBps: -5, reboundFromRecentLocalLowBps: 0 }),
      ),
    });
    const scan = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    const result = await runEusdcRotationProposeEntry(
      cfg,
      {
        walletId: WALLET_ID,
        expectedCandidateId: candidateId,
        scanFingerprint: scan.scanFingerprint,
      },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.candidateId).toBe(candidateId);
    expect(result.tokenOut).toBe(tokenOut);
    expect(result.classification).toBe("READY_FOR_HUMAN_CONFIRMATION");
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(d.executeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects mocked INC for low activity and mocked PRVX for missing route evidence", async () => {
    const cfg = testConfig();
    const d = deps({
      fetchCandidateMarketEvidence: vi.fn(async (_config, candidate) => {
        if (candidate.candidateId === "INC") {
          return market({ recentVolumeUsd: 0, tradeCount: 1 });
        }
        if (candidate.candidateId === "PRVX") {
          return market({
            routeAvailabilityStatus: "none",
            relevantPools: [],
            largestPoolLiquidityUsd: 0,
            aggregateLiquidityUsd: 0,
            estimatedPriceImpactPercent: null,
          });
        }
        return market({ distanceFromOneHourHighBps: -5, reboundFromRecentLocalLowBps: 0 });
      }),
    });
    const scan = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    const inc = scan.candidates.find((row) => row.candidateId === "INC");
    const prvx = scan.candidates.find((row) => row.candidateId === "PRVX");
    expect(inc?.eligibility).toBe(false);
    expect(inc?.rejectionReasons).toContain("recent volume below threshold");
    expect(prvx?.eligibility).toBe(false);
    expect(prvx?.rejectionReasons).toContain("read-only route availability missing in one or both directions");
    expect(d.getPiteasQuote).not.toHaveBeenCalled();
  });

  it("returns exact bounded entry approval requirements without creating an approval or proposal", async () => {
    const cfg = testConfig();
    const d = deps({
      readTokenAllowance: vi.fn(async () => "0"),
    });
    const scan = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    const result = await runEusdcRotationProposeEntry(
      cfg,
      {
        walletId: WALLET_ID,
        expectedCandidateId: "PLSX",
        scanFingerprint: scan.scanFingerprint,
      },
      d,
    );
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("ENTRY_BOUNDED_APPROVAL_REQUIRED");
    expect(result.verifiedSpender).toBe(VERIFIED_PITEAS_ROUTER);
    expect(result.requiredAllowanceRaw).toBe(STARTING_EUSDC);
    expect(result.unlimitedApproval).toBe(false);
    expect(d.getPiteasQuote).not.toHaveBeenCalled();
    expect(d.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects Piteas failures without retrying or falling back to another candidate", async () => {
    const cfg = testConfig();
    const d = deps({
      getPiteasQuote: vi.fn(async () => ({
        ok: false,
        source: "piteas",
        reason: "HTTP 500",
        status: 500,
        advisory: true,
      })),
    });
    const scan = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    const result = await runEusdcRotationProposeEntry(
      cfg,
      {
        walletId: WALLET_ID,
        expectedCandidateId: "PLSX",
        scanFingerprint: scan.scanFingerprint,
      },
      d,
    );
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(d.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects exit quotes below the dynamic eUSDC floor and passes when equal to the floor", async () => {
    const cfg = testConfig();
    atomicWriteJson(join(cfg.agentWalletDir, "eusdc-rotation-ledger.json"), {
      schemaVersion: 1,
      updatedAt: new Date(BASE_NOW).toISOString(),
      cycles: [
        {
          cycleId: "cycle_mock",
          walletId: WALLET_ID,
          state: "POSITION_OPEN",
          cycleStartTime: new Date(BASE_NOW).toISOString(),
          startingEusdcRaw: STARTING_EUSDC,
          selectedCandidate: "PLSX",
          candidateTokenAddress: PLSX_ADDRESS,
          candidateReceivedRaw: "1000000000000000000000",
          entryEusdcSpentRaw: STARTING_EUSDC,
          positionOpenedAt: new Date(BASE_NOW).toISOString(),
          exitGasEusdcEquivalentRaw: "0",
        },
      ],
    });

    const below = deps({
      readTokenAllowance: vi.fn(async (_config, token) =>
        token.toLowerCase() === PLSX_ADDRESS.toLowerCase()
          ? "1000000000000000000000"
          : STARTING_EUSDC,
      ),
      getPiteasQuote: vi.fn(async (_config, req) =>
        quote({
          tokenIn: req.tokenIn as `0x${string}`,
          tokenOut: req.tokenOut as `0x${string}`,
          amountRaw: req.amount,
          amountOut: "5274898",
          minOut: "5274898",
        }),
      ),
      simulateSameBlock: vi.fn(async () => [
        {
          rpc: "https://rpc-a.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "5274898",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1000",
          error: null,
        },
        {
          rpc: "https://rpc-b.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "5274898",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1000",
          error: null,
        },
      ]),
    });
    const low = await runEusdcRotationProposeExit(
      cfg,
      {
        walletId: WALLET_ID,
        minimumExecutableEusdcOutputRaw: "5274899",
      },
      below,
    );
    expect(low.ok).toBe(false);
    expect(low.classification).toBe("MINIMUM_OUTPUT_BELOW_FLOOR");
    expect(below.proposeAgentTx).not.toHaveBeenCalled();

    const equal = deps({
      readTokenAllowance: vi.fn(async (_config, token) =>
        token.toLowerCase() === PLSX_ADDRESS.toLowerCase()
          ? "1000000000000000000000"
          : STARTING_EUSDC,
      ),
      getPiteasQuote: vi.fn(async (_config, req) =>
        quote({
          tokenIn: req.tokenIn as `0x${string}`,
          tokenOut: req.tokenOut as `0x${string}`,
          amountRaw: req.amount,
          amountOut: "5274899",
          minOut: "5274899",
        }),
      ),
      simulateSameBlock: vi.fn(async () => [
        {
          rpc: "https://rpc-a.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "5274899",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1000",
          error: null,
        },
        {
          rpc: "https://rpc-b.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "5274899",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1000",
          error: null,
        },
      ]),
    });
    const pass = await runEusdcRotationProposeExit(
      cfg,
      {
        walletId: WALLET_ID,
        minimumExecutableEusdcOutputRaw: "5274899",
      },
      equal,
    );
    expect(pass.ok).toBe(true);
    expect(pass.classification).toBe("READY_FOR_HUMAN_CONFIRMATION");
    expect(equal.getPiteasQuote).toHaveBeenCalledTimes(1);
  });

  it("rejects RPC output below floor and gas above the PLS limit before proposal creation", async () => {
    const cfg = testConfig();
    atomicWriteJson(join(cfg.agentWalletDir, "eusdc-rotation-ledger.json"), {
      schemaVersion: 1,
      updatedAt: new Date(BASE_NOW).toISOString(),
      cycles: [
        {
          cycleId: "cycle_rpc_floor",
          walletId: WALLET_ID,
          state: "POSITION_OPEN",
          cycleStartTime: new Date(BASE_NOW).toISOString(),
          startingEusdcRaw: STARTING_EUSDC,
          selectedCandidate: "PLSX",
          candidateTokenAddress: PLSX_ADDRESS,
          candidateReceivedRaw: "1000000000000000000000",
          entryEusdcSpentRaw: STARTING_EUSDC,
          positionOpenedAt: new Date(BASE_NOW).toISOString(),
          exitGasEusdcEquivalentRaw: "0",
        },
      ],
    });
    const rpcBelow = deps({
      readTokenAllowance: vi.fn(async (_config, token) =>
        token.toLowerCase() === PLSX_ADDRESS.toLowerCase()
          ? "1000000000000000000000"
          : STARTING_EUSDC,
      ),
      simulateSameBlock: vi.fn(async () => [
        {
          rpc: "https://rpc-a.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "98",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1000",
          error: null,
        },
        {
          rpc: "https://rpc-b.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "98",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1000",
          error: null,
        },
      ]),
      getPiteasQuote: vi.fn(async (_config, req) =>
        quote({
          tokenIn: req.tokenIn as `0x${string}`,
          tokenOut: req.tokenOut as `0x${string}`,
          amountRaw: req.amount,
          amountOut: "5274900",
          minOut: "5274899",
        }),
      ),
    });
    const below = await runEusdcRotationProposeExit(
      cfg,
      {
        walletId: WALLET_ID,
        minimumExecutableEusdcOutputRaw: "5274899",
      },
      rpcBelow,
    );
    expect(below.ok).toBe(false);
    expect(below.classification).toBe("MINIMUM_OUTPUT_BELOW_FLOOR");

    resetEusdcRotationForTests();
    const gasCfg = testConfig();
    const scanDeps = deps();
    const scan = await runEusdcRotationScan(gasCfg, { walletId: WALLET_ID }, scanDeps);
    const gasAbove = deps({
      getFeeData: vi.fn(async () => ({
        gasPriceWei: "1000000000000000000",
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
      })),
      simulateSameBlock: vi.fn(async () => [
        {
          rpc: "https://rpc-a.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "990000000000000000000",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1501",
          error: null,
        },
        {
          rpc: "https://rpc-b.example",
          pinnedBlock: "100",
          ethCallPassed: true,
          outputRaw: "990000000000000000000",
          revertData: null,
          decodedRevert: null,
          estimateGasPassed: true,
          gasEstimate: "1501",
          error: null,
        },
      ]),
    });
    const highGas = await runEusdcRotationProposeEntry(
      gasCfg,
      {
        walletId: WALLET_ID,
        expectedCandidateId: "PLSX",
        scanFingerprint: scan.scanFingerprint,
        maximumGasCostPls: "1500",
      },
      gasAbove,
    );
    expect(highGas.ok).toBe(false);
    expect(highGas.classification).toBe("GAS_COST_ABOVE_LIMIT");
    expect(gasAbove.proposeAgentTx).not.toHaveBeenCalled();
  });
});

describe("eUSDC live scan hardening primitives", () => {
  it("normalizes token amounts and pool liquidity without displaying raw reserves as USD", () => {
    expect(normalizeTokenAmount("1000000000000000000", 18, true)).toBe(1);
    expect(normalizeTokenAmount("100000000", 8, true)).toBe(1);
    expect(normalizeTokenAmount("1000000", 6, true)).toBe(1);
    expect(getRotationCandidate("PRVX").expectedNamePatterns).toContain("provex");

    const hugeRawLooking = pairFixture({
      id: "0x1000000000000000000000000000000000000001",
      token0: WPLS_ADDRESS,
      token1: EUSDC_TOKEN_ADDRESS,
      symbol0: "WPLS",
      symbol1: "eUSDC",
      reserve0: "1000000",
      reserve1: "20",
      reserveUSD: "147567622857993420000000000000",
    });
    const liquidity = calculatePairLiquidityEusdc(
      hugeRawLooking,
      new Map([
        [WPLS_ADDRESS.toLowerCase(), 0.00002],
        [EUSDC_TOKEN_ADDRESS.toLowerCase(), 1],
      ]),
    );
    expect(liquidity).toBe(40);
    expect(liquidity).toBeLessThan(1_000_000);
  });

  it("builds five-minute candles across 24 hours, removes duplicate swaps, and reports missing coverage", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const start = Math.floor(now / 1000) - 24 * 60 * 60;
    const observations: RotationPriceObservation[] = [];
    for (let i = 0; i < 288; i += 1) {
      if (i % 12 === 0) continue;
      observations.push(observation(start + i * 300 + 10, 1 + i / 10_000, `swap-${i}`));
    }
    observations.push({ ...observations[0]!, priceEusdc: 99 });
    const { candles, coverage } = buildFiveMinuteCandles({
      observations,
      lookbackMinutes: 1440,
      candleMinutes: 5,
      nowMs: now,
    });
    expect(coverage.expectedCandles).toBe(288);
    expect(coverage.populatedCandles).toBe(264);
    expect(coverage.activeTradeCandles).toBe(264);
    expect(coverage.missingBuckets).toBe(24);
    expect(candles[0]!.open).not.toBe(99);
  });

  it("derives direct and WPLS-anchored eUSDC prices with stale anchor rejection", () => {
    const anchorPair = pairFixture({
      id: "0x2000000000000000000000000000000000000001",
      token0: WPLS_ADDRESS,
      token1: EUSDC_TOKEN_ADDRESS,
      symbol0: "WPLS",
      symbol1: "eUSDC",
      reserve0: "1000000",
      reserve1: "20",
    });
    const plsxWplsPair = pairFixture({
      id: "0x2000000000000000000000000000000000000002",
      token0: PLSX_ADDRESS,
      token1: WPLS_ADDRESS,
      symbol0: "PLSX",
      symbol1: "WPLS",
      reserve0: "10000000",
      reserve1: "5000",
    });
    const anchorSwap = swapFixture({
      id: "a",
      timestamp: 1000,
      pair: anchorPair,
      amount0In: "100000",
      amount1Out: "2",
      amountUSD: "2",
    });
    const anchor = priceObservationFromSwap({
      swap: anchorSwap,
      candidate: getRotationCandidate("PLS"),
    });
    expect(anchor?.priceEusdc).toBeCloseTo(0.00002);

    const candidateSwap = swapFixture({
      id: "b",
      timestamp: 1200,
      pair: plsxWplsPair,
      amount0In: "100000",
      amount1Out: "50",
      amountUSD: "0",
    });
    const derived = priceObservationFromSwap({
      swap: candidateSwap,
      candidate: getRotationCandidate("PLSX"),
      anchorObservations: [anchor!],
      maxAnchorAgeSeconds: 900,
    });
    expect(derived?.priceEusdc).toBeCloseTo(0.00000001);
    const stale = priceObservationFromSwap({
      swap: { ...candidateSwap, timestamp: "10000" },
      candidate: getRotationCandidate("PLSX"),
      anchorObservations: [anchor!],
      maxAnchorAgeSeconds: 900,
    });
    expect(stale).toBeNull();
  });

  it("detects exact dip/rebound evidence and rejects lower-low continuation", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const start = Math.floor(now / 1000) - 75 * 60;
    const prices = [1.0, 1.0, 1.0, 0.9899, 0.9902, 0.992, 0.9925, 0.993];
    const observations = prices.map((price, i) => observation(start + i * 300 + 1, price, `dip-${i}`, 20));
    const { candles } = buildFiveMinuteCandles({
      observations,
      lookbackMinutes: 90,
      candleMinutes: 5,
      nowMs: now,
    });
    const analysis = analyzeRotationCandles({
      candles,
      scanInput: {
        walletId: WALLET_ID,
        lookbackMinutes: 90,
        candleMinutes: 5,
        minimumDipBps: 100,
        minimumReboundConfirmationBps: 20,
        minimumNetTargetBps: 100,
      },
      pageCount: 2,
      truncated: false,
    });
    expect(analysis.dipReboundEvidence.status).toBe("AVAILABLE");
    expect(analysis.dipReboundEvidence.dipBps).toBeGreaterThanOrEqual(100);
    expect(analysis.dipReboundEvidence.reboundBps).toBeGreaterThanOrEqual(20);
    expect(analysis.meanReversionScore).toBeGreaterThan(0);

    const lowerLowCandles = candles.map((candle, i) =>
      i === candles.length - 1 ? { ...candle, low: 0.98, close: 0.98 } : candle,
    );
    const lowerLow = analyzeRotationCandles({
      candles: lowerLowCandles,
      scanInput: {
        walletId: WALLET_ID,
        lookbackMinutes: 90,
        candleMinutes: 5,
        minimumDipBps: 100,
        minimumReboundConfirmationBps: 20,
        minimumNetTargetBps: 100,
      },
      pageCount: 2,
      truncated: false,
    });
    expect(lowerLow.dipReboundEvidence.trendRejected).toBe(true);
  });

  it("classifies WPLS, PLSX, INC, pHEX, and PRVX route connectivity from verified pool graph", () => {
    const anchor = pairFixture({
      id: "0x3000000000000000000000000000000000000001",
      token0: WPLS_ADDRESS,
      token1: EUSDC_TOKEN_ADDRESS,
      reserve0: "1000000",
      reserve1: "20",
    });
    const plsxWpls = pairFixture({
      id: "0x3000000000000000000000000000000000000002",
      token0: PLSX_ADDRESS,
      token1: WPLS_ADDRESS,
      reserve0: "1000000",
      reserve1: "1000",
    });
    const incDirect = pairFixture({
      id: "0x3000000000000000000000000000000000000003",
      token0: INC_ADDRESS,
      token1: EUSDC_TOKEN_ADDRESS,
      reserve0: "1000",
      reserve1: "2000",
    });
    const hexDirect = pairFixture({
      id: "0x3000000000000000000000000000000000000004",
      token0: HEX_ADDRESS,
      token1: EUSDC_TOKEN_ADDRESS,
      decimals0: "8",
      decimals1: "6",
      reserve0: "1000000",
      reserve1: "3000",
    });
    const prvxWpls = pairFixture({
      id: "0x3000000000000000000000000000000000000005",
      token0: PRVX_ADDRESS,
      token1: WPLS_ADDRESS,
      reserve0: "1000",
      reserve1: "100",
    });
    const graph = [anchor, plsxWpls, incDirect, hexDirect, prvxWpls];
    expect(deriveRouteConnectivity({ candidate: getRotationCandidate("PLS"), pairs: graph })).toBe("DIRECT_POOL");
    expect(deriveRouteConnectivity({ candidate: getRotationCandidate("PLSX"), pairs: graph })).toBe("MULTIHOP_VIA_WPLS");
    expect(deriveRouteConnectivity({ candidate: getRotationCandidate("INC"), pairs: graph })).toBe("DIRECT_POOL");
    expect(deriveRouteConnectivity({ candidate: getRotationCandidate("PHEX"), pairs: graph })).toBe("DIRECT_POOL");
    expect(deriveRouteConnectivity({ candidate: getRotationCandidate("PRVX"), pairs: graph })).toBe("MULTIHOP_VIA_WPLS");
  });

  it("excludes manipulated tiny pools and reports consolidated liquidity/price", () => {
    const candidate = getRotationCandidate("PLSX");
    const good = pairFixture({
      id: "0x4000000000000000000000000000000000000001",
      token0: PLSX_ADDRESS,
      token1: WPLS_ADDRESS,
      reserve0: "100000000000",
      reserve1: "10000000",
    });
    const tiny = pairFixture({
      id: "0x4000000000000000000000000000000000000002",
      token0: PLSX_ADDRESS,
      token1: EUSDC_TOKEN_ADDRESS,
      reserve0: "1",
      reserve1: "100",
    });
    const consolidation = consolidateRotationPools({
      candidate,
      pairs: [good, tiny],
      priceMap: new Map([
        [WPLS_ADDRESS.toLowerCase(), 0.00002],
        [EUSDC_TOKEN_ADDRESS.toLowerCase(), 1],
        [PLSX_ADDRESS.toLowerCase(), 0.00000001],
      ]),
    });
    expect(consolidation.eligiblePools).toContain(good.id.toLowerCase());
    expect(consolidation.excludedPools.some((row) => row.pool === tiny.id.toLowerCase())).toBe(true);
    expect(consolidation.aggregateLiquidityEusdc).toBeGreaterThan(0);
    expect(consolidation.priceDispersionPercent).not.toBe(Number.NaN);
  });

  it("does not create fake ranking for all-zero evidence and preserves ties", () => {
    const noEvidence = EUSDC_ROTATION_CANDIDATES.map((candidate) =>
      buildCandidateScanRow({
        candidate,
        tokenValidation: validation(candidate.candidateId),
        market: market({
          meanReversionScore: 0,
          liquidityScore: 0,
          volumeScore: 0,
          routeQualityScore: 0,
          volatilitySuitabilityScore: 0,
          distanceFromOneHourHighBps: null,
          reboundFromRecentLocalLowBps: null,
        }),
        scanInput: {
          walletId: WALLET_ID,
          lookbackMinutes: 1440,
          candleMinutes: 5,
          minimumDipBps: 100,
          minimumReboundConfirmationBps: 20,
          minimumNetTargetBps: 100,
        },
        state: "EUSDC_IDLE",
        hasOpenCycle: false,
      }),
    );
    const noRank = selectRotationWinner(noEvidence);
    expect(noRank.rankedCandidateIds).toEqual([]);
    expect(noEvidence.every((row) => row.rankingStatus === "UNRANKED_NO_EVIDENCE")).toBe(true);

    const tied = ["PLSX", "PHEX"].map((candidateId) =>
      buildCandidateScanRow({
        candidate: getRotationCandidate(candidateId as RotationCandidateId),
        tokenValidation: validation(candidateId as RotationCandidateId),
        market: market({ meanReversionScore: 90, liquidityScore: 90, volumeScore: 90, routeQualityScore: 90 }),
        scanInput: {
          walletId: WALLET_ID,
          lookbackMinutes: 1440,
          candleMinutes: 5,
          minimumDipBps: 100,
          minimumReboundConfirmationBps: 20,
          minimumNetTargetBps: 100,
        },
        state: "EUSDC_IDLE",
        hasOpenCycle: false,
      }),
    );
    const tie = selectRotationWinner(tied);
    expect(tie.decision).toBe("HOLD_EUSDC");
    expect(tie.tiedCandidateIds).toEqual(["PLSX", "PHEX"]);
  });

  it("calculates dynamic eUSDC target and rejects economically infeasible one-percent cycles", async () => {
    const feasible = computeScanEconomicFeasibility({
      startingEusdcRaw: STARTING_EUSDC,
      minimumNetTargetBps: 100,
      wplsPriceEusdc: 0.00000001,
      estimatedGasPlsPerLeg: 100,
      approvalLegs: 0,
      swapLegs: 2,
      safetyBufferRaw: "0",
    });
    expect(feasible.simpleTargetRaw).toBe("5274899");
    expect(feasible.onePercentTargetEconomicallyPlausible).toBe(true);

    const infeasible = computeScanEconomicFeasibility({
      startingEusdcRaw: STARTING_EUSDC,
      minimumNetTargetBps: 100,
      wplsPriceEusdc: 0.001,
      estimatedGasPlsPerLeg: 1500,
      approvalLegs: 2,
      swapLegs: 2,
    });
    expect(infeasible.onePercentTargetEconomicallyPlausible).toBe(false);

    const cfg = testConfig();
    const d = deps();
    const scan = await runEusdcRotationScan(cfg, { walletId: WALLET_ID }, d);
    expect(scan.candidates).toHaveLength(5);
    expect(scan.quoteCallCount).toBe(0);
    expect(d.getPiteasQuote).not.toHaveBeenCalled();
    expect(d.proposeAgentTx).not.toHaveBeenCalled();
    expect(d.executeAgentTx).not.toHaveBeenCalled();
  });
});

describe("eUSDC rotation public history sync primitives", () => {
  function writeHistoryFixture(dir: string, records: RotationHistoryRecord[]): void {
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(join(dir, "market-history.json"), {
      schemaVersion: 1,
      chainId: 369,
      updatedAt: new Date(BASE_NOW).toISOString(),
      retentionDays: 7,
      records,
    });
  }

  it("resolves the repository-local history store from module location independent of process cwd", () => {
    const originalCwd = process.cwd();
    const repoRoot = originalCwd;
    const sourceModule = join(repoRoot, "src", "tools", "wallet", "eusdcRotation.ts");
    const distModule = join(repoRoot, "dist", "tools", "wallet", "eusdcRotation.js");
    const expectedStore = join(repoRoot, "data", "eusdc-rotation-history", "market-history.json");
    const parent = join(repoRoot, "..");
    const unrelated = mkdtempSync(join(tmpdir(), "eusdc-rotation-cwd-"));
    tempDirs.push(unrelated);
    try {
      process.chdir(repoRoot);
      expect(resolveEusdcRotationRepositoryRoot({ moduleUrlOrPath: sourceModule })).toBe(repoRoot);
      expect(resolveEusdcRotationHistoryStorePath(undefined, { moduleUrlOrPath: sourceModule }).path).toBe(expectedStore);
      process.chdir(parent);
      expect(resolveEusdcRotationHistoryStorePath(undefined, { moduleUrlOrPath: sourceModule }).path).toBe(expectedStore);
      process.chdir(unrelated);
      expect(resolveEusdcRotationHistoryStorePath(undefined, { moduleUrlOrPath: sourceModule }).path).toBe(expectedStore);
      expect(resolveEusdcRotationRepositoryRoot({ moduleUrlOrPath: distModule })).toBe(repoRoot);
      expect(resolveEusdcRotationHistoryStorePath(undefined, { moduleUrlOrPath: distModule }).path).toBe(expectedStore);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("normalizes slash variants and keeps the legacy cwd path diagnostic-only", async () => {
    const cfg = testConfig();
    const historyDir = join(mkdtempSync(join(tmpdir(), "eusdc-history-active-")), "history");
    const legacyDir = join(process.cwd(), "data", "eusdc-rotation-history");
    tempDirs.push(dirname(historyDir));
    const activeRecord = historyRecord({ timestamp: Math.floor(BASE_NOW / 1000), logIndex: 10 });
    const activeDirWithForwardSlashes = historyDir.replace(/\\/g, "/");
    const withOverride: AppConfig = { ...cfg, eusdcRotationHistoryDir: activeDirWithForwardSlashes };
    writeHistoryFixture(historyDir, [activeRecord]);
    const resolved = resolveEusdcRotationHistoryStorePath(withOverride);
    expect(resolved.path).toBe(join(historyDir, "market-history.json"));
    expect(legacyCwdDerivedHistoryStorePath()).toBe(join(legacyDir, "market-history.json"));
    const status = await runEusdcRotationHistoryStatus(withOverride, { lookbackMinutes: 1440, candleMinutes: 5 });
    expect(status.ok).toBe(true);
    expect(status.historyStorePath).toBe(resolved.path);
    expect(status.historyStorePathSource).toBe("CONFIG_OVERRIDE");
    expect(status.activeStoreRecordCount).toBe(1);
    expect(status.pathMatchesExpectedRepositoryLocalDefault).toBe(false);
    expect(readRotationHistoryStore(withOverride).records).toHaveLength(1);
  });

  it("rejects unsafe history-directory overrides", () => {
    const cfg = testConfig();
    expect(() =>
      resolveEusdcRotationHistoryStorePath({ ...cfg, eusdcRotationHistoryDir: "relative-history" }),
    ).toThrow(/absolute path/);
    expect(() =>
      resolveEusdcRotationHistoryStorePath({ ...cfg, eusdcRotationHistoryDir: join(cfg.agentWalletDir, "history") }),
    ).toThrow(/AGENT_WALLET_DIR/);
    expect(() =>
      resolveEusdcRotationHistoryStorePath({
        ...cfg,
        eusdcRotationHistoryDir: `${tmpdir()}${sep}rotation${sep}..${sep}history`,
      }),
    ).toThrow(/parent-directory traversal/);
  });

  it("returns HISTORY_SYNC_BUSY when a live cross-process public-history writer lock exists", async () => {
    const cfg = testConfig();
    const historyDir = join(mkdtempSync(join(tmpdir(), "eusdc-history-lock-")), "history");
    tempDirs.push(dirname(historyDir));
    const withOverride: AppConfig = { ...cfg, eusdcRotationHistoryDir: historyDir };
    mkdirSync(historyDir, { recursive: true });
    atomicWriteJson(join(historyDir, "market-history.lock"), {
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
      historyStorePath: join(historyDir, "market-history.json"),
    });
    const result = await runEusdcRotationHistorySync(withOverride, {
      lookbackMinutes: 10080,
      maximumBlocksPerChunk: 100,
      maximumPagesPerSource: 1,
      forceRecentBlockRecheck: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HISTORY_SYNC_BUSY");
    expect(result.recordsAdded).toBe(0);
    expect(result.crossProcessLockStatus).toBe("busy_live_owner");
  });

  it("returns PARTIAL_PROGRESS with a checkpoint and releases the public-history lock when maximumRuntimeMs is exhausted", async () => {
    const cfg = testConfig();
    const historyDir = join(mkdtempSync(join(tmpdir(), "eusdc-history-partial-")), "history");
    tempDirs.push(dirname(historyDir));
    const withOverride: AppConfig = { ...cfg, eusdcRotationHistoryDir: historyDir };
    writeHistoryFixture(historyDir, [historyRecord({ timestamp: Math.floor(BASE_NOW / 1000), logIndex: 11 })]);

    const result = await runEusdcRotationHistorySync(withOverride, {
      lookbackMinutes: 10080,
      maximumRuntimeMs: 1,
      maximumBlocksPerChunk: 100,
      maximumPagesPerSource: 1,
      forceRecentBlockRecheck: true,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("PARTIAL_PROGRESS");
    expect(result.resumeToken).toMatch(/^0x[a-f0-9]{64}$/);
    expect(result.quoteCallCount).toBe(0);
    expect(result.noWalletWrite).toBe(true);
    expect(result.noLiveTransaction).toBe(true);
    expect(existsSync(join(historyDir, "market-history.lock"))).toBe(false);
    expect(existsSync(join(historyDir, "sync-checkpoint.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(historyDir, "market-history.json"), "utf8")).records).toHaveLength(1);
    const checkpoint = JSON.parse(readFileSync(join(historyDir, "sync-checkpoint.json"), "utf8"));
    expect(checkpoint.resumeToken).toBe(result.resumeToken);
    expect(checkpoint.completedBlockRanges).toEqual([]);
  });

  it("plans block-log fallback when subgraph pagination truncates and reduces RPC chunks after range errors", () => {
    expect(shouldUseRpcLogFallback({
      candidateId: "PLSX",
      poolAddress: "0x3000000000000000000000000000000000000002",
      sourceEndpoint: "https://example.com/v2",
      queryType: "PulseX V2 swaps(pair, first, skip)",
      pageSize: 100,
      maximumPageCount: 32,
      cursorMechanism: "skip",
      oldestReturnedRecord: "2026-08-05T11:00:00.000Z",
      newestReturnedRecord: "2026-08-05T12:00:00.000Z",
      requestedStartTime: "2026-08-04T12:00:00.000Z",
      requestedEndTime: "2026-08-05T12:00:00.000Z",
      totalRecordsRetrieved: 3200,
      deduplicatedRecords: 3200,
      boundaryCrossed: false,
      truncationReason: "SOURCE_ROW_LIMIT",
      sourceRepeatsOrCapsRecords: true,
      historicalPaginationReliable: false,
      fallbackUsed: "NONE",
    })).toBe(true);
    expect(reduceLogChunkAfterRangeError(50_000)).toBe(25_000);
    expect(reduceLogChunkAfterRangeError(120)).toBe(100);
  });

  it("retains V1 and V2 pool source identity and plans V1 queries against V1", () => {
    const pair = pairFixture({
      id: "0x1000000000000000000000000000000000000001",
      token0: EUSDC_TOKEN_ADDRESS,
      token1: WPLS_ADDRESS,
      reserve0: "1000",
      reserve1: "100000000",
      reserveUSD: "2000",
    });
    const v1 = sourcePoolFixture({ pair, sourceVersion: "PULSEX_V1", endpoint: "https://example.com/v1" });
    const v2 = sourcePoolFixture({ pair, sourceVersion: "PULSEX_V2", endpoint: "https://example.com/v2" });
    const deduped = dedupeSourcePools([v1, v2]);
    expect(deduped.pools.map((row) => row.sourceVersion).sort()).toEqual(["PULSEX_V1", "PULSEX_V2"]);
    expect(deduped.sourceDisagreements[0]).toMatch(/multiple source versions/i);
    expect(swapQueryPlanForSourcePool(v1)).toMatchObject({
      pair: pair.id.toLowerCase(),
      version: "v1",
      endpoint: "https://example.com/v1",
      sourceVersion: "PULSEX_V1",
    });
    expect(swapQueryPlanForSourcePool(v1).version).not.toBe("v2");
  });

  it("proves complete empty-trade ranges from scanned block boundaries, not observed swaps", () => {
    expect(rangeFullyScanned({
      resolvedStartBlock: 100n,
      resolvedEndBlock: 200n,
      scannedFromBlock: 100n,
      scannedToBlock: 200n,
      unresolvedRpcRangeError: false,
    })).toBe(true);
    expect(rangeFullyScanned({
      resolvedStartBlock: 100n,
      resolvedEndBlock: 200n,
      scannedFromBlock: 101n,
      scannedToBlock: 200n,
      unresolvedRpcRangeError: false,
    })).toBe(false);
  });

  it("resolves timestamp boundaries with actual block timestamps", async () => {
    const timestamps = [1000, 1012, 1024, 1036, 1048, 1060, 1072, 1084];
    const calls: bigint[] = [];
    const client = {
      getBlockNumber: vi.fn(async () => BigInt(timestamps.length - 1)),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        calls.push(blockNumber);
        return {
          timestamp: BigInt(timestamps[Number(blockNumber)]!),
          hash: `0x${String(Number(blockNumber) + 1).padStart(64, "0")}` as const,
        };
      }),
      getLogs: vi.fn(),
    };
    const resolved = await resolveTimestampBlockRange({
      client,
      startTimestamp: 1025,
      endTimestamp: 1061,
    });
    expect(resolved.resolvedStartBlock).toBe(3n);
    expect(resolved.resolvedEndBlock).toBe(5n);
    expect(resolved.resolvedStartBlockTimestamp).toBe(1036);
    expect(resolved.resolvedEndBlockTimestamp).toBe(1060);
    expect(resolved.maximumTimestampResolutionErrorSeconds).toBe(11);
    expect(calls.length).toBeLessThanOrEqual(20);
  });

  it("stops timestamp-to-block search when the history runtime deadline is reached", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 100n),
      getBlock: vi.fn(async () => ({
        timestamp: 1000n,
        hash: "0x1111111111111111111111111111111111111111111111111111111111111111" as const,
      })),
      getLogs: vi.fn(),
    };
    await expect(resolveTimestampBlockRange({
      client,
      startTimestamp: 1000,
      endTimestamp: 1100,
      deadlineMs: Date.now() - 1,
    })).rejects.toThrow(/HISTORY_RUNTIME_DEADLINE_REACHED/);
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });

  it("prices direct eUSDC, WPLS/eUSDC anchor, and candidate/WPLS anchored swaps", () => {
    const directPair = pairFixture({
      id: "0x2000000000000000000000000000000000000001",
      token0: EUSDC_TOKEN_ADDRESS,
      token1: PLSX_ADDRESS,
      reserve0: "1000",
      reserve1: "500000",
    });
    const direct = priceObservationFromSwap({
      candidate: getRotationCandidate("PLSX"),
      swap: swapFixture({
        id: "direct",
        timestamp: 1000,
        pair: directPair,
        amount0In: "20",
        amount1Out: "10000",
        amountUSD: "20",
      }),
    });
    expect(direct?.priceEusdc).toBeCloseTo(0.002, 8);

    const wplsAnchor = observation(1000, 0.000008, "anchor", 100);
    const candidateWplsPair = pairFixture({
      id: "0x2000000000000000000000000000000000000002",
      token0: PLSX_ADDRESS,
      token1: WPLS_ADDRESS,
      reserve0: "100000",
      reserve1: "25000",
    });
    const anchored = priceObservationFromSwap({
      candidate: getRotationCandidate("PLSX"),
      anchorObservations: [{ ...wplsAnchor, blockNumber: "10", poolAddress: directPair.id as `0x${string}` }],
      blockNumber: "10",
      swap: swapFixture({
        id: "anchored",
        timestamp: 1000,
        pair: candidateWplsPair,
        amount0In: "1000",
        amount1Out: "250",
        amountUSD: "0",
      }),
    });
    expect(anchored?.priceEusdc).toBeCloseTo(0.000002, 12);
    expect(anchored?.anchorAgeSeconds).toBe(0);
    expect(anchored?.anchorPoolAddress).toBe(directPair.id);
  });

  it("rejects missing and stale WPLS anchors for candidate/WPLS observations", () => {
    const candidateWplsPair = pairFixture({
      id: "0x2000000000000000000000000000000000000003",
      token0: INC_ADDRESS,
      token1: WPLS_ADDRESS,
      reserve0: "100000",
      reserve1: "25000",
    });
    const swap = swapFixture({
      id: "inc-wpls",
      timestamp: 10_000,
      pair: candidateWplsPair,
      amount0In: "1000",
      amount1Out: "250",
      amountUSD: "0",
    });
    expect(priceObservationFromSwap({
      candidate: getRotationCandidate("INC"),
      swap,
      anchorObservations: [],
    })).toBeNull();
    expect(priceObservationFromSwap({
      candidate: getRotationCandidate("INC"),
      swap,
      anchorObservations: [observation(8_000, 0.000008, "stale")],
      maxAnchorAgeSeconds: 300,
    })).toBeNull();
  });

  it("deduplicates records, preserves existing rows, excludes old incoming rows, and keeps public-only fields", () => {
    const old = historyRecord({
      timestamp: Math.floor(BASE_NOW / 1000) - 9 * 24 * 60 * 60,
      tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      logIndex: 0,
    });
    const existing = historyRecord({
      timestamp: Math.floor(BASE_NOW / 1000) - 60,
      tx: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      logIndex: 1,
      blockNumber: "999",
      blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      price: 1,
    });
    const replacement = {
      ...existing,
      blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
      candidatePriceEusdc: 1.01,
    };
    const fresh = historyRecord({
      timestamp: Math.floor(BASE_NOW / 1000) - 30,
      tx: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      logIndex: 2,
      blockNumber: "1000",
      blockHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    });
    const oldIncoming = historyRecord({
      timestamp: Math.floor(BASE_NOW / 1000) - 9 * 24 * 60 * 60,
      tx: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      logIndex: 3,
    });
    const merged = mergeRotationHistoryRecords({
      existing: [old, existing],
      incoming: [replacement, fresh, fresh, oldIncoming],
      nowMs: BASE_NOW,
      retentionDays: 7,
      forceRecentBlockRecheck: true,
      latestBlockNumber: 1000n,
    });
    expect(merged.added).toBe(1);
    expect(merged.updated).toBe(1);
    expect(merged.duplicates).toBe(1);
    expect(merged.records.some((record) => record.transactionHash === old.transactionHash)).toBe(true);
    expect(merged.records.some((record) => record.transactionHash === oldIncoming.transactionHash)).toBe(false);
    expect(JSON.stringify(merged.records)).not.toMatch(/private_key|master_key|wallet_secret|raw_signed/i);
  });

  it("preserves existing record timestamps when corrected timestamp evidence arrives for the same tx/log", () => {
    const existing = historyRecord({
      timestamp: Math.floor(BASE_NOW / 1000) - 60,
      tx: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      logIndex: 7,
      blockNumber: "1000",
      blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      price: 1,
    });
    const corrected = {
      ...existing,
      timestamp: existing.timestamp + 25,
      candidatePriceEusdc: 1.02,
    };
    const merged = mergeRotationHistoryRecords({
      existing: [existing],
      incoming: [corrected],
      nowMs: BASE_NOW,
      retentionDays: 7,
      forceRecentBlockRecheck: true,
      latestBlockNumber: 1000n,
    });
    expect(merged.duplicates).toBe(1);
    expect(merged.records[0]?.timestamp).toBe(existing.timestamp);
    expect(merged.records[0]?.candidatePriceEusdc).toBe(existing.candidatePriceEusdc);
  });

  it("separates source completeness, active candle coverage, and price continuity", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const start = Math.floor(now / 1000) - 24 * 60 * 60;
    const observations = [
      observation(start + 60, 1, "a"),
      observation(start + 12 * 60 * 60, 0.99, "b"),
      observation(start + 23 * 60 * 60 + 30, 1.01, "c"),
    ];
    const { coverage } = buildFiveMinuteCandles({
      observations,
      lookbackMinutes: 1440,
      candleMinutes: 5,
      nowMs: now,
    });
    const continuity = calculatePriceContinuityPercent({
      observations,
      lookbackMinutes: 1440,
      candleMinutes: 5,
      nowMs: now,
      maxCarryForwardMinutes: 60,
    });
    expect(coverage.expectedCandles).toBe(288);
    expect(coverage.coveragePercent).toBeLessThan(2);
    expect(continuity).toBeGreaterThan(0);
    expect(continuity).toBeLessThan(20);
  });

  it("classifies dense, qualified sparse, stale, excessive-gap, and insufficient-swap histories", () => {
    const base = {
      sourceCompletenessPercent: 100,
      priceContinuityPercent: 75,
      latestTradeAgeMinutes: 5,
      maximumObservedGapMinutes: 120,
      routeConnected: true,
      liquidityPasses: true,
      priceDispersionPercent: 1,
      sourceTruncated: false,
    };
    expect(classifyHistoryAnalysisMode({
      ...base,
      activeTradeCandlePercent: 85,
      actualTradeCount: 260,
    })).toBe("DENSE_CANDLES");
    expect(classifyHistoryAnalysisMode({
      ...base,
      activeTradeCandlePercent: 25,
      actualTradeCount: 30,
    })).toBe("SPARSE_EVENT_TIME");
    expect(classifyHistoryAnalysisMode({
      ...base,
      latestTradeAgeMinutes: 90,
      activeTradeCandlePercent: 25,
      actualTradeCount: 30,
    })).toBe("UNUSABLE_HISTORY");
    expect(classifyHistoryAnalysisMode({
      ...base,
      maximumObservedGapMinutes: 720,
      activeTradeCandlePercent: 25,
      actualTradeCount: 30,
    })).toBe("UNUSABLE_HISTORY");
    expect(classifyHistoryAnalysisMode({
      ...base,
      activeTradeCandlePercent: 25,
      actualTradeCount: 5,
    })).toBe("UNUSABLE_HISTORY");
  });

  it("uses only actual observations for dip/rebound; carry-forward continuity cannot create the signal", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const start = Math.floor(now / 1000) - 90 * 60;
    const sparse = [
      observation(start + 60, 1, "ref", 20),
      observation(start + 35 * 60, 0.9899, "low", 20),
    ];
    const { candles } = buildFiveMinuteCandles({
      observations: sparse,
      lookbackMinutes: 90,
      candleMinutes: 5,
      nowMs: now,
    });
    const noRebound = analyzeRotationCandles({
      candles,
      scanInput: {
        walletId: WALLET_ID,
        lookbackMinutes: 90,
        candleMinutes: 5,
        minimumDipBps: 100,
        minimumReboundConfirmationBps: 20,
        minimumNetTargetBps: 100,
      },
      pageCount: 1,
      truncated: false,
    });
    expect(noRebound.dipReboundEvidence.status).toBe("UNAVAILABLE");

    const actualRebound = analyzeRotationCandles({
      candles: buildFiveMinuteCandles({
        observations: [...sparse, observation(start + 40 * 60, 0.993, "rebound", 20)],
        lookbackMinutes: 90,
        candleMinutes: 5,
        nowMs: now,
      }).candles,
      scanInput: {
        walletId: WALLET_ID,
        lookbackMinutes: 90,
        candleMinutes: 5,
        minimumDipBps: 100,
        minimumReboundConfirmationBps: 20,
        minimumNetTargetBps: 100,
      },
      pageCount: 1,
      truncated: false,
    });
    expect(actualRebound.dipReboundEvidence.status).toBe("AVAILABLE");
    expect(actualRebound.dipReboundEvidence.reboundBps).toBeGreaterThanOrEqual(20);
  });

  it("calculates dynamic target evidence and rejects 1% moves when the cycle requires about 2%", () => {
    const economic = computeScanEconomicFeasibility({
      startingEusdcRaw: STARTING_EUSDC,
      minimumNetTargetBps: 100,
      wplsPriceEusdc: 0.0000086691666667,
      estimatedGasPlsPerLeg: 1500,
      approvalLegs: 2,
      swapLegs: 2,
      safetyBufferRaw: "1000",
    });
    expect(economic.simpleTargetRaw).toBe("5274899");
    expect(economic.dynamicTargetRaw).toBe("5327915");
    expect(economic.requiredGrossMoveBps).toBeCloseTo(201.51, 2);

    const now = Math.floor(BASE_NOW / 1000);
    const onePercent = [
      observation(now - 600, 1, "h"),
      observation(now - 300, 0.99, "l"),
      observation(now, 1.0, "r"),
    ];
    const twoPointOne = [
      observation(now - 900, 1, "h1"),
      observation(now - 600, 0.979, "l1"),
      observation(now - 300, 1.0001, "r1"),
      observation(now - 100, 1.001, "r2"),
    ];
    expect(analyzeHistoricalReversions({
      observations: onePercent,
      targetBps: economic.requiredGrossMoveBps,
      lookbackMinutes: 1440,
    }).completedReversions).toBe(0);
    expect(analyzeHistoricalReversions({
      observations: twoPointOne,
      targetBps: economic.requiredGrossMoveBps,
      lookbackMinutes: 1440,
    }).completedReversions).toBeGreaterThan(0);

    const incompleteRow = buildCandidateScanRow({
      candidate: getRotationCandidate("PLSX"),
      tokenValidation: validation("PLSX"),
      market: market({
        historyQuality: {
          sourceCompletenessPercent: 50,
          activeTradeCandlePercent: 10,
          priceContinuityPercent: 20,
          analysisMode: "UNUSABLE_HISTORY",
          latestTradeAgeMinutes: 5,
          maximumObservedGapMinutes: 10,
          actualTradeCount: 10,
          sourceTruncated: true,
          unresolvedGaps: ["source row limit"],
          readinessForLiveScanning: false,
        },
      }),
      scanInput: {
        walletId: WALLET_ID,
        lookbackMinutes: 1440,
        candleMinutes: 5,
        minimumDipBps: 100,
        minimumReboundConfirmationBps: 20,
        minimumNetTargetBps: 100,
      },
      state: "EUSDC_IDLE",
      hasOpenCycle: false,
    });
    expect(incompleteRow.rankingStatus).toBe("UNRANKED_INCOMPLETE_HISTORY");
    expect(selectRotationWinner([incompleteRow]).rankedCandidateIds).toEqual([]);
  });
});

describe("eUSDC rotation security invariants", () => {
  it("does not add private-key signing, live broadcast, approval, leverage, borrowing, or LP code paths", () => {
    const source = readFileSync("src/tools/wallet/eusdcRotation.ts", "utf8");
    expect(source).not.toMatch(
      /decryptPrivateKey|decryptSecret|createWalletClient|sendTransaction|sendRawTransaction|rawSigned|seed phrase|mnemonic|encryptedKey|erc20Approve|buildApprovalIntent|approve\(/i,
    );
    expect(source).not.toMatch(/borrow|leverage|addLiquidity|removeLiquidity|provide liquidity/i);
    expect(source).toMatch(/executeAgentTx/);
    expect(source).toMatch(/confirm=true/);
  });
});
