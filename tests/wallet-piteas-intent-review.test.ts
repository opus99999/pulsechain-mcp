import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import {
  decodePiteasRouterSwapCalldata,
  EUSDC_TOKEN_ADDRESS,
  PHIAT_TOKEN_ADDRESS,
  PITEAS_ROUTER_SWAP_SELECTOR,
  VERIFIED_PITEAS_ROUTER,
  piteasRouterSwapAbi,
} from "../src/piteas/routerIntent.js";
import { inspectTokenNotional } from "../src/wallet/tokenNotional.js";
import {
  buildAgentIntentView,
  buildTxReviewSummary,
  formatConfirmPrompt,
} from "../src/wallet/reviewSummary.js";
import { evaluatePolicy } from "../src/wallet/policy.js";
import {
  createAgentWallet,
  executeAgentTx,
  proposeAgentTx,
  setTestBroadcast,
} from "../src/wallet/service.js";
import { loadProposal, saveProposal } from "../src/wallet/store.js";
import type { AppConfig } from "../src/types.js";
import * as rpc from "../src/data/rpc.js";
import { decodeShadowBuyCalldata } from "../src/tools/analytics/phiat-shadow-buy/calldataDecode.js";

const WALLET = "0x64443a931c6d6096c8de27711f2a525393c21133" as const;
const RAW_INPUT = 5_000_000n;
const MIN_OUTPUT = 12_345_678_900_000_000_000n;
const LIVE_ROUTE_FINGERPRINT =
  "0xa023d4ac360ab7c34f69039f4fba6be6de88b41744b1054ad58d614781682a77";

interface LivePiteasFixture {
  quote: {
    amountIn: string;
    amountOut: string;
    methodParameters: {
      calldata: Hex;
      value: string;
    };
    router: string;
  };
  fingerprints: {
    calldataSha256: string;
  };
  decodedTopLevel: {
    sourceToken: string;
    destinationToken: string;
    destinationAccount: string;
    sourceAmountRaw: string;
    destinationMinimumAmountRaw: string;
    routeDataFingerprint: string;
    routeDataByteLength: number;
    consumedBytes: number;
    trailingBytes: number;
    topLevelDecodeStatus: string;
  };
  contractAcceptance: {
    pinnedBlock: string;
    results: {
      rpc: string;
      ethCallPassed: boolean;
      returnedOutputRaw: string;
      estimateGasPassed: boolean;
      gasEstimate: string;
    }[];
  };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-piteas-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  setTestBroadcast(null);
  vi.restoreAllMocks();
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: randomBytes(32).toString("hex"),
    agentWalletDir: tempDir(),
    agentWalletMultiprocStrict: false,
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

function piteasSwapCalldata(routeData: Hex = "0x1234567890abcdef"): Hex {
  return encodeFunctionData({
    abi: piteasRouterSwapAbi,
    functionName: "swap",
    args: [
      {
        srcToken: EUSDC_TOKEN_ADDRESS,
        destToken: PHIAT_TOKEN_ADDRESS,
        destAccount: WALLET,
        srcAmount: RAW_INPUT,
        destMinAmount: MIN_OUTPUT,
      },
      routeData,
    ],
  });
}

function liveFixture(): LivePiteasFixture {
  return JSON.parse(
    readFileSync("tests/fixtures/piteas-live-router-calldata.json", "utf8"),
  ) as LivePiteasFixture;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function replaceBodyWord(data: Hex, index: number, value: string): Hex {
  const clean = value.replace(/^0x/i, "").padStart(64, "0");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`invalid test word ${value}`);
  }
  const body = data.slice(10);
  const start = index * 64;
  return `${data.slice(0, 10)}${body.slice(0, start)}${clean}${body.slice(
    start + 64,
  )}` as Hex;
}

function truncateBytes(data: Hex, bytes: number): Hex {
  return data.slice(0, data.length - bytes * 2) as Hex;
}

function enabledPolicy() {
  return {
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
  };
}

function mockRpcForProposal() {
  vi.spyOn(rpc, "getPublicClient").mockReturnValue({
    getBytecode: async () => "0x6000",
  } as never);
  vi.spyOn(rpc, "estimateGas").mockResolvedValue({ gasEstimate: "1520932" });
  vi.spyOn(rpc, "ethCall").mockResolvedValue({ data: "0x" });
  vi.spyOn(rpc, "getFeeData").mockResolvedValue({
    gasPriceWei: "100000000000000",
    maxFeePerGas: "100000000000000",
    maxPriorityFeePerGas: "1000000000",
  });
}

describe("shared PiteasRouter.swap decoder", () => {
  it("decodes the canonical selector, tuple, native value, route fingerprint, and address-first labels", () => {
    const data = piteasSwapCalldata();
    expect(data.slice(0, 10)).toBe(PITEAS_ROUTER_SWAP_SELECTOR);

    const decoded = decodePiteasRouterSwapCalldata({
      to: VERIFIED_PITEAS_ROUTER,
      data,
      valueWei: "0",
    });

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.intent.method).toBe("PiteasRouter.swap");
    expect(decoded.intent.routerAddress).toBe(VERIFIED_PITEAS_ROUTER.toLowerCase());
    expect(decoded.intent.sourceToken).toBe(EUSDC_TOKEN_ADDRESS.toLowerCase());
    expect(decoded.intent.destinationToken).toBe(PHIAT_TOKEN_ADDRESS.toLowerCase());
    expect(decoded.intent.destinationAccount).toBe(WALLET);
    expect(decoded.intent.sourceAmountRaw).toBe("5000000");
    expect(decoded.intent.destinationMinimumAmountRaw).toBe(MIN_OUTPUT.toString());
    expect(decoded.intent.nativeValueWei).toBe("0");
    expect(decoded.intent.routeDataFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(decoded.intent.routeDataByteLength).toBe(8);
    expect(decoded.intent.routeDataStatus).toBe("OPAQUE_MANAGER_SPECIFIC");
    expect(decoded.intent.routeTargets).toEqual([]);
    expect(decoded.intent.routeProtocols).toEqual([]);
    expect(decoded.intent.sourceTokenLabel).toContain(EUSDC_TOKEN_ADDRESS);
    expect(decoded.intent.destinationTokenLabel).toContain(PHIAT_TOKEN_ADDRESS);
    expect(decoded.intent.topLevelDecodeStatus).toBe("PASSED_CANONICAL");
    expect(decoded.intent.viemCrossCheckStatus).toBe("passed");
    expect(decoded.intent.contractAcceptanceStatus).toBe("not_checked_by_decoder");
    expect(decoded.intent.consumedBytes).toBe((data.length - 2) / 2);
    expect(decoded.intent.trailingBytes).toBe(0);
  });

  it("decodes the sanitized live Piteas calldata fixture that was not generated by viem", () => {
    const fixture = liveFixture();
    const data = fixture.quote.methodParameters.calldata;
    const accepted = fixture.contractAcceptance.results.filter(
      (r) =>
        r.ethCallPassed &&
        r.estimateGasPassed &&
        BigInt(r.returnedOutputRaw) > 0n &&
        BigInt(r.gasEstimate) > 0n,
    );
    expect(accepted).toHaveLength(2);
    expect(fixture.fingerprints.calldataSha256).toBe(
      "0xe3739c4868073b24e30eb294c058425095349d81eac6f04c3e7c3bcbe970e865",
    );

    const decoded = decodePiteasRouterSwapCalldata({
      to: fixture.quote.router,
      data,
      valueWei: "0",
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(decoded.intent.topLevelDecodeStatus).toBe("PASSED_CANONICAL");
    expect(decoded.intent.sourceToken).toBe(fixture.decodedTopLevel.sourceToken);
    expect(decoded.intent.destinationToken).toBe(fixture.decodedTopLevel.destinationToken);
    expect(decoded.intent.destinationAccount).toBe(fixture.decodedTopLevel.destinationAccount);
    expect(decoded.intent.sourceAmountRaw).toBe(fixture.decodedTopLevel.sourceAmountRaw);
    expect(decoded.intent.destinationMinimumAmountRaw).toBe(
      fixture.decodedTopLevel.destinationMinimumAmountRaw,
    );
    expect(decoded.intent.routeDataFingerprint).toBe(LIVE_ROUTE_FINGERPRINT);
    expect(decoded.intent.routeDataByteLength).toBe(1600);
    expect(decoded.intent.consumedBytes).toBe(1828);
    expect(decoded.intent.trailingBytes).toBe(0);
    expect(decoded.intent.routeTargets).toEqual([]);
    expect(decoded.intent.routeProtocols).toEqual([]);

    const inspection = inspectTokenNotional({
      to: fixture.quote.router,
      data,
      valueWei: "0",
    });
    const walletReview = buildAgentIntentView({
      to: fixture.quote.router,
      data,
      valueWei: "0",
      inspection,
    });
    const shadow = decodeShadowBuyCalldata(data, { nativeValueWei: "0" });

    expect(walletReview.decodeKnowledge.status).toBe(
      "known_top_level_with_opaque_route",
    );
    expect(walletReview.agentGuidance).toBe("review_carefully");
    expect(walletReview.piteas?.sourceToken).toBe(shadow.tokenIn);
    expect(walletReview.piteas?.destinationToken).toBe(shadow.tokenOut);
    expect(walletReview.piteas?.sourceAmountRaw).toBe(shadow.amountInRaw);
    expect(walletReview.piteas?.destinationMinimumAmountRaw).toBe(
      shadow.minimumOutputRaw,
    );
    expect(walletReview.piteas?.destinationAccount).toBe(shadow.recipient);
    expect(walletReview.piteas?.nativeValueWei).toBe(shadow.nativeValueWei);
    expect(walletReview.piteas?.routeDataFingerprint).toBe(shadow.routeDataFingerprint);
    expect(walletReview.piteas?.routeDataByteLength).toBe(1600);
    expect(walletReview.piteas?.routeDataStatus).toBe("OPAQUE_MANAGER_SPECIFIC");
    expect(walletReview.piteas?.routeTargets).toEqual([]);
    expect(shadow.nestedTargets).toEqual([]);
    expect(shadow.unresolvedTargets).toEqual([]);
    expect(JSON.stringify(walletReview.piteas)).not.toContain("routeDataRaw");
  });

  it("rejects malformed and ambiguous Piteas top-level calldata variants", () => {
    const live = liveFixture().quote.methodParameters.calldata;
    const word0 = live.slice(10, 74);
    const cases: {
      name: string;
      data: string;
      to?: string;
      kind?: string;
      status?: string;
    }[] = [
      {
        name: "selector mismatch",
        data: `0xdeadbeef${live.slice(10)}`,
        kind: "wrong_selector",
        status: "UNSUPPORTED",
      },
      {
        name: "wrong router",
        data: live,
        to: EUSDC_TOKEN_ADDRESS,
        kind: "wrong_router",
        status: "UNSUPPORTED",
      },
      {
        name: "truncated six-word head",
        data: `${PITEAS_ROUTER_SWAP_SELECTOR}${live.slice(10, 10 + 5 * 64)}`,
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "nonzero address padding",
        data: replaceBodyWord(live, 0, `1${word0.slice(1)}`),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "dynamic offset inside head",
        data: replaceBodyWord(live, 5, word(128n)),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "unaligned dynamic offset",
        data: replaceBodyWord(live, 5, word(193n)),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "missing dynamic length word",
        data: live.slice(0, 10 + 6 * 64),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "declared route length beyond calldata",
        data: replaceBodyWord(live, 6, word(1601n)),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "padded route end beyond calldata",
        data: truncateBytes(replaceBodyWord(live, 6, word(1599n)), 1),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "odd-length hex",
        data: `${live}f`,
        kind: "invalid_hex",
        status: "MALFORMED",
      },
      {
        name: "unsafe offset larger than Number.MAX_SAFE_INTEGER",
        data: replaceBodyWord(live, 5, word(BigInt(Number.MAX_SAFE_INTEGER) + 1n)),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
      {
        name: "zero-length route data",
        data: piteasSwapCalldata("0x"),
        kind: "empty_route_data",
        status: "MALFORMED",
      },
      {
        name: "trailing nonzero bytes",
        data: `${live}ff`,
        status: "LIBRARY_DECODER_DISAGREEMENT",
      },
      {
        name: "malformed live quote length remains rejected",
        data: replaceBodyWord(live, 6, word(2624n)),
        kind: "malformed_abi",
        status: "MALFORMED",
      },
    ];

    for (const c of cases) {
      const decoded = decodePiteasRouterSwapCalldata({
        to: c.to ?? VERIFIED_PITEAS_ROUTER,
        data: c.data,
        valueWei: "0",
      });
      expect(decoded.ok, c.name).toBe(false);
      if (decoded.ok) throw new Error(`${c.name} unexpectedly decoded`);
      if (c.kind) expect(decoded.kind, c.name).toBe(c.kind);
      if (c.status) expect(decoded.topLevelDecodeStatus, c.name).toBe(c.status);
    }
  });

  it("rejects malformed tuple calldata and wrong-router Piteas selectors", () => {
    const malformed = `${PITEAS_ROUTER_SWAP_SELECTOR}00` as Hex;
    const malformedDecoded = decodePiteasRouterSwapCalldata({
      to: VERIFIED_PITEAS_ROUTER,
      data: malformed,
      valueWei: "0",
    });
    expect(malformedDecoded.ok).toBe(false);
    expect(malformedDecoded.kind).toBe("malformed_abi");

    const wrongRouter = decodePiteasRouterSwapCalldata({
      to: EUSDC_TOKEN_ADDRESS,
      data: piteasSwapCalldata(),
      valueWei: "0",
    });
    expect(wrongRouter.ok).toBe(false);
    expect(wrongRouter.kind).toBe("wrong_router");
  });
});

describe("native wallet Piteas intent review", () => {
  it("inspect_tx_intent model reports known top-level Piteas intent with opaque route guidance", () => {
    const data = piteasSwapCalldata();
    const inspection = inspectTokenNotional({
      to: VERIFIED_PITEAS_ROUTER,
      data,
      valueWei: "0",
    });
    const intent = buildAgentIntentView({
      to: VERIFIED_PITEAS_ROUTER,
      data,
      valueWei: "0",
      inspection,
    });

    expect(inspection.pattern).toBe("piteas.swap");
    expect(intent.decodeKnowledge.status).toBe("known_top_level_with_opaque_route");
    expect(intent.agentGuidance).toBe("review_carefully");
    expect(intent.piteas?.method).toBe("PiteasRouter.swap");
    expect(intent.piteas?.sourceAmountRaw).toBe("5000000");
    expect(intent.piteas?.destinationMinimumAmountRaw).toBe(MIN_OUTPUT.toString());
    expect(intent.piteas?.destinationAccount).toBe(WALLET);
    expect(intent.piteas?.nativeValueWei).toBe("0");
    expect(intent.piteas?.routeDataStatus).toBe("OPAQUE_MANAGER_SPECIFIC");
    expect(intent.safetyHints.join(" ")).toMatch(/simulation|stale|manager-specific/i);
    expect(JSON.stringify(intent)).not.toMatch(/privateKey|masterKey|seed|mnemonic|ciphertext/i);
    expect(JSON.stringify(intent)).not.toContain("routeDataRaw");
  });

  it("malformed or misdirected Piteas calldata returns unknown/refuse", () => {
    const malformedInspection = inspectTokenNotional({
      to: VERIFIED_PITEAS_ROUTER,
      data: `${PITEAS_ROUTER_SWAP_SELECTOR}00`,
      valueWei: "0",
    });
    const malformed = buildAgentIntentView({
      to: VERIFIED_PITEAS_ROUTER,
      data: `${PITEAS_ROUTER_SWAP_SELECTOR}00`,
      valueWei: "0",
      inspection: malformedInspection,
    });
    expect(malformed.decodeKnowledge.status).toBe("unknown");
    expect(malformed.agentGuidance).toBe("refuse");

    const wrongRouterInspection = inspectTokenNotional({
      to: EUSDC_TOKEN_ADDRESS,
      data: piteasSwapCalldata(),
      valueWei: "0",
    });
    const wrongRouter = buildAgentIntentView({
      to: EUSDC_TOKEN_ADDRESS,
      data: piteasSwapCalldata(),
      valueWei: "0",
      inspection: wrongRouterInspection,
    });
    expect(wrongRouter.decodeKnowledge.status).toBe("unknown");
    expect(wrongRouter.agentGuidance).toBe("refuse");
  });

  it("proposal review displays decoded Piteas fields and no longer labels valid top-level intent unknown", () => {
    const data = piteasSwapCalldata();
    const check = evaluatePolicy({
      policy: enabledPolicy(),
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: VERIFIED_PITEAS_ROUTER,
      valueWei: "0",
      data,
      destinationIsContract: true,
    });
    const summary = buildTxReviewSummary({
      to: VERIFIED_PITEAS_ROUTER,
      valueWei: "0",
      valuePls: 0,
      data,
      policyCheck: check,
      simulation: { attempted: true, ok: true, gasEstimate: "1520932" },
      proposalId: "prop_mock",
      walletId: "aw_mock",
      proposalExpiresAt: "2099-01-01T00:00:00.000Z",
      context: "propose",
    });

    expect(summary.decodeKnowledge.status).toBe("known_top_level_with_opaque_route");
    expect(summary.decodeKnowledge.status).not.toBe("unknown");
    expect(summary.agentGuidance).toBe("review_carefully");
    expect(summary.destination).toBe(VERIFIED_PITEAS_ROUTER.toLowerCase());
    expect(summary.piteas?.method).toBe("PiteasRouter.swap");
    expect(summary.piteas?.sourceToken).toBe(EUSDC_TOKEN_ADDRESS.toLowerCase());
    expect(summary.piteas?.destinationToken).toBe(PHIAT_TOKEN_ADDRESS.toLowerCase());
    expect(summary.piteas?.sourceAmountRaw).toBe("5000000");
    expect(summary.piteas?.destinationMinimumAmountRaw).toBe(MIN_OUTPUT.toString());
    expect(summary.piteas?.destinationAccount).toBe(WALLET);
    expect(summary.piteas?.nativeValueWei).toBe("0");
    expect(summary.piteas?.routeDataFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(summary.piteas?.routeDataStatus).toBe("OPAQUE_MANAGER_SPECIFIC");
    expect(summary.piteas?.simulationStatus).toBe("passed");
    expect(summary.piteas?.proposalExpiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(summary.safetyHints.join(" ")).toMatch(/stale|simulation|manager/i);
    expect(formatConfirmPrompt(summary)).toMatch(/PiteasRouter\.swap|simulation=passed/i);
  });

  it("service proposal review carries Piteas expiration, while expired proposals and failed current simulation block execution", async () => {
    mockRpcForProposal();
    const cfg = testConfig();
    const wallet = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: wallet.id,
      to: VERIFIED_PITEAS_ROUTER,
      valuePls: 0,
      data: piteasSwapCalldata(),
    });

    expect(proposal.reviewSummary.piteas?.method).toBe("PiteasRouter.swap");
    expect(proposal.reviewSummary.proposalExpiresAt).toBe(proposal.expiresAt);
    expect(proposal.reviewSummary.piteas?.proposalExpiresAt).toBe(proposal.expiresAt);

    const expired = loadProposal(cfg.agentWalletDir, proposal.id);
    expired.expiresAt = "2000-01-01T00:00:00.000Z";
    saveProposal(cfg.agentWalletDir, expired);
    const expiredBroadcast = vi.fn(async () => "0x" + "11".repeat(32) as `0x${string}`);
    setTestBroadcast(expiredBroadcast);
    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(/expired/i);
    expect(expiredBroadcast).not.toHaveBeenCalled();

    const fresh = await proposeAgentTx(cfg, {
      walletId: wallet.id,
      to: VERIFIED_PITEAS_ROUTER,
      valuePls: 0,
      data: piteasSwapCalldata("0xabcdef"),
    });
    vi.mocked(rpc.ethCall).mockRejectedValue(new Error("Error(BalancerV2Error)"));
    const failedSimBroadcast = vi.fn(async () => "0x" + "22".repeat(32) as `0x${string}`);
    setTestBroadcast(failedSimBroadcast);
    await expect(executeAgentTx(cfg, fresh.id, true)).rejects.toThrow(
      /Pre-broadcast simulation failed|BalancerV2Error/i,
    );
    expect(failedSimBroadcast).not.toHaveBeenCalled();
  });

  it("shared decoder and review output do not expose wallet secret material", () => {
    const source = [
      "src/piteas/routerIntent.ts",
      "src/wallet/tokenNotional.ts",
      "src/tools/analytics/phiat-shadow-buy/calldataDecode.ts",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /privateKey|masterKey|seed phrase|mnemonic|encryptedKey|sendTransaction|sendRawTransaction|broadcast|execute_agent_tx|proposeAgentTx|createAgentWallet|saveProposal|loadWallet|walletDir|\.env\.wallet/i,
    );

    const data = piteasSwapCalldata();
    const inspection = inspectTokenNotional({ to: VERIFIED_PITEAS_ROUTER, data });
    const intent = buildAgentIntentView({
      to: VERIFIED_PITEAS_ROUTER,
      data,
      inspection,
    });
    expect(JSON.stringify(intent)).not.toMatch(
      /privateKey|masterKey|seed phrase|mnemonic|encryptedKey|ciphertext/i,
    );
  });
});
