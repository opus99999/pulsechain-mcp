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

const WALLET = "0x64443a931c6d6096c8de27711f2a525393c21133" as const;
const RAW_INPUT = 5_000_000n;
const MIN_OUTPUT = 12_345_678_900_000_000_000n;

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
    const source = readFileSync("src/piteas/routerIntent.ts", "utf8");
    expect(source).not.toMatch(
      /privateKey|masterKey|seed phrase|mnemonic|encryptedKey|sendTransaction|sendRawTransaction|broadcast|execute_agent_tx/i,
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
