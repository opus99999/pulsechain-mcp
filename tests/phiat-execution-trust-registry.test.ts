import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/types.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import {
  buildExecutionTrustReport,
  buildGraphFingerprint,
  buildRouteTrustBundleCandidate,
  buildTrustRecordCandidates,
  classifyCalls,
  compareLiveTraceAgainstTrustBundle,
  evaluateHistoricalGraphPolicy,
  normalizeExecutionTrace,
  registerPhiatExecutionTrustReportTool,
  type EvidenceProvider,
  type NormalizedExecutionCall,
  type OperatorReviewedExecutionTrustRecordCandidate,
  type OperatorReviewedRouteTrustBundleCandidate,
  type PoolProvenanceEvidence,
  type RuntimeCodeEvidence,
  type SourceLookupEvidence,
  type TraceNode,
} from "../src/tools/analytics/phiatShadowBuy.js";
import {
  ERC20_ALLOWANCE_SELECTOR,
  ERC20_BALANCE_OF_SELECTOR,
  ERC20_TRANSFER_FROM_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  PITEAS_ROUTER,
  PITEAS_SWAP_MANAGER_SELECTOR,
} from "../src/tools/analytics/phiat-shadow-buy/constants.js";

const HISTORICAL_TX =
  "0x1a0d519d0b1ae9e0f759d2a068fa720c3759d5f057b611f91c726ef8db570a56";
const HISTORICAL_BLOCK = "27195532";
const MANAGER = "0x58ab37d02696a481e2e5b5779967f3f4d237baa9";
const MANAGER_HASH =
  "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb";
const ROUTER_HASH =
  "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b";
const TOKEN_PROXY = "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07";
const TOKEN_IMPL = "0x539a69de74e9ed69fbe7f909fa935d05b8caba11";
const UNPROVEN_DELEGATE = "0x2d14e7701ce7d5558eb02f1919ec431a76fb2cad";
const WPLS = "0xa1077a294dde1b09bb078844df40758a5d0f9a27";
const PULSEX_V1_ROUTER = "0x98bf93ebf5c380c0e6ae8e192a7e2ae08edacc02";
const PULSEX_V1_FACTORY = "0x1715a3e4a142d8b698131108995174f37aeba10d";
const V2_POOL = "0x6753560538eca67617a9ce605178f788be7e524e";
const DIRECT_TOKEN = "0x6b175474e89094c44da98b954eedeac495271d0f";
const UNKNOWN = "0x4444444444444444444444444444444444444444";
const UNKNOWN_LIVE = "0x5555555555555555555555555555555555555555";

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

const CODE = {
  router: "0x6001600055",
  manager: "0x6002600055",
  proxy: "0x60006000f4600055",
  tokenImpl: "0x6003600055",
  unprovenDelegate: "0x6004600055",
  erc20: "0x6005600055",
  protocolRouter: "0x6006600055",
  factory: "0x6007600055",
  pool: "0x6008600055",
  unknown: "0x6009600055",
};

function codeHash(code: string): string {
  return keccak256(code as `0x${string}`);
}

function runtimeEvidence(address: string, code: string, hash = codeHash(code)): RuntimeCodeEvidence {
  return {
    address,
    normalizedAddress: address.toLowerCase(),
    blockNumber: HISTORICAL_BLOCK,
    runtimeCodeHash: hash,
    codeHashAgreement: "agrees",
    rpcSamples: [
      {
        rpcUrl: "https://rpc-a.example",
        ok: true,
        runtimeCodeHash: hash,
        bytecodeLength: (code.length - 2) / 2,
        error: null,
      },
      {
        rpcUrl: "https://rpc-b.example",
        ok: true,
        runtimeCodeHash: hash,
        bytecodeLength: (code.length - 2) / 2,
        error: null,
      },
    ],
    bytecodeLength: (code.length - 2) / 2,
    bytecode: code,
  };
}

function codeMap(): Map<string, RuntimeCodeEvidence> {
  const entries = [
    runtimeEvidence(PITEAS_ROUTER.toLowerCase(), CODE.router, ROUTER_HASH),
    runtimeEvidence(MANAGER, CODE.manager, MANAGER_HASH),
    runtimeEvidence(TOKEN_PROXY, CODE.proxy),
    runtimeEvidence(TOKEN_IMPL, CODE.tokenImpl),
    runtimeEvidence(UNPROVEN_DELEGATE, CODE.unprovenDelegate),
    runtimeEvidence(WPLS, CODE.erc20),
    runtimeEvidence(PULSEX_V1_ROUTER, CODE.protocolRouter),
    runtimeEvidence(PULSEX_V1_FACTORY, CODE.factory),
    runtimeEvidence(V2_POOL, CODE.pool),
    runtimeEvidence(DIRECT_TOKEN, CODE.erc20),
    runtimeEvidence(UNKNOWN, CODE.unknown),
  ];
  return new Map(entries.map((entry) => [entry.normalizedAddress, entry]));
}

function sourceMap(): Map<string, SourceLookupEvidence> {
  const source = (address: string, contractName: string | null): SourceLookupEvidence => ({
    address: address.toLowerCase(),
    verified: contractName !== null,
    contractName,
    abiSelectors: [],
    sourceFingerprint: contractName ? codeHash(`0x${Buffer.from(contractName).toString("hex")}`) : null,
    error: null,
  });
  return new Map([
    [TOKEN_PROXY, source(TOKEN_PROXY, "TokenProxy")],
    [TOKEN_IMPL, source(TOKEN_IMPL, "TokenImplementation")],
    [UNPROVEN_DELEGATE, source(UNPROVEN_DELEGATE, null)],
  ]);
}

function poolEvidence(factoryVerified = true): PoolProvenanceEvidence {
  return {
    protocol: "PulseX V1 Factory",
    poolType: "V2_POOL",
    factoryAddress: PULSEX_V1_FACTORY,
    factoryCodeHash: codeHash(CODE.factory),
    token0: TOKEN_PROXY,
    token1: WPLS,
    assets: [TOKEN_PROXY, WPLS],
    factoryVerified,
    selectorAppropriate: true,
    evidence: {
      address: V2_POOL,
      factoryGetPair: factoryVerified ? V2_POOL : UNKNOWN,
    },
    unresolvedReasons: factoryVerified ? [] : ["factory_did_not_confirm_pool"],
  };
}

function poolMap(factoryVerified = true): Map<string, PoolProvenanceEvidence> {
  return new Map([[V2_POOL, poolEvidence(factoryVerified)]]);
}

function call(to: string, selector: string, calls: TraceNode[] = [], type = "CALL"): TraceNode {
  return {
    type,
    from: "0x9999999999999999999999999999999999999999",
    to,
    input: `${selector}${"00".repeat(32)}`,
    output: "0x",
    value: "0x0",
    gasUsed: "0x100",
    calls,
  };
}

function historicalTraceFixture(): TraceNode {
  const managerChildren: TraceNode[] = [
    call(TOKEN_PROXY, ERC20_ALLOWANCE_SELECTOR, [call(TOKEN_IMPL, ERC20_ALLOWANCE_SELECTOR, [], "DELEGATECALL")], "STATICCALL"),
    call(PULSEX_V1_ROUTER, "0x38ed1739", [
      call(V2_POOL, "0x0902f1ac", [], "STATICCALL"),
      call(V2_POOL, "0x022c0d9f"),
      call(TOKEN_PROXY, ERC20_TRANSFER_FROM_SELECTOR, [call(TOKEN_IMPL, ERC20_TRANSFER_FROM_SELECTOR, [], "DELEGATECALL")]),
    ]),
    call(UNKNOWN, "0xabcdef01", [call(UNPROVEN_DELEGATE, ERC20_TRANSFER_SELECTOR, [], "DELEGATECALL")]),
  ];
  const root: TraceNode = {
    type: "CALL",
    from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
    to: PITEAS_ROUTER,
    input: `0x8218b58f${"00".repeat(32)}`,
    output: "0x",
    value: "0x0",
    gasUsed: "0x1",
    calls: [
      call(DIRECT_TOKEN, ERC20_BALANCE_OF_SELECTOR, [], "STATICCALL"),
      call(TOKEN_PROXY, ERC20_TRANSFER_FROM_SELECTOR, [
        call(TOKEN_IMPL, ERC20_TRANSFER_FROM_SELECTOR, [], "DELEGATECALL"),
      ]),
      call(MANAGER, PITEAS_SWAP_MANAGER_SELECTOR, managerChildren),
      call(DIRECT_TOKEN, ERC20_BALANCE_OF_SELECTOR, [], "STATICCALL"),
      call(DIRECT_TOKEN, ERC20_TRANSFER_SELECTOR),
    ],
  };
  while (countTrace(root) < 154) {
    managerChildren.push(call(DIRECT_TOKEN, ERC20_BALANCE_OF_SELECTOR, [], "STATICCALL"));
  }
  return root;
}

function fullyClassifiedTraceFixture(): TraceNode {
  return {
    type: "CALL",
    from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
    to: PITEAS_ROUTER,
    input: `0x8218b58f${"00".repeat(32)}`,
    value: "0x0",
    calls: [
      call(TOKEN_PROXY, ERC20_TRANSFER_FROM_SELECTOR, [
        call(TOKEN_IMPL, ERC20_TRANSFER_FROM_SELECTOR, [], "DELEGATECALL"),
      ]),
      call(MANAGER, PITEAS_SWAP_MANAGER_SELECTOR, [
        call(PULSEX_V1_ROUTER, "0x38ed1739", [
          call(V2_POOL, "0x0902f1ac", [], "STATICCALL"),
          call(V2_POOL, "0x022c0d9f"),
        ]),
      ]),
    ],
  };
}

function arbitraryDelegateTrace(): TraceNode {
  return {
    type: "CALL",
    from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
    to: MANAGER,
    input: `${PITEAS_SWAP_MANAGER_SELECTOR}${"00".repeat(32)}`,
    value: "0x0",
    calls: [call(TOKEN_IMPL, ERC20_TRANSFER_SELECTOR, [], "DELEGATECALL")],
  };
}

function countTrace(root: TraceNode): number {
  return 1 + (root.calls ?? []).reduce((sum, child) => sum + countTrace(child), 0);
}

function classifiedCalls(
  root = historicalTraceFixture(),
  pools = poolMap(),
): NormalizedExecutionCall[] {
  return classifyCalls({
    calls: normalizeExecutionTrace({
      root,
      runtimeCodeByAddress: codeMap(),
      blockNumber: HISTORICAL_BLOCK,
    }),
    codeByAddress: codeMap(),
    sourceByAddress: sourceMap(),
    poolByAddress: pools,
  });
}

function recordsFor(calls = classifiedCalls(), pools = poolMap()) {
  return buildTrustRecordCandidates({
    calls,
    codeByAddress: codeMap(),
    sourceByAddress: sourceMap(),
    poolByAddress: pools,
    managerCodeHash: MANAGER_HASH,
  });
}

function provider(pools = poolMap()): EvidenceProvider {
  return {
    getRuntimeCode: async (address) =>
      codeMap().get(address.toLowerCase()) ?? runtimeEvidence(address, CODE.unknown),
    getSource: async (address) =>
      sourceMap().get(address.toLowerCase()) ?? {
        address: address.toLowerCase(),
        verified: false,
        contractName: null,
        abiSelectors: [],
        sourceFingerprint: null,
        error: null,
      },
    verifyPool: async (address) =>
      pools.get(address.toLowerCase()) ?? {
        protocol: null,
        poolType: null,
        factoryAddress: null,
        factoryCodeHash: null,
        token0: null,
        token1: null,
        assets: [],
        factoryVerified: false,
        selectorAppropriate: false,
        evidence: { address },
        unresolvedReasons: ["pool_not_verified"],
      },
  };
}

describe("Piteas execution trust registry", () => {
  it("normalizes the exact 154-call historical graph shape with stable parent paths", () => {
    const root = historicalTraceFixture();
    expect(countTrace(root)).toBe(154);
    const normalized = normalizeExecutionTrace({
      root,
      runtimeCodeByAddress: codeMap(),
      blockNumber: HISTORICAL_BLOCK,
    });

    expect(normalized).toHaveLength(154);
    expect(normalized[0]).toMatchObject({
      tracePath: "0",
      depth: 0,
      to: PITEAS_ROUTER.toLowerCase(),
      selector: "0x8218b58f",
      blockNumber: HISTORICAL_BLOCK,
    });
    expect(normalized.find((row) => row.tracePath === "0.1.0")).toMatchObject({
      depth: 2,
      callType: "DELEGATECALL",
      to: TOKEN_IMPL,
      parentAddress: TOKEN_PROXY,
      selector: ERC20_TRANSFER_FROM_SELECTOR,
    });
  });

  it("classifies router, manager, TokenProxy implementation, and keeps 0x2d14 unresolved", () => {
    const calls = classifiedCalls();
    const router = calls.find((row) => row.tracePath === "0");
    const manager = calls.find((row) => row.to === MANAGER);
    const tokenProxy = calls.find((row) => row.to === TOKEN_PROXY && row.tracePath === "0.1");
    const implementation = calls.find((row) => row.to === TOKEN_IMPL && row.tracePath === "0.1.0");
    const unproven = calls.find((row) => row.to === UNPROVEN_DELEGATE);

    expect(router?.classification).toBe("PITEAS_ROUTER");
    expect(manager?.classification).toBe("PITEAS_SWAP_MANAGER");
    expect(tokenProxy?.classification).toBe("TOKEN_PROXY");
    expect(implementation).toMatchObject({
      classification: "TOKEN_IMPLEMENTATION",
      parentRole: "TOKEN_PROXY",
    });
    expect(unproven?.classification).toBe("UNKNOWN_CONTRACT");
    expect(unproven?.unresolvedReasons).toContain("delegatecall_target_0x2d14_role_not_proven");
  });

  it("rejects the 0x539a implementation in an arbitrary delegatecall context", () => {
    const calls = classifiedCalls(arbitraryDelegateTrace());
    const implementation = calls.find((row) => row.to === TOKEN_IMPL);

    expect(implementation?.classification).toBe("TOKEN_IMPLEMENTATION");
    expect(implementation?.parentRole).not.toBe("TOKEN_PROXY");
    expect(implementation?.unresolvedReasons).toContain(
      "token_implementation_without_token_proxy_parent",
    );
  });

  it("builds candidate records with code-hash agreement, proxy binding, and operatorApproved false", () => {
    const records = recordsFor();
    const router = records.find((record) => record.role === "PITEAS_ROUTER");
    const manager = records.find((record) => record.role === "PITEAS_SWAP_MANAGER");
    const implementation = records.find((record) => record.normalizedAddress === TOKEN_IMPL);

    expect(router?.runtimeCodeHash).toBe(ROUTER_HASH);
    expect(manager?.runtimeCodeHash).toBe(MANAGER_HASH);
    expect(implementation).toMatchObject({
      role: "TOKEN_IMPLEMENTATION",
      proxyType: "TRACE_BOUND_TOKEN_PROXY",
      implementationAddress: TOKEN_IMPL,
      confidence: "high",
      operatorApproved: false,
    });
    expect(records.every((record) => record.operatorApproved === false)).toBe(true);
  });

  it("verifies pool factory provenance and rejects a wrong factory", () => {
    const goodRecords = recordsFor();
    const goodPool = goodRecords.find((record) => record.normalizedAddress === V2_POOL);
    expect(goodPool).toMatchObject({
      role: "V2_POOL",
      factoryAddress: PULSEX_V1_FACTORY,
      factoryCodeHash: codeHash(CODE.factory),
      tokenConstraints: {
        token0: TOKEN_PROXY,
        token1: WPLS,
        assets: [TOKEN_PROXY, WPLS],
      },
      confidence: "high",
    });

    const badPools = poolMap(false);
    const badRecords = recordsFor(classifiedCalls(historicalTraceFixture(), badPools), badPools);
    const badPool = badRecords.find((record) => record.normalizedAddress === V2_POOL);
    expect(badPool?.unresolvedReasons).toContain("factory_did_not_confirm_pool");
    expect(badPool?.confidence).toBe("unresolved");
  });

  it("keeps graph and bundle fingerprints stable and invalidates router or manager code changes", () => {
    const calls = classifiedCalls();
    const records = recordsFor(calls);
    const graphFingerprint = buildGraphFingerprint(calls);
    expect(buildGraphFingerprint(classifiedCalls())).toBe(graphFingerprint);
    const bundle = buildRouteTrustBundleCandidate({
      historicalTransaction: HISTORICAL_TX,
      historicalBlock: HISTORICAL_BLOCK,
      records,
      prohibitedOperations: [],
      graphFingerprint,
    });
    expect(bundle.graphFingerprint).toBe(graphFingerprint);
    expect(bundle.bundleFingerprint).toMatch(/^0x[a-f0-9]{64}$/);

    expect(
      compareLiveTraceAgainstTrustBundle({
        bundle,
        calls,
        routerAddress: PITEAS_ROUTER,
        routerCodeHash: `0x${"aa".repeat(32)}`,
        swapManagerAddress: MANAGER,
        swapManagerCodeHash: MANAGER_HASH,
      }).failureCodes,
    ).toContain("ROUTER_CODE_HASH_CHANGED");
    expect(
      compareLiveTraceAgainstTrustBundle({
        bundle,
        calls,
        routerAddress: PITEAS_ROUTER,
        routerCodeHash: ROUTER_HASH,
        swapManagerAddress: MANAGER,
        swapManagerCodeHash: `0x${"bb".repeat(32)}`,
      }).failureCodes,
    ).toContain("MANAGER_CODE_HASH_CHANGED");
  });

  it("rejects selector mismatch, unexpected live edge, and unknown state-changing targets", () => {
    const calls = classifiedCalls();
    const candidateRecords = recordsFor(calls);
    const records: OperatorReviewedExecutionTrustRecordCandidate[] = candidateRecords.map((record) => ({
      ...record,
      operatorApproved: true,
      approvedSelectors: record.observedSelectors,
    }));
    const bundle: OperatorReviewedRouteTrustBundleCandidate = {
      ...buildRouteTrustBundleCandidate({
        historicalTransaction: HISTORICAL_TX,
        historicalBlock: HISTORICAL_BLOCK,
        records: candidateRecords,
        prohibitedOperations: [],
        graphFingerprint: buildGraphFingerprint(calls),
      }),
      operatorApproved: true,
      requiredRecords: records,
      optionalRecords: [],
      unresolvedRecords: [],
    };
    const selectorMismatch = calls.map((call) =>
      call.to === V2_POOL && call.selector === "0x022c0d9f"
        ? { ...call, selector: "0xdeadbeef" }
        : call,
    );
    const exactPreview = compareLiveTraceAgainstTrustBundle({
      bundle,
      calls,
      routerAddress: PITEAS_ROUTER,
      routerCodeHash: ROUTER_HASH,
      swapManagerAddress: MANAGER,
      swapManagerCodeHash: MANAGER_HASH,
      requireOperatorApproval: false,
    });
    expect(exactPreview.failureCodes).toContain("SIGNED_TRUST_MANIFEST_REQUIRED");
    expect(exactPreview.automaticExecutionEligible).toBe(false);

    expect(
      compareLiveTraceAgainstTrustBundle({
        bundle,
        calls: selectorMismatch,
        routerAddress: PITEAS_ROUTER,
        routerCodeHash: ROUTER_HASH,
        swapManagerAddress: MANAGER,
        swapManagerCodeHash: MANAGER_HASH,
        requireOperatorApproval: false,
      }).failureCodes,
    ).toEqual(expect.arrayContaining([`SELECTOR_NOT_APPROVED:${V2_POOL}:0xdeadbeef`]));

    const unexpectedEdge = calls.map((call) =>
      call.to === V2_POOL && call.selector === "0x022c0d9f"
        ? { ...call, from: UNKNOWN }
        : call,
    );
    expect(
      compareLiveTraceAgainstTrustBundle({
        bundle,
        calls: unexpectedEdge,
        routerAddress: PITEAS_ROUTER,
        routerCodeHash: ROUTER_HASH,
        swapManagerAddress: MANAGER,
        swapManagerCodeHash: MANAGER_HASH,
        requireOperatorApproval: false,
      }).failureCodes.some((code) => code.startsWith("UNEXPECTED_CALL_EDGE")),
    ).toBe(true);

    const unknownTarget = [
      ...calls,
      {
        ...calls[0]!,
        tracePath: "0.x",
        from: MANAGER,
        to: UNKNOWN_LIVE,
        selector: "0xabcdef01",
        callType: "CALL",
        classification: "UNKNOWN_CONTRACT" as const,
      },
    ];
    expect(
      compareLiveTraceAgainstTrustBundle({
        bundle,
        calls: unknownTarget,
        routerAddress: PITEAS_ROUTER,
        routerCodeHash: ROUTER_HASH,
        swapManagerAddress: MANAGER,
        swapManagerCodeHash: MANAGER_HASH,
        requireOperatorApproval: false,
      }).failureCodes,
    ).toContain(`UNAPPROVED_STATE_CHANGING_TARGET:${UNKNOWN_LIVE}`);
  });

  it("can fully classify a historical graph while automatic execution remains disabled", () => {
    const calls = classifiedCalls(fullyClassifiedTraceFixture());
    const records = recordsFor(calls);
    const policy = evaluateHistoricalGraphPolicy(calls, records);

    expect(policy.graphStatus).toBe("FULLY_CLASSIFIED");
    expect(policy.unresolvedCallCount).toBe(0);
    expect(policy.automaticExecutionEligible).toBe(false);
  });

  it("builds the read-only report payload with candidate records and a rejecting live comparison preview", async () => {
    const report = await buildExecutionTrustReport({
      config: baseConfig,
      historicalTransactionHash: HISTORICAL_TX,
      pinnedBlock: HISTORICAL_BLOCK,
      traceRoot: historicalTraceFixture(),
      provider: provider(),
    });

    expect(report.callCount).toBe(154);
    expect(report.routeTrustBundle.operatorApproved).toBe(false);
    expect(report.routeTrustBundle.routerCodeHash).toBe(ROUTER_HASH);
    expect(report.routeTrustBundle.swapManagerCodeHash).toBe(MANAGER_HASH);
    expect(report.liveComparisonPreview.status).toBe("REJECTED");
    expect(report.liveComparisonPreview.failureCodes).toContain("BUNDLE_NOT_OPERATOR_APPROVED");
    expect(report.delegatecallTargets.find((target) => target.normalizedAddress === TOKEN_IMPL)?.classification).toBe(
      "TOKEN_IMPLEMENTATION",
    );
    expect(report.delegatecallTargets.find((target) => target.normalizedAddress === UNPROVEN_DELEGATE)?.unresolvedReasons).toContain(
      "delegatecall_target_0x2d14_role_not_proven",
    );
  });

  it("registers phiat_execution_trust_report as analytics write=false", async () => {
    const metas = new Map<string, { write?: boolean; category?: string; inputSchema?: { shape?: Record<string, unknown> } }>();
    const server = {
      registerTool(name: string, meta: { inputSchema?: { shape?: Record<string, unknown> } }) {
        metas.set(name, { ...meta });
      },
    };
    resetToolRegistry();
    registerPhiatExecutionTrustReportTool(server as never, baseConfig);
    expect(metas.has("phiat_execution_trust_report")).toBe(true);
    const meta = getRegisteredTools().find((tool) => tool.name === "phiat_execution_trust_report");
    expect(meta).toMatchObject({ category: "analytics", write: false });
  });

  it("contains no signing, submission, broadcast, execution, secret-reading, or disk-write path", () => {
    const registrySource = readFileSync(
      join(process.cwd(), "src/tools/analytics/phiat-shadow-buy/executionTrustRegistry.ts"),
      "utf8",
    );
    const moduleSource = [
      registrySource,
      readFileSync(join(process.cwd(), "src/tools/analytics/phiat-shadow-buy/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/index.ts"), "utf8"),
      ...readdirSync(join(process.cwd(), "src/tools/analytics/phiat-shadow-buy"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) =>
          readFileSync(join(process.cwd(), "src/tools/analytics/phiat-shadow-buy", name), "utf8"),
        ),
    ].join("\n");

    expect(registrySource).toMatch(/registerTool/);
    expect(moduleSource).not.toMatch(/sendTransaction|signTransaction|sendRawTransaction|broadcastTransaction|submitTransaction|executeSwap/);
    expect(moduleSource).not.toMatch(/privateKey|PRIVATE_KEY|MASTER_KEY|SEED_PHRASE|MNEMONIC/);
    expect(registrySource).not.toMatch(/writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream/);
  });
});
