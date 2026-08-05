import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import {
  getPiteasQuote,
  normalizePiteasQuote,
  preparePiteasSwap,
  type PiteasQuoteData,
  type PiteasQuoteResult,
} from "../src/data/piteas.js";
import {
  decodePiteasRouterSwapCalldata,
  EUSDC_TOKEN_ADDRESS,
  fingerprint,
  PHIAT_TOKEN_ADDRESS,
  piteasRouterSwapAbi,
  PITEAS_ROUTER_SWAP_SELECTOR,
  VERIFIED_PITEAS_ROUTER,
} from "../src/piteas/routerIntent.js";
import {
  assertCalldataHandoffIntegrity,
  buildCalldataCheckpoint,
  runPiteasProposeAgentSwap,
  validateExecutableCalldata,
  type PiteasAgentSwapDeps,
  type RpcPinnedSimulationRow,
} from "../src/tools/wallet/piteasProposeAgentSwap.js";
import {
  buildAgentIntentView,
  createAgentWallet,
  inspectTokenNotional,
  proposeAgentTx,
  type TxProposalWithReview,
} from "../src/wallet/index.js";
import type { TxProposal } from "../src/wallet/types.js";
import type { AppConfig } from "../src/types.js";
import * as rpc from "../src/data/rpc.js";

const WALLET_ID = "aw_524fe256dc97aff6b28c1e6992c7a27c";
const WALLET = "0x64443a931c6d6096c8de27711f2a525393c21133" as const;
const RAW_INPUT = "5000000";
const FULL_POSITION_PHIAT_RAW = "455179228309071536844";
const FULL_POSITION_EUSDC_FLOOR_RAW = "5190107";
const BASE_NOW = Date.parse("2026-08-04T12:00:00.000Z");
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(): AppConfig {
  return {
    rpcUrl: "https://rpc-a.example",
    rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: "not-used-by-mocked-workflow",
    agentWalletDir: "not-used-by-mocked-workflow",
    agentWalletMultiprocStrict: true,
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
  };
}

function walletTestConfig(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "piteas-inprocess-wallet-"));
  tempDirs.push(dir);
  return {
    ...testConfig(),
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    agentWalletDir: dir,
    agentWalletMasterKey: randomBytes(32).toString("hex"),
    agentWalletMultiprocStrict: false,
  };
}

function tokenMeta(address: `0x${string}`): PiteasQuoteData["srcToken"] {
  if (address.toLowerCase() === EUSDC_TOKEN_ADDRESS.toLowerCase()) {
    return {
      address,
      symbol: "eUSDC",
      decimals: 6,
      chainId: 369,
    };
  }
  if (address.toLowerCase() === PHIAT_TOKEN_ADDRESS.toLowerCase()) {
    return {
      address,
      symbol: "PHIAT",
      decimals: 18,
      chainId: 369,
    };
  }
  return {
    address,
    symbol: "TEST",
    decimals: 18,
    chainId: 369,
  };
}

function piteasCalldataFor(params: {
  recipient: `0x${string}`;
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
        destAccount: params.recipient,
        srcAmount: BigInt(params.srcAmount),
        destMinAmount: BigInt(params.destMinAmount),
      },
      params.routeData ?? "0x12345678",
    ],
  });
}

function piteasCalldataForRecipient(recipient: `0x${string}`): Hex {
  return piteasCalldataFor({
    recipient,
    srcToken: EUSDC_TOKEN_ADDRESS,
    destToken: PHIAT_TOKEN_ADDRESS,
    srcAmount: RAW_INPUT,
    destMinAmount: "1",
  });
}

function liveRouterFixtureCalldata(): Hex {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/piteas-live-router-calldata.json", "utf8"),
  ) as { quote: { methodParameters: { calldata: Hex } } };
  return fixture.quote.methodParameters.calldata;
}

function largeLiveDerivedCalldata(): Hex {
  const decoded = decodePiteasRouterSwapCalldata({
    to: VERIFIED_PITEAS_ROUTER,
    data: liveRouterFixtureCalldata(),
    valueWei: "0",
  });
  if (!decoded.ok) throw new Error(decoded.reason);
  const route = decoded.intent.routeDataRaw;
  const enlargedRoute =
    `${route}${route.slice(2)}${route.slice(2, 2 + 256)}` as Hex;
  const calldata = encodeFunctionData({
    abi: piteasRouterSwapAbi,
    functionName: "swap",
    args: [
      {
        srcToken: decoded.intent.sourceToken,
        destToken: decoded.intent.destinationToken,
        destAccount: decoded.intent.destinationAccount,
        srcAmount: BigInt(decoded.intent.sourceAmountRaw),
        destMinAmount: BigInt(decoded.intent.destinationMinimumAmountRaw),
      },
      enlargedRoute,
    ],
  });
  expect(calldata.length - 2).toBeGreaterThan(7000);
  return calldata;
}

function largeLiveDerivedSellCalldata(): Hex {
  const decoded = decodePiteasRouterSwapCalldata({
    to: VERIFIED_PITEAS_ROUTER,
    data: liveRouterFixtureCalldata(),
    valueWei: "0",
  });
  if (!decoded.ok) throw new Error(decoded.reason);
  const route = decoded.intent.routeDataRaw;
  const enlargedRoute =
    `${route}${route.slice(2)}${route.slice(2, 2 + 256)}` as Hex;
  const calldata = piteasCalldataFor({
    recipient: WALLET,
    srcToken: PHIAT_TOKEN_ADDRESS,
    destToken: EUSDC_TOKEN_ADDRESS,
    srcAmount: FULL_POSITION_PHIAT_RAW,
    destMinAmount: FULL_POSITION_EUSDC_FLOOR_RAW,
    routeData: enlargedRoute,
  });
  expect(calldata.length - 2).toBeGreaterThan(7000);
  return calldata;
}

function quoteFromCalldata(calldata: Hex, overrides: Partial<PiteasQuoteData> = {}): PiteasQuoteData {
  const decoded = decodePiteasRouterSwapCalldata({
    to: VERIFIED_PITEAS_ROUTER,
    data: calldata,
    valueWei: "0",
  });
  if (!decoded.ok) throw new Error(decoded.reason);
  const amountOut = (BigInt(decoded.intent.destinationMinimumAmountRaw) + 1n).toString();
  return {
    srcToken: tokenMeta(decoded.intent.sourceToken),
    destToken: tokenMeta(decoded.intent.destinationToken),
    amountIn: decoded.intent.sourceAmountRaw,
    amountOut,
    amountOutMin: decoded.intent.destinationMinimumAmountRaw,
    amountOutMinSource: "computed_slippage_floor",
    valueWei: "0",
    valuePls: "0",
    gasUseEstimate: 1_600_000,
    gasUseEstimateUSD: 0.01,
    priceImpactPercent: null,
    blockNumber: null,
    quoteTimestamp: null,
    quoteIdentifier: null,
    expiresAt: null,
    cacheHeaders: null,
    responseFingerprint: fingerprint({
      fixture: "large-live-derived-piteas",
      calldataFingerprint: fingerprint(calldata),
    }),
    endpoint: "https://sdk.piteas.io/quote",
    retryCount: 0,
    methodParameters: {
      calldata,
      value: "0x0",
    },
    router: VERIFIED_PITEAS_ROUTER,
    route: {
      pathCount: 1,
      swapCount: 1,
      protocols: ["PulseX V2", "Phux"],
      signature: "test-large-live-derived",
    },
    tokenInParam: decoded.intent.sourceToken,
    tokenOutParam: decoded.intent.destinationToken,
    allowedSlippage: 0.5,
    account: WALLET,
    chainId: 369,
    quoteReady: true,
    note: "test quote",
    decodeNote: "test decode",
    ...overrides,
  };
}

function simulationRows(
  outputRaw = "123456789000000000000",
  gasEstimate = "1600000",
): RpcPinnedSimulationRow[] {
  return [
    {
      rpc: "https://rpc-a.example",
      pinnedBlock: "123",
      ethCallPassed: true,
      outputRaw,
      revertData: null,
      decodedRevert: null,
      estimateGasPassed: true,
      gasEstimate,
      error: null,
    },
    {
      rpc: "https://rpc-b.example",
      pinnedBlock: "123",
      ethCallPassed: true,
      outputRaw,
      revertData: null,
      decodedRevert: null,
      estimateGasPassed: true,
      gasEstimate,
      error: null,
    },
  ];
}

function proposalFromRequest(
  req: Parameters<PiteasAgentSwapDeps["proposeAgentTx"]>[1],
): TxProposalWithReview {
  return {
    id: "prop_aaaaaaaaaaaaaaaaaaaaaaaa",
    walletId: req.walletId,
    from: WALLET,
    to: req.to,
    valueWei: "0",
    valuePls: 0,
    data: req.data ?? "0x",
    createdAt: new Date(BASE_NOW + 1000).toISOString(),
    expiresAt: req.proposalExpiresAt ?? new Date(BASE_NOW + 60_000).toISOString(),
    simulation: {
      attempted: true,
      ok: true,
      gasEstimate: "1600000",
      estimatedFeePlsApprox: 0.00161,
      estimatedFeeWeiApprox: "1610000000000000",
      feeBasis: "gasPrice",
    },
    policyCheck: { allowed: true } as never,
    status: "pending",
    provenance: req.provenance,
    reviewSummary: {} as never,
  };
}

function successDeps(
  quote: PiteasQuoteData,
  overrides: Partial<PiteasAgentSwapDeps> = {},
): PiteasAgentSwapDeps {
  let saved: TxProposal | null = null;
  const defaultTokenSpendCapacity =
    BigInt(quote.amountIn) > BigInt(RAW_INPUT) ? quote.amountIn : RAW_INPUT;
  const deps: PiteasAgentSwapDeps = {
    nowMs: vi.fn(() => BASE_NOW),
    getAgentWalletInfo: vi.fn(async () => ({
      id: WALLET_ID,
      address: WALLET,
      createdAt: new Date(BASE_NOW).toISOString(),
      policy: {
        enabled: true,
        killed: false,
        maxPlsPerTx: 100,
        maxPlsDaily: 1000,
        contractAllowlist: [],
        tokenAllowlist: [],
        allowlistExpiresAt: null,
        tokenSpendCaps: {},
        tokenDailyCaps: {},
        erc20NotionalCaps: {},
        requireDecodableCalldata: false,
        allowNativeTransfers: true,
      },
      dailySpend: { date: "2026-08-04", spentPls: 0 },
      tokenDailySpend: {},
      legacyCapsDisplayOnly: true,
      legacyCapsNote: "display only",
    })),
    getPiteasQuote: vi.fn(async () => ({
      ok: true,
      source: "piteas",
      advisory: true,
      data: quote,
    })),
    preparePiteasSwap: vi.fn(preparePiteasSwap),
    decodePiteasRouterSwapCalldata,
    inspectTokenNotional,
    buildAgentIntentView,
    proposeAgentTx: vi.fn(async (_config, req) => {
      const proposal = proposalFromRequest(req);
      saved = proposal;
      return proposal;
    }),
    loadProposal: vi.fn((_config, _proposalId) => {
      if (!saved) throw new Error("proposal not saved");
      return saved;
    }),
    saveProposal: vi.fn((_config, proposal) => {
      saved = proposal;
    }),
    readTokenBalance: vi.fn(async () => defaultTokenSpendCapacity),
    readTokenAllowance: vi.fn(async () => defaultTokenSpendCapacity),
    readNativeBalanceWei: vi.fn(async () => "100000000000000000000000"),
    getFeeData: vi.fn(async () => ({
      gasPriceWei: "1000000000",
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    })),
    simulateSameBlock: vi.fn(async () => simulationRows()),
  };
  return { ...deps, ...overrides };
}

function quoteFail(reason: string, status?: number): PiteasQuoteResult {
  return {
    ok: false,
    source: "piteas",
    advisory: true,
    reason,
    ...(status !== undefined ? { status } : {}),
  };
}

describe("Piteas in-process wallet proposal boundary", () => {
  it("rejects odd-length executable calldata at every local boundary before intent creation", async () => {
    const oddCalldata = `${PITEAS_ROUTER_SWAP_SELECTOR}0`;
    const body = {
      methodParameters: { calldata: oddCalldata, value: "0x0" },
      srcToken: { address: EUSDC_TOKEN_ADDRESS },
      destToken: { address: PHIAT_TOKEN_ADDRESS },
      srcAmount: RAW_INPUT,
      destAmount: "1",
    };
    const meta = {
      tokenInParam: EUSDC_TOKEN_ADDRESS,
      tokenOutParam: PHIAT_TOKEN_ADDRESS,
      amount: RAW_INPUT,
      allowedSlippage: 0.5,
      account: WALLET,
      sellingNativePls: false,
    };

    expect(normalizePiteasQuote(body, meta).ok).toBe(false);
    const fetched = await getPiteasQuote(
      { httpTimeoutMs: 5000 },
      {
        tokenIn: EUSDC_TOKEN_ADDRESS,
        tokenOut: PHIAT_TOKEN_ADDRESS,
        amount: RAW_INPUT,
        allowedSlippage: 0.5,
        account: WALLET,
      },
      {
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      },
    );
    expect(fetched.ok).toBe(false);
    expect(
      preparePiteasSwap({
        ...quoteFromCalldata(liveRouterFixtureCalldata()),
        methodParameters: { calldata: oddCalldata, value: "0x0" },
        quoteReady: true,
      }).ok,
    ).toBe(false);
    const decoded = decodePiteasRouterSwapCalldata({
      to: VERIFIED_PITEAS_ROUTER,
      data: oddCalldata,
      valueWei: "0",
    });
    expect(decoded.ok).toBe(false);
    expect(decoded.reason).toMatch(/not even-length hex/i);
    expect(validateExecutableCalldata({
      sourceField: "methodParameters.calldata",
      calldata: oddCalldata,
      requiredSelector: PITEAS_ROUTER_SWAP_SELECTOR,
    }).ok).toBe(false);
  });

  it("proves strict decode and inspectTokenNotional cannot disagree on exact same large live-derived calldata", () => {
    const calldata = largeLiveDerivedCalldata();
    const decoded = decodePiteasRouterSwapCalldata({
      to: VERIFIED_PITEAS_ROUTER,
      data: calldata,
      valueWei: "0",
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.intent.topLevelDecodeStatus).toBe("PASSED_CANONICAL");

    const inspection = inspectTokenNotional({
      to: VERIFIED_PITEAS_ROUTER,
      data: calldata,
      valueWei: "0",
    });
    const intent = buildAgentIntentView({
      to: VERIFIED_PITEAS_ROUTER,
      data: calldata,
      valueWei: "0",
      inspection,
    });
    expect(intent.decodeKnowledge.status).toBe("known_top_level_with_opaque_route");
    expect(intent.agentGuidance).toBe("review_carefully");
    expect(intent.decodeKnowledge.status).not.toBe("truncated_or_invalid");
    expect(intent.piteas?.calldataFingerprint).toBe(decoded.intent.calldataFingerprint);
    expect(intent.piteas?.routeDataFingerprint).toBe(decoded.intent.routeDataFingerprint);
    expect(intent.piteas?.routeDataByteLength).toBe(decoded.intent.routeDataByteLength);
  });

  it("creates exactly one pending proposal on the successful in-process path and omits raw calldata from output", async () => {
    const calldata = largeLiveDerivedCalldata();
    const quote = quoteFromCalldata(calldata);
    const deps = successDeps(quote);

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);

    expect(result.ok).toBe(true);
    expect(result.classification).toBe("READY_FOR_HUMAN_CONFIRMATION");
    expect(result.swapDirection).toBe("BUY_PHIAT");
    expect(result.tokenIn).toBe(EUSDC_TOKEN_ADDRESS);
    expect(result.tokenOut).toBe(PHIAT_TOKEN_ADDRESS);
    expect(result.inputAmountRaw).toBe(RAW_INPUT);
    expect(result.inputBalanceRaw).toBe(RAW_INPUT);
    expect(result.currentAllowanceRaw).toBe(RAW_INPUT);
    expect(result.readyForHumanConfirmation).toBe(true);
    expect(result.proposalStatus).toBe("pending");
    expect(result.proposalId).toBe("prop_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.calldataHexCharacterCount).toBeGreaterThan(7000);
    expect(result.upstreamCalldataFingerprint).toBe(fingerprint(calldata));
    expect(result.preparedCalldataFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.decoderInputFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.walletInspectionInputFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.simulationInputFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.proposalInputFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.savedProposalCalldataFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.everyCalldataFingerprintMatched).toBe(true);
    expect(result.topLevelDecodeStatus).toBe("PASSED_CANONICAL");
    expect(result.decodeKnowledge).toBe("known_top_level_with_opaque_route");
    expect(result.agentGuidance).toBe("review_carefully");
    expect(result.twoRpcSimulation).toHaveLength(2);
    expect(result.internalProposalSimulation?.ok).toBe(true);
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(deps.preparePiteasSwap).toHaveBeenCalledTimes(1);
    expect(deps.proposeAgentTx).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(calldata);
    expect(JSON.stringify(result)).not.toMatch(
      /privateKey|masterKey|seed|mnemonic|ciphertext|rawSigned|signedTransaction/i,
    );
  });

  it("creates one pending full-position PHIAT sell proposal with bounded output and gas constraints", async () => {
    const calldata = largeLiveDerivedSellCalldata();
    const expectedOutputRaw = (BigInt(FULL_POSITION_EUSDC_FLOOR_RAW) + 123n).toString();
    const quote = quoteFromCalldata(calldata, {
      amountOut: expectedOutputRaw,
      amountOutMin: FULL_POSITION_EUSDC_FLOOR_RAW,
      route: {
        pathCount: 2,
        swapCount: 4,
        protocols: ["PulseX V2", "Phux"],
        pools: ["0xpoola", "0xpoolb"],
        tokenPath: [PHIAT_TOKEN_ADDRESS, "WPLS", EUSDC_TOKEN_ADDRESS],
        allocations: [{ percent: 60 }, { percent: 40 }],
        signature: "test-full-position-sell",
      },
    });
    const deps = successDeps(quote, {
      simulateSameBlock: vi.fn(async () => simulationRows(expectedOutputRaw, "1200000")),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
      allowedSlippage: 0.5,
      minimumExecutableOutputRaw: FULL_POSITION_EUSDC_FLOOR_RAW,
      maximumEstimatedGasCostPls: "1500",
      requireInputAmountEqualsBalance: true,
    }, deps);

    expect(result.ok).toBe(true);
    expect(result.classification).toBe("READY_FOR_HUMAN_CONFIRMATION");
    expect(result.swapDirection).toBe("SELL_PHIAT");
    expect(result.tokenIn).toBe(PHIAT_TOKEN_ADDRESS);
    expect(result.tokenOut).toBe(EUSDC_TOKEN_ADDRESS);
    expect(result.inputAmountRaw).toBe(FULL_POSITION_PHIAT_RAW);
    expect(result.inputBalanceRaw).toBe(FULL_POSITION_PHIAT_RAW);
    expect(result.currentAllowanceRaw).toBe(FULL_POSITION_PHIAT_RAW);
    expect(result.expectedOutputRaw).toBe(expectedOutputRaw);
    expect(result.executableMinimumOutputRaw).toBe(FULL_POSITION_EUSDC_FLOOR_RAW);
    expect(result.minimumExecutableOutputFloorRaw).toBe(FULL_POSITION_EUSDC_FLOOR_RAW);
    expect(result.estimatedGas).toBe("1200000");
    expect(Number(result.estimatedGasCostPls)).toBeLessThan(1500);
    expect(result.proposalStatus).toBe("pending");
    expect(result.readyForHumanConfirmation).toBe(true);
    expect(result.everyCalldataFingerprintMatched).toBe(true);
    expect(result.calldataHexCharacterCount).toBeGreaterThan(7000);
    expect(result.upstreamCalldataFingerprint).toBe(fingerprint(calldata));
    expect(result.savedProposalCalldataFingerprint).toBe(result.upstreamCalldataFingerprint);
    expect(result.twoRpcSimulation?.map((row) => row.outputRaw)).toEqual([
      expectedOutputRaw,
      expectedOutputRaw,
    ]);
    expect(deps.readTokenBalance).toHaveBeenCalledWith(expect.anything(), PHIAT_TOKEN_ADDRESS, WALLET);
    expect(deps.readTokenAllowance).toHaveBeenCalledWith(
      expect.anything(),
      PHIAT_TOKEN_ADDRESS,
      WALLET,
      VERIFIED_PITEAS_ROUTER,
    );
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(deps.proposeAgentTx).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(calldata);
  });

  it.each([
    [
      "arbitrary third token pair",
      "0x1111111111111111111111111111111111111111" as const,
      PHIAT_TOKEN_ADDRESS,
    ],
    ["PHIAT to PHIAT", PHIAT_TOKEN_ADDRESS, PHIAT_TOKEN_ADDRESS],
    ["eUSDC to eUSDC", EUSDC_TOKEN_ADDRESS, EUSDC_TOKEN_ADDRESS],
  ])("rejects unsupported pair: %s", async (_name, tokenIn, tokenOut) => {
    const deps = successDeps(quoteFromCalldata(liveRouterFixtureCalldata()));

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn,
      tokenOut,
      amountRaw: RAW_INPUT,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("UNSUPPORTED_TOKEN_PAIR");
    expect(result.reason).toBe("UNSUPPORTED_TOKEN_PAIR");
    expect(deps.getAgentWalletInfo).not.toHaveBeenCalled();
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("returns bounded-allowance guidance without creating approvals when PHIAT allowance is insufficient", async () => {
    const calldata = largeLiveDerivedSellCalldata();
    const quote = quoteFromCalldata(calldata);
    const deps = successDeps(quote, {
      readTokenAllowance: vi.fn(async () => "0"),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("NEEDS_BOUNDED_ALLOWANCE");
    expect(result.tokenIn).toBe(PHIAT_TOKEN_ADDRESS);
    expect(result.currentAllowanceRaw).toBe("0");
    expect(result.requiredAllowanceRaw).toBe(FULL_POSITION_PHIAT_RAW);
    expect(result.verifiedSpender).toBe(VERIFIED_PITEAS_ROUTER);
    expect(result.unlimitedApproval).toBe(false);
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(deps.preparePiteasSwap).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it.each([
    ["amount below balance", (BigInt(FULL_POSITION_PHIAT_RAW) - 1n).toString()],
    ["amount above balance", (BigInt(FULL_POSITION_PHIAT_RAW) + 1n).toString()],
  ])("rejects %s when full-balance equality is required", async (_name, amountRaw) => {
    const quote = quoteFromCalldata(largeLiveDerivedSellCalldata());
    const deps = successDeps(quote, {
      readTokenBalance: vi.fn(async () => FULL_POSITION_PHIAT_RAW),
      readTokenAllowance: vi.fn(async () => FULL_POSITION_PHIAT_RAW),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw,
      requireInputAmountEqualsBalance: true,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("INPUT_BALANCE_CHANGED");
    expect(result.reason).toBe("INPUT_BALANCE_CHANGED");
    expect(result.inputBalanceRaw).toBe(FULL_POSITION_PHIAT_RAW);
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects amount above live input balance without requesting a quote", async () => {
    const deps = successDeps(quoteFromCalldata(largeLiveDerivedSellCalldata()), {
      readTokenBalance: vi.fn(async () => FULL_POSITION_PHIAT_RAW),
      readTokenAllowance: vi.fn(async () => (BigInt(FULL_POSITION_PHIAT_RAW) + 1n).toString()),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: (BigInt(FULL_POSITION_PHIAT_RAW) + 1n).toString(),
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.failureStage).toBe("wallet_state");
    expect(result.reason).toMatch(/insufficient input-token balance/);
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects decoded executable minimum one raw unit below the output floor", async () => {
    const floor = BigInt(FULL_POSITION_EUSDC_FLOOR_RAW);
    const calldata = piteasCalldataFor({
      recipient: WALLET,
      srcToken: PHIAT_TOKEN_ADDRESS,
      destToken: EUSDC_TOKEN_ADDRESS,
      srcAmount: FULL_POSITION_PHIAT_RAW,
      destMinAmount: (floor - 1n).toString(),
    });
    const deps = successDeps(quoteFromCalldata(calldata, { amountOut: (floor + 10n).toString() }));

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
      minimumExecutableOutputRaw: FULL_POSITION_EUSDC_FLOOR_RAW,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("MINIMUM_OUTPUT_BELOW_FLOOR");
    expect(result.failureStage).toBe("strict_decode");
    expect(deps.simulateSameBlock).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects same-block RPC output below the output floor", async () => {
    const calldata = piteasCalldataFor({
      recipient: WALLET,
      srcToken: PHIAT_TOKEN_ADDRESS,
      destToken: EUSDC_TOKEN_ADDRESS,
      srcAmount: FULL_POSITION_PHIAT_RAW,
      destMinAmount: FULL_POSITION_EUSDC_FLOOR_RAW,
    });
    const belowFloor = (BigInt(FULL_POSITION_EUSDC_FLOOR_RAW) - 1n).toString();
    const deps = successDeps(quoteFromCalldata(calldata), {
      simulateSameBlock: vi.fn(async () => simulationRows(belowFloor)),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
      minimumExecutableOutputRaw: FULL_POSITION_EUSDC_FLOOR_RAW,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("MINIMUM_OUTPUT_BELOW_FLOOR");
    expect(result.failureStage).toBe("same_block_simulation");
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects slippage above 0.5 before wallet or quote work", async () => {
    const deps = successDeps(quoteFromCalldata(liveRouterFixtureCalldata()));

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
      allowedSlippage: 0.5001,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("SLIPPAGE_LIMIT_EXCEEDED");
    expect(result.reason).toBe("SLIPPAGE_LIMIT_EXCEEDED");
    expect(deps.getAgentWalletInfo).not.toHaveBeenCalled();
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("accepts gas cost exactly at the configured limit", async () => {
    const calldata = piteasCalldataFor({
      recipient: WALLET,
      srcToken: PHIAT_TOKEN_ADDRESS,
      destToken: EUSDC_TOKEN_ADDRESS,
      srcAmount: FULL_POSITION_PHIAT_RAW,
      destMinAmount: FULL_POSITION_EUSDC_FLOOR_RAW,
    });
    const deps = successDeps(quoteFromCalldata(calldata), {
      simulateSameBlock: vi.fn(async () => simulationRows(FULL_POSITION_EUSDC_FLOOR_RAW, "1600000")),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
      maximumEstimatedGasCostPls: "0.0016",
    }, deps);

    expect(result.ok).toBe(true);
    expect(result.estimatedGasCostPls).toBe("0.0016");
    expect(deps.proposeAgentTx).toHaveBeenCalledTimes(1);
  });

  it("rejects gas cost above the configured limit before proposal creation", async () => {
    const calldata = piteasCalldataFor({
      recipient: WALLET,
      srcToken: PHIAT_TOKEN_ADDRESS,
      destToken: EUSDC_TOKEN_ADDRESS,
      srcAmount: FULL_POSITION_PHIAT_RAW,
      destMinAmount: FULL_POSITION_EUSDC_FLOOR_RAW,
    });
    const deps = successDeps(quoteFromCalldata(calldata), {
      simulateSameBlock: vi.fn(async () => simulationRows(FULL_POSITION_EUSDC_FLOOR_RAW, "1600001")),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: PHIAT_TOKEN_ADDRESS,
      tokenOut: EUSDC_TOKEN_ADDRESS,
      amountRaw: FULL_POSITION_PHIAT_RAW,
      maximumEstimatedGasCostPls: "0.0016",
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("GAS_COST_ABOVE_LIMIT");
    expect(result.reason).toBe("GAS_COST_ABOVE_LIMIT");
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("rejects a one-character handoff truncation before proposal creation", async () => {
    const calldata = largeLiveDerivedCalldata();
    const quote = quoteFromCalldata(calldata);
    const goodPrepared = preparePiteasSwap(quote, { account: WALLET });
    if (!goodPrepared.ok) throw new Error(goodPrepared.reason);
    const deps = successDeps(quote, {
      preparePiteasSwap: vi.fn(() => ({
        ...goodPrepared,
        intent: {
          ...goodPrepared.intent,
          data: goodPrepared.intent.data.slice(0, -1),
        },
        methodParameters: {
          ...goodPrepared.methodParameters,
          calldata: goodPrepared.methodParameters.calldata.slice(0, -1),
        },
      } as never)),
    });

    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("CALLDATA_HANDOFF_MISMATCH");
    expect(result.reason).toMatch(/handoff mismatch/i);
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
    expect(assertCalldataHandoffIntegrity([
      buildCalldataCheckpoint("a", calldata),
      buildCalldataCheckpoint("b", calldata.slice(0, -1)),
    ]).ok).toBe(false);
  });

  it.each([
    ["HTTP 500", quoteFail("Piteas HTTP 500", 500), "INFRASTRUCTURE_REQUOTE_REQUIRED"],
    ["timeout", quoteFail("Piteas request timed out after 5000ms"), "INFRASTRUCTURE_REQUOTE_REQUIRED"],
    ["invalid JSON", quoteFail("Piteas returned invalid JSON (HTTP 200)"), "INFRASTRUCTURE_REQUOTE_REQUIRED"],
    [
      "odd calldata",
      quoteFail("Piteas methodParameters.calldata missing or not even-length hex"),
      "PITEAS_MALFORMED_CALLDATA",
    ],
  ])("%s creates no proposal and performs no automatic retry", async (_name, quoteResult, classification) => {
    const deps = successDeps(quoteFromCalldata(liveRouterFixtureCalldata()), {
      getPiteasQuote: vi.fn(async () => quoteResult),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe(classification);
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(deps.preparePiteasSwap).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong router",
      () => quoteFromCalldata(liveRouterFixtureCalldata(), {
        router: "0x0000000000000000000000000000000000000001" as never,
      }),
      "quote_validation",
    ],
    [
      "wrong token",
      () => quoteFromCalldata(liveRouterFixtureCalldata(), {
        srcToken: { address: PHIAT_TOKEN_ADDRESS },
      }),
      "quote_validation",
    ],
    [
      "wrong amount",
      () => quoteFromCalldata(liveRouterFixtureCalldata(), { amountIn: "1" }),
      "quote_validation",
    ],
    [
      "zero output",
      () => quoteFromCalldata(liveRouterFixtureCalldata(), { amountOut: "0" }),
      "quote_validation",
    ],
    [
      "missing calldata",
      () => ({
        ...quoteFromCalldata(liveRouterFixtureCalldata()),
        methodParameters: { value: "0x0" },
      }),
      "quote_calldata",
    ],
    [
      "strict decoder failure",
      () => ({
        ...quoteFromCalldata(liveRouterFixtureCalldata()),
        methodParameters: {
          calldata: `${PITEAS_ROUTER_SWAP_SELECTOR}${"00".repeat(12)}`,
          value: "0x0",
        },
      }),
      "strict_decode",
    ],
  ])("%s creates no proposal", async (_name, makeQuote, stage) => {
    const deps = successDeps(makeQuote() as PiteasQuoteData);
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.failureStage).toBe(stage);
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("preserves multiprocess strict fail-closed behavior before quote or proposal work", async () => {
    const quote = quoteFromCalldata(liveRouterFixtureCalldata());
    const deps = successDeps(quote, {
      getAgentWalletInfo: vi.fn(async () => {
        throw new Error("AGENT_WALLET_MULTIPROC_STRICT=true: wallet write refused");
      }),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("UNKNOWN_FAIL_CLOSED");
    expect(result.reason).toMatch(/MULTIPROC_STRICT|write refused/i);
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("wrong decoded recipient creates no proposal", async () => {
    const base = decodePiteasRouterSwapCalldata({
      to: VERIFIED_PITEAS_ROUTER,
      data: liveRouterFixtureCalldata(),
      valueWei: "0",
    });
    if (!base.ok) throw new Error(base.reason);
    const wrongRecipient = encodeFunctionData({
      abi: piteasRouterSwapAbi,
      functionName: "swap",
      args: [
        {
          srcToken: base.intent.sourceToken,
          destToken: base.intent.destinationToken,
          destAccount: "0x1111111111111111111111111111111111111111",
          srcAmount: BigInt(base.intent.sourceAmountRaw),
          destMinAmount: BigInt(base.intent.destinationMinimumAmountRaw),
        },
        base.intent.routeDataRaw,
      ],
    });
    const deps = successDeps(quoteFromCalldata(wrongRecipient, { account: WALLET }));
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.failureStage).toBe("strict_decode");
    expect(result.reason).toMatch(/recipient/i);
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("wallet inspection mismatch creates no proposal", async () => {
    const calldata = liveRouterFixtureCalldata();
    const quote = quoteFromCalldata(calldata);
    const actualReview = buildAgentIntentView({
      to: VERIFIED_PITEAS_ROUTER,
      data: calldata,
      valueWei: "0",
      inspection: inspectTokenNotional({ to: VERIFIED_PITEAS_ROUTER, data: calldata }),
    });
    const deps = successDeps(quote, {
      buildAgentIntentView: vi.fn(() => ({
        ...actualReview,
        piteas: {
          ...actualReview.piteas!,
          sourceAmountRaw: "1",
        },
      })),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.failureStage).toBe("wallet_inspection");
    expect(result.reason).toMatch(/source amount mismatch/i);
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it.each([
    [
      "two-RPC output disagreement",
      [
        ...simulationRows("100"),
      ].map((row, index) => ({ ...row, outputRaw: index === 0 ? "100" : "101" })),
      "RPC_STATE_DISAGREEMENT",
    ],
    [
      "two-RPC gas-estimate disagreement",
      [
        ...simulationRows("100"),
      ].map((row, index) => ({ ...row, gasEstimate: index === 0 ? "1600000" : "1600001" })),
      "RPC_STATE_DISAGREEMENT",
    ],
    [
      "protocol route revert",
      [
        {
          ...simulationRows()[0],
          ethCallPassed: false,
          outputRaw: null,
          error: "execution reverted: BalancerV2Error",
          decodedRevert: "BalancerV2Error",
        },
        simulationRows()[1],
      ],
      "ROUTE_NOT_EXECUTABLE",
    ],
  ])("%s creates no proposal", async (_name, rows, classification) => {
    const quote = quoteFromCalldata(liveRouterFixtureCalldata());
    const deps = successDeps(quote, {
      simulateSameBlock: vi.fn(async () => rows as RpcPinnedSimulationRow[]),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe(classification);
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("proposal internal simulation failure creates no proposal record through the in-process workflow", async () => {
    const quote = quoteFromCalldata(liveRouterFixtureCalldata());
    const deps = successDeps(quote, {
      proposeAgentTx: vi.fn(async () => {
        throw new Error("Proposal simulation required but failed");
      }),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("PROPOSAL_INTERNAL_SIMULATION_FAILED");
    expect(deps.loadProposal).not.toHaveBeenCalled();
  });

  it("service requireSimulationSuccess throws before saveProposal on failed simulation", async () => {
    const cfg = walletTestConfig();
    vi.spyOn(rpc, "getPublicClient").mockReturnValue({
      getBytecode: async () => "0x6000",
    } as never);
    vi.spyOn(rpc, "estimateGas").mockRejectedValue(new Error("gas cannot be estimated"));
    vi.spyOn(rpc, "ethCall").mockResolvedValue({ data: "0x" });
    vi.spyOn(rpc, "getFeeData").mockResolvedValue({
      gasPriceWei: "1000000000",
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    });

    const wallet = await createAgentWallet(cfg);
    await expect(proposeAgentTx(cfg, {
      walletId: wallet.id,
      to: VERIFIED_PITEAS_ROUTER,
      valuePls: 0,
      data: piteasCalldataForRecipient(wallet.address),
      requireSimulationSuccess: true,
    })).rejects.toThrow(/simulation required but failed/i);

    const proposalDir = join(cfg.agentWalletDir, "proposals");
    expect(existsSync(proposalDir) ? readdirSync(proposalDir) : []).toEqual([]);
  });

  it("quote stale before proposal creates no proposal", async () => {
    const quote = quoteFromCalldata(liveRouterFixtureCalldata());
    const deps = successDeps(quote, {
      nowMs: vi
        .fn()
        .mockReturnValueOnce(BASE_NOW)
        .mockReturnValueOnce(BASE_NOW + 61_000),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
      maximumQuoteAgeMs: 60_000,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("QUOTE_STALE");
    expect(deps.proposeAgentTx).not.toHaveBeenCalled();
  });

  it("saved proposal fingerprint mismatch rejects and invalidates the proposal locally", async () => {
    const calldata = liveRouterFixtureCalldata();
    const quote = quoteFromCalldata(calldata);
    const deps = successDeps(quote, {
      loadProposal: vi.fn((_config, proposalId) => ({
        ...proposalFromRequest({
          walletId: WALLET_ID,
          to: VERIFIED_PITEAS_ROUTER,
          valuePls: 0,
          data: calldata.slice(0, -2) as Hex,
        }),
        id: proposalId,
      })),
    });
    const result = await runPiteasProposeAgentSwap(testConfig(), {
      walletId: WALLET_ID,
      tokenIn: EUSDC_TOKEN_ADDRESS,
      tokenOut: PHIAT_TOKEN_ADDRESS,
      amountRaw: RAW_INPUT,
    }, deps);
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("SAVED_PROPOSAL_INTEGRITY_MISMATCH");
    expect(deps.proposeAgentTx).toHaveBeenCalledTimes(1);
    expect(deps.saveProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "rejected" }),
    );
  });

  it("preserves safety boundaries: no approval, signing, submission, broadcasting, execution, or secret exposure code is added", () => {
    const source = readFileSync(
      "src/tools/wallet/piteasProposeAgentSwap.ts",
      "utf8",
    );
    expect(source).not.toMatch(
      /\bexecuteAgentTx\b|sendTransaction\(|sendRawTransaction\(|signTransaction\(|writeContract\(|approve\(|erc20Approve|buildApprovalIntent|decryptPrivateKey\(|decryptSecret\(|createWalletClient\(/i,
    );
    expect(source).not.toMatch(
      /loadWalletRecord|requireMasterKey|agentWalletMasterKey|\.env\.wallet|encryptedKey|seedPhrase|seed phrase|mnemonic|raw signed|rawSigned/i,
    );
    expect(source).toMatch(/neverReturnPrivateKey/);
  });
});
