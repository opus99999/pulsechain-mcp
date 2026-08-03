import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData } from "viem";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppConfig } from "../src/types.js";
import {
  PITEAS_ROUTER,
  getPiteasRateLimitBudget,
  preparePiteasSwap,
  reservePiteasRateLimitSlots,
  resetPiteasRateLimitForTests,
  type PiteasPrepareResult,
  type PiteasQuoteData,
} from "../src/data/index.js";
import {
  buildPhiatShadowBuy,
  decodeShadowBuyCalldata,
  PHIAT_SHADOW_BUY_TOKEN_IN,
  PHIAT_SHADOW_BUY_TOKEN_OUT,
  registerPhiatShadowBuyTool,
  type PhiatShadowBuyDeps,
} from "../src/tools/analytics/phiatShadowBuy.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const BAD_ROUTER = "0x4444444444444444444444444444444444444444";
const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const REF_RAW = "5000000";
const AMOUNT_50_RAW = "50000000";
const REF_OUTPUT_RAW = "100000000000000000000";
const CANDIDATE_OUTPUT_RAW = "980000000000000000000";
const CANDIDATE_MIN_RAW = "970000000000000000000";
const APPROVED_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNAPPROVED_HASH =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const shadowSwapAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const baseConfig: AppConfig = {
  rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
  rpcUrl: "https://rpc-a.example",
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://graph.example/v1",
  pulseXSubgraphV2: "https://graph.example/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets-test",
  agentWalletMultiprocStrict: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "error",
  httpTimeoutMs: 30_000,
};

beforeEach(() => {
  resetPiteasRateLimitForTests();
  vi.restoreAllMocks();
  (defaultQuoteMock as unknown as { count?: number }).count = 0;
});

function swapCalldata(overrides: {
  tokenIn?: string;
  tokenOut?: string;
  amountInRaw?: string;
  minOutputRaw?: string;
  recipient?: string;
  deadline?: bigint;
} = {}): `0x${string}` {
  return encodeFunctionData({
    abi: shadowSwapAbi,
    functionName: "swap",
    args: [
      (overrides.tokenIn ?? PHIAT_SHADOW_BUY_TOKEN_IN) as `0x${string}`,
      (overrides.tokenOut ?? PHIAT_SHADOW_BUY_TOKEN_OUT) as `0x${string}`,
      BigInt(overrides.amountInRaw ?? AMOUNT_50_RAW),
      BigInt(overrides.minOutputRaw ?? CANDIDATE_MIN_RAW),
      (overrides.recipient ?? WALLET) as `0x${string}`,
      overrides.deadline ?? 1_808_000_000n,
    ],
  });
}

function quoteData(overrides: Partial<PiteasQuoteData> & {
  label?: string;
  amountInRaw?: string;
  outputRaw?: string;
  minRaw?: string;
  recipient?: string;
} = {}): PiteasQuoteData {
  const amountIn = overrides.amountInRaw ?? overrides.amountIn ?? AMOUNT_50_RAW;
  const output = overrides.outputRaw ?? overrides.amountOut ?? CANDIDATE_OUTPUT_RAW;
  const min = overrides.minRaw ?? overrides.amountOutMin ?? CANDIDATE_MIN_RAW;
  const label = overrides.label ?? "candidate";
  return {
    srcToken: { address: PHIAT_SHADOW_BUY_TOKEN_IN, symbol: "eUSDC", decimals: 6, chainId: 369 },
    destToken: { address: PHIAT_SHADOW_BUY_TOKEN_OUT, symbol: "PHIAT", decimals: 18, chainId: 369 },
    amountIn,
    amountOut: output,
    amountOutMin: min,
    valueWei: "0",
    valuePls: "0",
    gasUseEstimate: 250_000,
    gasUseEstimateUSD: null,
    priceImpactPercent: null,
    blockNumber: label === "reference_after" ? "124" : "123",
    quoteTimestamp: new Date(NOW).toISOString(),
    quoteIdentifier: `quote-${label}`,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    cacheHeaders: null,
    responseFingerprint: `fingerprint-${label}`,
    endpoint: "https://sdk.piteas.io/quote",
    retryCount: 0,
    methodParameters: {
      calldata: swapCalldata({
        amountInRaw: amountIn,
        minOutputRaw: min,
        recipient: overrides.recipient ?? WALLET,
        tokenOut: overrides.destToken?.address,
      }),
      value: "0",
    },
    router: PITEAS_ROUTER,
    route: {
      protocols: ["PulseX"],
      pools: [POOL],
      tokenPath: [PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT],
      router: PITEAS_ROUTER,
      signature: "pulsex:eusdc-phiat",
    },
    tokenInParam: PHIAT_SHADOW_BUY_TOKEN_IN,
    tokenOutParam: PHIAT_SHADOW_BUY_TOKEN_OUT,
    allowedSlippage: 0.5,
    account: WALLET,
    chainId: 369,
    quoteReady: true,
    note: "mock quote",
    decodeNote: "mock decode",
    ...overrides,
  };
}

function defaultQuoteMock(overrides: {
  referenceBefore?: Partial<PiteasQuoteData>;
  candidate?: Partial<PiteasQuoteData>;
  referenceAfter?: Partial<PiteasQuoteData>;
} = {}) {
  return vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
    const call = (defaultQuoteMock as unknown as { count?: number }).count ?? 0;
    (defaultQuoteMock as unknown as { count: number }).count = call + 1;
    if (call === 0) {
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: "reference_before",
          amountInRaw: req.amount,
          outputRaw: REF_OUTPUT_RAW,
          minRaw: "99000000000000000000",
          ...overrides.referenceBefore,
        }),
      };
    }
    if (call === 1) {
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: "candidate",
          amountInRaw: req.amount,
          ...overrides.candidate,
        }),
      };
    }
    return {
      ok: true,
      source: "piteas",
      advisory: true,
      data: quoteData({
        label: "reference_after",
        amountInRaw: req.amount,
        outputRaw: REF_OUTPUT_RAW,
        minRaw: "99000000000000000000",
        ...overrides.referenceAfter,
      }),
    };
  }) as never;
}

function routerIntegrity(overrides: Partial<ReturnType<typeof baseRouterIntegrity>> = {}) {
  return vi.fn(async () => ({ ...baseRouterIntegrity(), ...overrides })) as never;
}

function baseRouterIntegrity() {
  return {
    router: PITEAS_ROUTER,
    expectedRouter: PITEAS_ROUTER,
    routerMatchesAllowlist: true,
    bytecodePresent: true,
    routerBytecodeHash: APPROVED_HASH,
    approvedRouterCodeHashes: [APPROVED_HASH],
    routerCodeHashApproved: true,
    rpcCodeHashes: [
      { rpcUrl: "https://rpc-a.example", ok: true, codeHash: APPROVED_HASH, bytecodeLength: 100, error: null },
      { rpcUrl: "https://rpc-b.example", ok: true, codeHash: APPROVED_HASH, bytecodeLength: 100, error: null },
    ],
    codeHashAgreement: "agrees" as const,
    warnings: [],
  };
}

function deps(overrides: Partial<PhiatShadowBuyDeps> = {}): PhiatShadowBuyDeps {
  (defaultQuoteMock as unknown as { count: number }).count = 0;
  return {
    buildPhiatDashboard: vi.fn(async () => ({
      token: { address: PHIAT_SHADOW_BUY_TOKEN_OUT },
      market: { priceUsd: { value: "0.0001", source: "mock" } },
      liquidity: { totalLiquidityUsd: 5000 },
      dataQuality: { partialFailures: [] },
    })) as never,
    getPiteasQuote: defaultQuoteMock(),
    preparePiteasSwap,
    ethCall: vi.fn(async () => ({ data: "0x" })) as never,
    estimateGas: vi.fn(async () => ({ gasEstimate: "250000" })) as never,
    getFeeData: vi.fn(async () => ({
      gasPriceWei: "1000000000",
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    })) as never,
    reservePiteasRateLimitSlots: vi.fn(() => ({
      ok: true,
      reserved: 3,
      limit: 8,
      windowMs: 60_000,
      used: 3,
      remaining: 5,
      resetAt: new Date(NOW + 60_000).toISOString(),
      resetInMs: 60_000,
    })) as never,
    getAllowance: vi.fn(async () => AMOUNT_50_RAW),
    getInputBalance: vi.fn(async () => AMOUNT_50_RAW),
    getNativeBalanceWei: vi.fn(async () => "1000000000000000000"),
    getRouterIntegrity: routerIntegrity(),
    nowMs: () => NOW,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    walletAddress: WALLET,
    amountInHuman: "50",
    maximumGasPls: "1",
    approvedRouterCodeHashes: [APPROVED_HASH],
    ...overrides,
  };
}

function reasonCodes(result: { reasons: Array<{ code: string }> }): string[] {
  return result.reasons.map((reason) => reason.code);
}

describe("phiat_shadow_buy exact-amount shadow certificate", () => {
  it("evaluates a requested 50 eUSDC purchase directly even if fixed dashboard depth would fail", async () => {
    const d = deps({
      buildPhiatDashboard: vi.fn(async () => ({
        token: { address: PHIAT_SHADOW_BUY_TOKEN_OUT },
        piteasDepth: {
          operationalRecommendationStatus: "unavailable",
          operationalRecommendedMaximumTrancheHuman: null,
        },
      })) as never,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.exactAmountEvidence.amountInHuman).toBe("50");
    expect(result.marketContext.includePiteasDepth).toBe(false);
  });

  it("makes exactly three Piteas quote calls and uses account only on the candidate quote", async () => {
    const d = deps();
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(d.getPiteasQuote).mock.calls;
    expect(calls[0]![1]).toMatchObject({ amount: REF_RAW });
    expect(calls[0]![1]).not.toHaveProperty("account");
    expect(calls[1]![1]).toMatchObject({ amount: AMOUNT_50_RAW, account: WALLET.toLowerCase() });
    expect(calls[2]![1]).toMatchObject({ amount: REF_RAW });
    expect(calls[2]![1]).not.toHaveProperty("account");
  });

  it("requests reference-after only after the candidate quote completes", async () => {
    const events: string[] = [];
    let referenceCount = 0;
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      if (req.account) {
        events.push("candidate-start");
        await Promise.resolve();
        events.push("candidate-end");
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({ label: "candidate", amountInRaw: req.amount }),
        };
      }
      referenceCount += 1;
      events.push(referenceCount === 1 ? "reference-before-start" : "reference-after-start");
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: referenceCount === 1 ? "reference_before" : "reference_after",
          amountInRaw: req.amount,
          outputRaw: REF_OUTPUT_RAW,
          minRaw: "99000000000000000000",
        }),
      };
    }) as never;
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), deps({ getPiteasQuote: quote }));

    expect(result.decision).toBe("WOULD_BUY");
    expect(events).toEqual([
      "reference-before-start",
      "candidate-start",
      "candidate-end",
      "reference-after-start",
    ]);
    expect(quote).toHaveBeenCalledTimes(3);
  });

  it("starts the quote batch and rate-limit reservation after slow market context", async () => {
    let currentMs = NOW;
    const reserve = vi.fn((_count: number, atMs: number) => ({
      ok: true,
      reserved: 3,
      limit: 8,
      windowMs: 60_000,
      used: 3,
      remaining: 5,
      resetAt: new Date(atMs + 60_000).toISOString(),
      resetInMs: 60_000,
    }));
    const d = deps({
      nowMs: () => currentMs,
      buildPhiatDashboard: vi.fn(async () => {
        currentMs += 15_000;
        return {
          token: { address: PHIAT_SHADOW_BUY_TOKEN_OUT },
          market: { priceUsd: { value: "0.0001", source: "mock" } },
          liquidity: { totalLiquidityUsd: 5000 },
          dataQuality: { partialFailures: [] },
        };
      }) as never,
      reservePiteasRateLimitSlots: reserve as never,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    const quoteCalls = vi.mocked(d.getPiteasQuote).mock.calls;

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.exactAmountEvidence.marketContextDurationMs).toBe(15_000);
    expect(result.exactAmountEvidence.quoteBatchStartedAt).toBe(
      new Date(NOW + 15_000).toISOString(),
    );
    expect(reserve).toHaveBeenCalledWith(3, NOW + 15_000);
    expect(quoteCalls[0]![2]).toMatchObject({ timeoutMs: 20_000 });
    expect(result.quoteFreshness?.candidateAgeBeforePreparationMs).toBe(0);
  });

  it("handles realistic sequential Piteas latency under the batch deadline", async () => {
    let currentMs = NOW;
    const latencies = [9_000, 12_000, 11_000];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      const outputRaw = req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW;
      const minRaw = req.account ? CANDIDATE_MIN_RAW : "99000000000000000000";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({ label, amountInRaw: req.amount, outputRaw, minRaw }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.quoteBatchStatus).toBe("COMPLETE");
    expect(result.exactAmountEvidence.quoteBatchDurationMs).toBe(32_000);
    expect(result.referenceBefore?.latencyMs).toBe(9_000);
    expect(result.candidateQuote?.latencyMs).toBe(12_000);
    expect(result.referenceAfter?.latencyMs).toBe(11_000);
    expect(result.quoteFreshness?.candidateAgeBeforePreparationMs).toBe(11_000);
    expect(result.quoteFreshness?.candidateAgeBeforePreparationMs).toBeLessThan(30_000);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
  });

  it("accepts the live timestamp case where reference-before ages past maximumQuoteAgeMs but candidate remains fresh", async () => {
    const batchStartedMs = Date.parse("2026-08-03T12:59:58.056Z");
    let currentMs = batchStartedMs;
    const latencies = [13_079, 14_147, 16_540];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteTimestamp: null,
          expiresAt: null,
        }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
      preparePiteasSwap: vi.fn((candidate: PiteasQuoteData) =>
        preparePiteasSwap(candidate, { account: WALLET }),
      ) as never,
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 30_000, maximumBatchDurationMs: 75_000 }),
      d,
    );
    const referenceBeforeAgeAtCompletion =
      Date.parse(String(result.exactAmountEvidence.quoteBatchCompletedAt)) -
      Date.parse(String(result.referenceBefore?.responseReceivedAt));

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.quoteBatchStatus).toBe("COMPLETE");
    expect(result.exactAmountEvidence.quoteBatchDurationMs).toBe(43_766);
    expect(referenceBeforeAgeAtCompletion).toBe(30_687);
    expect(result.quoteFreshness?.candidateQuoteAgeMs).toBe(16_540);
    expect(result.referenceBeforeValidityStatus).toBe("VALID");
    expect(result.referenceAfterValidityStatus).toBe("VALID");
    expect(result.candidateFreshness?.status).toBe("FRESH");
    expect(result.sandwichTemporalStatus).toBe("COHERENT");
    expect(result.referenceFreshness?.beforeStatus).toBe("VALID");
    expect(result.referenceFreshness?.afterStatus).toBe("VALID");
    expect(result.sandwichTemporalCoherence?.quoteBatchDurationMs).toBe(43_766);
    expect(result.preparedIntent).not.toBeNull();
    expect(result.decodedIntent).not.toBeNull();
    expect(result.routerIntegrityStatus).toBe("PASSED");
    expect(result.allowanceStatus).toBe("SUFFICIENT");
    expect(result.simulationStatus).toBe("PASSED");
    expect(d.preparePiteasSwap).toHaveBeenCalledTimes(1);
    expect(d.getRouterIntegrity).toHaveBeenCalledTimes(1);
    expect(d.getInputBalance).toHaveBeenCalledTimes(1);
    expect(d.getAllowance).toHaveBeenCalledTimes(1);
    expect(d.ethCall).toHaveBeenCalledTimes(1);
    expect(d.estimateGas).toHaveBeenCalledTimes(1);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
  });

  it("rejects a reference quote that was explicitly expired when received", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceBefore: { expiresAt: new Date(NOW - 1).toISOString() },
      }),
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.referenceBeforeValidityStatus).toBe("INVALID");
    expect(result.referenceAfterValidityStatus).toBe("VALID");
    expect(reasonCodes(result)).toContain("REFERENCE_BEFORE_INVALID");
    expect(result.preparedIntent).toBeNull();
  });

  it("rejects a reference quote whose explicit timestamp was already stale when received", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceBefore: { quoteTimestamp: new Date(NOW - 76_000).toISOString() },
      }),
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumBatchDurationMs: 75_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.referenceBeforeValidityStatus).toBe("INVALID");
    expect(reasonCodes(result)).toContain("REFERENCE_BEFORE_INVALID");
    expect(result.preparedIntent).toBeNull();
  });

  it("rejects a candidate that is stale before unsigned preparation", async () => {
    let currentMs = NOW;
    const latencies = [0, 0, 21_000];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteTimestamp: null,
          expiresAt: null,
        }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 20_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.candidateFreshness?.status).toBe("STALE");
    expect(reasonCodes(result)).toContain("CANDIDATE_QUOTE_STALE");
    expect(result.preparedIntent).toBeNull();
  });

  it("rejects a slow but complete sandwich with SANDWICH_TOO_SLOW", async () => {
    let currentMs = NOW;
    const latencies = [20_000, 20_000, 36_000];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteTimestamp: null,
          expiresAt: null,
        }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumBatchDurationMs: 75_000, maximumQuoteAgeMs: 600_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("COMPLETE");
    expect(result.sandwichTemporalStatus).toBe("TOO_SLOW");
    expect(result.sandwichTemporalCoherence?.quoteBatchDurationMs).toBe(76_000);
    expect(reasonCodes(result)).toContain("SANDWICH_TOO_SLOW");
  });

  it("rejects unresolved reference cache evidence without using reference age", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceBefore: {
          quoteIdentifier: null,
          quoteTimestamp: null,
          expiresAt: null,
          blockNumber: null,
          responseFingerprint: "same-reference",
        },
        referenceAfter: {
          quoteIdentifier: null,
          quoteTimestamp: null,
          expiresAt: null,
          blockNumber: null,
          responseFingerprint: "same-reference",
        },
      }),
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.referenceFreshness?.possibleCacheDetected).toBe(true);
    expect(result.referenceFreshness?.confidence).toBe("low");
    expect(reasonCodes(result)).toContain("REFERENCE_CACHE_UNRESOLVED");
  });

  it("does not start a Piteas request below the minimum viable timeout", async () => {
    const timeouts: number[] = [];
    const quote = vi.fn(
      async (
        _cfg: AppConfig,
        req: { amount: string; account?: string },
        options?: { timeoutMs?: number },
      ) => {
        if (typeof options?.timeoutMs === "number") timeouts.push(options.timeoutMs);
        const call = quote.mock.calls.length - 1;
        const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({ label, amountInRaw: req.amount }),
        };
      },
    ) as never;
    const d = deps({ getPiteasQuote: quote });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 15_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("DEADLINE_INSUFFICIENT");
    expect(result.referenceAfter?.attempted).toBe(false);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(2);
    expect(timeouts.every((timeout) => timeout >= 8_000)).toBe(true);
  });

  it("binds the candidate quote as the exact quote used for preparation", async () => {
    const prepare = vi.fn((quote: PiteasQuoteData) => preparePiteasSwap(quote, { account: WALLET }));
    const d = deps({ preparePiteasSwap: prepare as never });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0].amountIn).toBe(AMOUNT_50_RAW);
    expect(result.exactAmountEvidence.candidateQuoteFingerprint).toBe("fingerprint-candidate");
    expect(result.preparedIntent?.calldata).toBe(prepare.mock.results[0]!.value.ok ? prepare.mock.results[0]!.value.intent.data : null);
  });

  it("registers as a read-only MCP tool with the requested schema", async () => {
    const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    const metas = new Map<string, { inputSchema?: { shape?: Record<string, unknown> } }>();
    const server = {
      registerTool: (name: string, meta: unknown, cb: unknown) => {
        metas.set(name, meta as { inputSchema?: { shape?: Record<string, unknown> } });
        handlers.set(name, cb as (args?: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>);
      },
    };
    registerPhiatShadowBuyTool(server as never, baseConfig, deps());

    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("walletAddress");
    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("approvedRouterCodeHashes");
    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("maximumBatchDurationMs");
    expect(metas.has("resetPiteasRateLimitForTests")).toBe(false);
    const response = await handlers.get("phiat_shadow_buy")!(baseInput());
    const body = JSON.parse(response.content[0]!.text) as { ok: boolean; data: { decision: string } };
    expect(body.ok).toBe(true);
    expect(body.data.decision).toBe("WOULD_BUY");
  });

  it("uses the process-wide rolling limiter and reserves the three-slot batch atomically", async () => {
    const d = deps({ reservePiteasRateLimitSlots });
    await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    const third = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(third.decision).toBe("REJECT");
    expect(reasonCodes(third)).toContain("RATE_LIMIT_REQUOTE_REQUIRED");
    expect(third.rateLimitBudget?.ok).toBe(false);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(6);
  });

  it("rejects before reserving rate-limit slots when the batch deadline cannot fit required reserves", async () => {
    const reserve = vi.fn();
    const d = deps({ reservePiteasRateLimitSlots: reserve as never });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumBatchDurationMs: 47_999 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("DEADLINE_INSUFFICIENT");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_BATCH_DEADLINE");
    expect(result.exactAmountEvidence.piteasRequestCountAttempted).toBe(0);
    expect(result.rateLimitBudget).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
    expect(d.getPiteasQuote).not.toHaveBeenCalled();
  });

  it("reserves concurrent three-slot batches atomically and rejects the third before any quote", async () => {
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length;
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: req.account ? "candidate" : `reference-${call}`,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteIdentifier: `quote-${call}`,
          responseFingerprint: `fingerprint-${call}`,
          blockNumber: String(123 + call),
        }),
      };
    }) as never;
    const d = deps({
      getPiteasQuote: quote,
      reservePiteasRateLimitSlots,
    });

    const results = await Promise.all([
      buildPhiatShadowBuy(baseConfig, baseInput(), d),
      buildPhiatShadowBuy(baseConfig, baseInput(), d),
      buildPhiatShadowBuy(baseConfig, baseInput(), d),
    ]);

    expect(results.filter((r) => r.decision === "WOULD_BUY")).toHaveLength(2);
    expect(results.filter((r) => reasonCodes(r).includes("RATE_LIMIT_REQUOTE_REQUIRED"))).toHaveLength(1);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(6);
    expect(getPiteasRateLimitBudget(NOW).remaining).toBe(2);
  });

  it("counts failed outbound quote attempts and restores capacity after the rolling window", async () => {
    const d = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: vi.fn(async () => ({ ok: false, reason: "piteas down" })) as never,
    });

    const failed = await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    expect(failed.decision).toBe("REJECT");
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
    expect(getPiteasRateLimitBudget(NOW).remaining).toBe(5);
    expect(getPiteasRateLimitBudget(NOW + 60_001).remaining).toBe(8);
  });

  it("keeps incomplete quote-batch semantics unavailable instead of exceeded or failed-not-run", async () => {
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      if (call === 0) {
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({
            label: "reference_before",
            amountInRaw: req.amount,
            outputRaw: REF_OUTPUT_RAW,
            minRaw: "99000000000000000000",
          }),
        };
      }
      return { ok: false, reason: call === 1 ? "candidate timeout" : "reference-after timeout" };
    }) as never;
    const d = deps({ getPiteasQuote: quote });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    const codes = reasonCodes(result);

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("CANDIDATE_FAILED");
    expect(codes).toContain("CANDIDATE_QUOTE_FAILED");
    expect(codes).toContain("REFERENCE_AFTER_FAILED");
    expect(codes).toContain("REFERENCE_DRIFT_UNAVAILABLE");
    expect(codes).toContain("CANDIDATE_DETERIORATION_UNAVAILABLE");
    expect(codes).not.toContain("REFERENCE_DRIFT_EXCEEDED");
    expect(codes).not.toContain("CANDIDATE_DETERIORATION_EXCEEDED");
    expect(result.allowanceStatus).toBe("NOT_EVALUATED");
    expect(result.approvalStatus).toBe("NOT_EVALUATED");
    expect(result.approvalIntent.status).toBe("NOT_EVALUATED");
    expect(result.routerIntegrityStatus).toBe("NOT_EVALUATED");
    expect(result.simulationStatus).toBe("NOT_RUN");
    expect(result.quoteFreshness?.freshnessAcceptable).toBe(false);
    expect(result.quoteFreshness?.freshnessConfidence).toBe("unavailable");
    expect(result.transactionPrepared).toBe(false);
  });

  it("calculates exact-amount deterioration and rejects excessive reference drift", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceAfter: { amountOut: "90000000000000000000", outputRaw: "90000000000000000000" } as never,
      }),
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.referenceDriftPercent).toBeGreaterThan(0.5);
    expect(result.policyChecks.reference_drift?.status).toBe("fail");
  });

  it("rejects stale candidate quotes", async () => {
    let currentMs = NOW;
    const d = deps({
      nowMs: () => currentMs,
      ethCall: vi.fn(async () => {
        currentMs += 21_000;
        return { data: "0x" };
      }) as never,
    });
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 20_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(reasonCodes(result)).toContain("CANDIDATE_QUOTE_STALE");
    expect(result.quoteFreshness?.candidateAgeAfterSimulationMs).toBeGreaterThan(5_000);
  });

  it("rejects candidate fingerprint changes between quote and preparation", async () => {
    const d = deps({
      preparePiteasSwap: vi.fn((quote: PiteasQuoteData) => {
        const prepared = preparePiteasSwap(quote, { account: WALLET });
        if (!prepared.ok) return prepared;
        const changed = swapCalldata({
          amountInRaw: AMOUNT_50_RAW,
          minOutputRaw: (BigInt(CANDIDATE_MIN_RAW) - 1n).toString(),
        });
        return {
          ...prepared,
          intent: { ...prepared.intent, data: changed },
          methodParameters: { ...prepared.methodParameters, calldata: changed },
        };
      }) as never,
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.candidate_quote_binding?.status).toBe("fail");
  });

  it("rejects insufficient eUSDC input balance", async () => {
    const d = deps({ getInputBalance: vi.fn(async () => "0") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_INPUT_BALANCE");
  });

  it("accepts exact input and gas-balance equality but rejects one-unit-short balances", async () => {
    const exactGasWei = "312500000000000";
    const exact = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getNativeBalanceWei: vi.fn(async () => exactGasWei) }),
    );
    expect(exact.decision).toBe("WOULD_BUY");
    expect(exact.balances.inputBalanceSufficient).toBe(true);
    expect(exact.balances.gasBalanceSufficient).toBe(true);

    const oneInputUnitShort = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getInputBalance: vi.fn(async () => (BigInt(AMOUNT_50_RAW) - 1n).toString()) }),
    );
    expect(oneInputUnitShort.decision).toBe("REJECT");
    expect(oneInputUnitShort.policyChecks.input_balance?.status).toBe("fail");

    const oneGasWeiShort = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getNativeBalanceWei: vi.fn(async () => (BigInt(exactGasWei) - 1n).toString()) }),
    );
    expect(oneGasWeiShort.decision).toBe("REJECT");
    expect(oneGasWeiShort.policyChecks.gas_balance?.status).toBe("fail");
  });

  it("rejects insufficient PLS gas balance after gas cost calculation", async () => {
    const d = deps({ getNativeBalanceWei: vi.fn(async () => "1") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_GAS_BALANCE");
    expect(result.gasPolicy.safetyAdjustedGasWei).toBeTruthy();
  });

  it("rejects malformed native balance evidence without throwing", async () => {
    const d = deps({ getNativeBalanceWei: vi.fn(async () => "not-a-number") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.balances.nativeBalancePls).toBeNull();
    expect(result.balances.errors).toContain("PLS balance unavailable: malformed balance value");
    expect(result.policyChecks.gas_balance?.status).toBe("fail");
  });

  it("returns NEEDS_APPROVAL with exact bounded approval and invalidates prior swap evidence", async () => {
    const d = deps({ getAllowance: vi.fn(async () => "0") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("NEEDS_APPROVAL");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_ALLOWANCE");
    expect(result.approvalIntent.status).toBe("APPROVAL_REQUIRED");
    expect(result.approvalIntent.amountRaw).toBe(AMOUNT_50_RAW);
    expect(result.approvalIntent.unlimitedApproval).toBe(false);
    expect(BigInt(result.approvalIntent.amountRaw!)).toBeLessThanOrEqual(BigInt(AMOUNT_50_RAW));
    expect(result.approvalIntent.token).toBe(PHIAT_SHADOW_BUY_TOKEN_IN);
    expect(result.approvalIntent.spender?.toLowerCase()).toBe(PITEAS_ROUTER.toLowerCase());
    expect(result.swapEvidenceInvalidAfterApproval).toBe(true);
    const decodedApproval = decodeShadowBuyCalldata(result.approvalIntent.calldata!);
    expect(decodedApproval.method).toBe("approve");
    expect(decodedApproval.approvalAmountRaw).toBe(AMOUNT_50_RAW);
    expect(decodedApproval.unlimitedApproval).toBe(false);
  });

  it("does not return NEEDS_APPROVAL when gas balance is insufficient", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      getNativeBalanceWei: vi.fn(async () => "1"),
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.allowance?.status).toBe("warning");
    expect(result.policyChecks.gas_balance?.status).toBe("fail");
    expect(result.approvalIntent.status).toBe("UNAVAILABLE");
  });

  it("does not prepare an approval intent for a wrong spender", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      preparePiteasSwap: vi.fn((quote: PiteasQuoteData): PiteasPrepareResult => {
        const prepared = preparePiteasSwap(quote, { account: WALLET });
        if (!prepared.ok) return prepared;
        return {
          ...prepared,
          intent: { ...prepared.intent, to: BAD_ROUTER },
          review: { ...prepared.review, router: BAD_ROUTER },
        };
      }) as never,
      getRouterIntegrity: routerIntegrity({
        router: BAD_ROUTER,
        routerMatchesAllowlist: false,
      }),
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.router_allowlist?.status).toBe("fail");
    expect(result.approvalIntent.status).toBe("UNAVAILABLE");
    expect(result.approvalIntent.transactionPrepared).toBe(false);
  });

  it("rejects calldata that attempts an unlimited approval instead of a swap", async () => {
    const unlimitedApproval = encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [PITEAS_ROUTER as `0x${string}`, (1n << 256n) - 1n],
    });
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: unlimitedApproval, value: "0" } },
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.decodedIntent?.method).toBe("approve");
    expect(result.decodedIntent?.unlimitedApproval).toBe(true);
    expect(result.policyChecks.no_hidden_approval?.status).toBe("fail");
  });

  it("rejects when direct approval simulation fails", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      ethCall: vi.fn(async () => {
        throw new Error("approval reverted");
      }) as never,
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.approval_simulation?.status).toBe("fail");
  });

  it("rejects when direct approval gas estimation fails", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      estimateGas: vi.fn(async () => {
        throw new Error("approval gas unavailable");
      }) as never,
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.approval_simulation?.status).toBe("fail");
    expect(result.approvalIntent.simulation?.estimateGasOk).toBe(false);
  });

  it("rejects wrong chain, wrong router, and empty router code", async () => {
    const wrongChain = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getPiteasQuote: defaultQuoteMock({ candidate: { chainId: 1 } }) }),
    );
    expect(wrongChain.policyChecks.chain_id?.status).toBe("fail");

    const wrongRouterDeps = deps({
      preparePiteasSwap: vi.fn((quote: PiteasQuoteData): PiteasPrepareResult => {
        const prepared = preparePiteasSwap(quote, { account: WALLET });
        if (!prepared.ok) return prepared;
        return {
          ...prepared,
          intent: { ...prepared.intent, to: BAD_ROUTER },
          review: { ...prepared.review, router: BAD_ROUTER },
        };
      }) as never,
      getRouterIntegrity: routerIntegrity({
        router: BAD_ROUTER,
        routerMatchesAllowlist: false,
      }),
    });
    const wrongRouter = await buildPhiatShadowBuy(baseConfig, baseInput(), wrongRouterDeps);
    expect(wrongRouter.policyChecks.transaction_to_router?.status).toBe("fail");
    expect(wrongRouter.policyChecks.router_allowlist?.status).toBe("fail");

    const emptyCode = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getRouterIntegrity: routerIntegrity({
          bytecodePresent: false,
          routerBytecodeHash: null,
          routerCodeHashApproved: null,
          codeHashAgreement: "unavailable",
        }),
      }),
    );
    expect(emptyCode.policyChecks.router_bytecode_present?.status).toBe("fail");
  });

  it("reports unapproved router hash without marking automatic execution eligible", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ approvedRouterCodeHashes: [] }),
      deps({
        getRouterIntegrity: routerIntegrity({
          routerBytecodeHash: UNAPPROVED_HASH,
          approvedRouterCodeHashes: [],
          routerCodeHashApproved: false,
        }),
      }),
    );

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.policyChecks.router_code_hash_approved?.status).toBe("warning");
    expect(result.automaticExecutionEligible).toBe(false);
  });

  it("rejects two-RPC router code-hash disagreement", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getRouterIntegrity: routerIntegrity({
          codeHashAgreement: "disagrees",
          rpcCodeHashes: [
            { rpcUrl: "a", ok: true, codeHash: APPROVED_HASH, bytecodeLength: 100, error: null },
            { rpcUrl: "b", ok: true, codeHash: UNAPPROVED_HASH, bytecodeLength: 100, error: null },
          ],
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.router_code_hash_agreement?.status).toBe("fail");
  });

  it("rejects decoded recipient, token, input amount, native value, and min-output mismatches", async () => {
    const wrongRecipient = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            methodParameters: { calldata: swapCalldata({ recipient: OTHER }), value: "0" },
          },
        }),
      }),
    );
    expect(wrongRecipient.policyChecks.decoded_recipient?.status).toBe("fail");

    const wrongToken = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            destToken: { address: OTHER, symbol: "OTHER", decimals: 18, chainId: 369 },
            tokenOutParam: OTHER,
            methodParameters: { calldata: swapCalldata({ tokenOut: OTHER }), value: "0" },
          },
        }),
      }),
    );
    expect(wrongToken.policyChecks.prepared_token_out?.status).toBe("fail");
    expect(wrongToken.policyChecks.decoded_token_out?.status).toBe("fail");

    const wrongAmount = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            methodParameters: { calldata: swapCalldata({ amountInRaw: "51000000" }), value: "0" },
          },
        }),
      }),
    );
    expect(wrongAmount.policyChecks.decoded_amount_in?.status).toBe("fail");

    const wrongValue = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { valueWei: "1", methodParameters: { calldata: swapCalldata(), value: "0x1" } },
        }),
      }),
    );
    expect(wrongValue.policyChecks.native_value?.status).toBe("fail");

    const wrongMin = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            amountOutMin: CANDIDATE_MIN_RAW,
            methodParameters: {
              calldata: swapCalldata({ minOutputRaw: (BigInt(CANDIDATE_MIN_RAW) - 1n).toString() }),
              value: "0",
            },
          },
        }),
      }),
    );
    expect(wrongMin.policyChecks.decoded_minimum_output?.status).toBe("fail");
  });

  it("rejects unknown selectors and unresolved execution targets", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: "0x12345678", value: "0" } },
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.calldata_decodable?.status).toBe("fail");
    expect(result.policyChecks.execution_targets_resolved?.status).toBe("fail");
    expect(result.executionTargets.unresolvedExecutionTargets.length).toBeGreaterThan(0);
  });

  it("rejects excessive slippage", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumSlippagePercent: 0.5 }),
      deps({ getPiteasQuote: defaultQuoteMock({ candidate: { allowedSlippage: 5 } }) }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.slippage_policy?.status).toBe("fail");
  });

  it("rejects eth_call reverts and estimateGas failure", async () => {
    const reverted = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        ethCall: vi.fn(async () => {
          throw new Error("execution reverted");
        }) as never,
      }),
    );
    expect(reverted.policyChecks.eth_call?.status).toBe("fail");

    const gasFailed = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        estimateGas: vi.fn(async () => {
          throw new Error("cannot estimate");
        }) as never,
      }),
    );
    expect(gasFailed.policyChecks.estimate_gas?.status).toBe("fail");
  });

  it("rejects exact candidate amounts over the operational threshold", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { amountOut: "900000000000000000000", outputRaw: "900000000000000000000" } as never,
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.candidateDeteriorationPercent).toBeGreaterThan(2.5);
    expect(result.policyChecks.candidate_deterioration?.status).toBe("fail");
  });

  it("does not include signing, execution, wallet-secret, submission, broadcast, or disk-write paths", () => {
    const shadowDir = join(process.cwd(), "src/tools/analytics/phiat-shadow-buy");
    const source = [
      readFileSync(join(process.cwd(), "src/data/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/data/piteasRateLimit.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/phiatShadowBuy.ts"), "utf8"),
      ...readdirSync(shadowDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(join(shadowDir, name), "utf8")),
    ].join("\n");
    expect(source).toMatch(/getPiteasQuote/);
    expect(source).toMatch(/preparePiteasSwap/);
    expect(source).not.toMatch(/piteas_prepare_swap/);
    expect(source).not.toMatch(/from\s+["'].*wallet/);
    expect(source).not.toMatch(/sign_and_send|execute_agent_tx/);
    expect(source).not.toMatch(/sendTransaction|signTransaction|sendRawTransaction|broadcastTransaction|submitTransaction|executeSwap/);
    expect(source).not.toMatch(/privateKey|PRIVATE_KEY|MASTER_KEY|SEED_PHRASE|MNEMONIC|AGENT_WALLET/);
    expect(source).not.toMatch(/writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream/);
  });
});
