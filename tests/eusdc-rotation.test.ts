import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  buildCandidateScanRow,
  computeRequiredFinalEusdcRaw,
  computeSimpleBalanceTargetRaw,
  getRotationCandidate,
  getRotationCandidateRegistry,
  resetEusdcRotationForTests,
  runEusdcRotationProposeEntry,
  runEusdcRotationProposeExit,
  runEusdcRotationScan,
  selectRotationWinner,
  type RotationCandidateId,
  type RotationDeps,
  type RotationMarketEvidence,
  type RotationTokenValidation,
} from "../src/tools/wallet/eusdcRotation.js";
import {
  HEX_ADDRESS,
  INC_ADDRESS,
  PLSX_ADDRESS,
  WPLS_ADDRESS,
} from "../src/constants.js";

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
