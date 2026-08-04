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
const TOKEN_IMPL_HASH =
  "0x57a73a555fee21aa544bcd2feeba6033020677d82977701a78e89b7da0f45b08";
const UNPROVEN_DELEGATE = "0x2d14e7701ce7d5558eb02f1919ec431a76fb2cad";
const SMART_ROUTER = "0xf6076d61a0c46c944852f65838e1b12a2910a717";
const SMART_ROUTER_HASH =
  "0x8675933f176bbd98e4af9cc8015ca7fbdaf003dfd67782a2b26167f559d6c0fd";
const SMART_ROUTER_HELPER = "0x2d14e7701ce7d5558eb02f1919ec431a76fb2cad";
const SMART_ROUTER_HELPER_HASH =
  "0x99dbcfd8791473ebe1f2127aa162bea456a0e88db9bf211872f90a0b1ac14830";
const STABLE_POOL = "0xe3acfa6c40d53c3faf2aa62d0a715c737071511c";
const STABLE_POOL_HASH =
  "0x9bc8ce0d268e55bf55b6fe84d2453a8fcf13a6874671a2e68172e3a937886427";
const LIBERTY_FACTORY = "0x796fcbdc956b85797efe21145aa97599b7fb36a6";
const LIBERTY_FACTORY_HASH =
  "0x06980a00918587c043af9085626962ebb94f9d0482e0028ff9a9f233d34cebd3";
const PHUX_ROUTER = "0x48e8100374ae6ff2cc8871db6224b296718eeb0d";
const PHUX_ROUTER_HASH =
  "0x61d40f5d698419b552d51f9f49abebaefd199a88f29e97eeeb66a7871f742830";
const WPLS = "0xa1077a294dde1b09bb078844df40758a5d0f9a27";
const PULSEX_V1_ROUTER = "0x98bf93ebf5c380c0e6ae8e192a7e2ae08edacc02";
const PULSEX_V1_FACTORY = "0x1715a3e4a142d8b698131108995174f37aeba10d";
const V2_POOL = "0x6753560538eca67617a9ce605178f788be7e524e";
const DIRECT_TOKEN = "0x6b175474e89094c44da98b954eedeac495271d0f";
const CST_TOKEN = "0xc10a4ed9b4042222d69ff0b374eddd47ed90fc1f";
const UNKNOWN = "0x4444444444444444444444444444444444444444";
const UNKNOWN_LIVE = "0x5555555555555555555555555555555555555555";

const PINNED_V3_POOLS = [
  {
    address: "0x55b432ad0518a4285ded6bb4d15e9a7182ef7a4d",
    protocol: "PancakeSwap V3",
    factoryAddress: "0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68",
    factoryCodeHash: "0x7c7dc7bf84221881cc7961d92b890d2d93036ae0f34c8e6177ff6e5ee6a43971",
    token0: DIRECT_TOKEN,
    token1: WPLS,
    fee: 10000,
    tickSpacing: 200,
    runtimeCodeHash: "0xffe7ac163e0f3a464d1daa934c8bf207d82f15e490fe934c49acd723d0e68c3d",
    caller: SMART_ROUTER,
  },
  {
    address: "0x096af49f24293318661cbbf749a1e3f93ce1fbb2",
    protocol: "LibertySwap V3",
    factoryAddress: LIBERTY_FACTORY,
    factoryCodeHash: LIBERTY_FACTORY_HASH,
    token0: DIRECT_TOKEN,
    token1: WPLS,
    fee: 2500,
    tickSpacing: 50,
    runtimeCodeHash: "0xdeeee829f4a6fb924b2fc02ed05a8c9a6d8ae5499fdf3d9c5610f23205798428",
    caller: PHUX_ROUTER,
  },
  {
    address: "0x13500f3449e337464eb8b5897dc2b06fe3fa692a",
    protocol: "LibertySwap V3",
    factoryAddress: LIBERTY_FACTORY,
    factoryCodeHash: LIBERTY_FACTORY_HASH,
    token0: TOKEN_PROXY,
    token1: CST_TOKEN,
    fee: 2500,
    tickSpacing: 50,
    runtimeCodeHash: "0x7273abcac81c217f2e33b60c4a027061b924468867ede48439b4e5ae0248d1d4",
    caller: PHUX_ROUTER,
  },
  {
    address: "0x475e1f945427cc02bfb2d76f111c5541413505c0",
    protocol: "LibertySwap V3",
    factoryAddress: LIBERTY_FACTORY,
    factoryCodeHash: LIBERTY_FACTORY_HASH,
    token0: DIRECT_TOKEN,
    token1: CST_TOKEN,
    fee: 10000,
    tickSpacing: 200,
    runtimeCodeHash: "0x8a896473a92f65d2052908acfb345d341b3d0bc8a538e6c013126e5c8df6da76",
    caller: PHUX_ROUTER,
  },
  {
    address: "0x042ff2668957c7ad7d8b42232af59f339803cd10",
    protocol: "LibertySwap V3",
    factoryAddress: LIBERTY_FACTORY,
    factoryCodeHash: LIBERTY_FACTORY_HASH,
    token0: DIRECT_TOKEN,
    token1: CST_TOKEN,
    fee: 2500,
    tickSpacing: 50,
    runtimeCodeHash: "0xf8f050e61b62eac593fc98d326cf91759d1cb32c30b476e1c2685ac2b4b11330",
    caller: PHUX_ROUTER,
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

const CODE = {
  router: "0x6001600055",
  manager: "0x6002600055",
  proxy: "0x60006000f4600055",
  tokenImpl: "0x6003600055",
  unprovenDelegate: "0x6004600055",
  smartRouter: "0x600a600055",
  smartRouterHelper: "0x600b600055",
  stablePool: "0x600c600055",
  libertyFactory: "0x600d600055",
  phuxRouter: "0x600e600055",
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
    runtimeEvidence(TOKEN_IMPL, CODE.tokenImpl, TOKEN_IMPL_HASH),
    runtimeEvidence(UNPROVEN_DELEGATE, CODE.unprovenDelegate, SMART_ROUTER_HELPER_HASH),
    runtimeEvidence(SMART_ROUTER, CODE.smartRouter, SMART_ROUTER_HASH),
    runtimeEvidence(STABLE_POOL, CODE.stablePool, STABLE_POOL_HASH),
    runtimeEvidence(LIBERTY_FACTORY, CODE.libertyFactory, LIBERTY_FACTORY_HASH),
    runtimeEvidence(PHUX_ROUTER, CODE.phuxRouter, PHUX_ROUTER_HASH),
    ...PINNED_V3_POOLS.map((pool) => runtimeEvidence(pool.address, CODE.pool, pool.runtimeCodeHash)),
    runtimeEvidence(WPLS, CODE.erc20),
    runtimeEvidence(PULSEX_V1_ROUTER, CODE.protocolRouter),
    runtimeEvidence(PULSEX_V1_FACTORY, CODE.factory),
    runtimeEvidence(V2_POOL, CODE.pool),
    runtimeEvidence(DIRECT_TOKEN, CODE.erc20),
    runtimeEvidence(CST_TOKEN, CODE.erc20),
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

function pinnedPoolEvidence(
  pool: (typeof PINNED_V3_POOLS)[number],
  overrides: Partial<PoolProvenanceEvidence> = {},
): PoolProvenanceEvidence {
  return {
    protocol: pool.protocol,
    poolType: "V3_POOL",
    factoryAddress: pool.factoryAddress,
    factoryCodeHash: pool.factoryCodeHash,
    token0: pool.token0,
    token1: pool.token1,
    assets: [pool.token0, pool.token1],
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    factoryVerified: true,
    selectorAppropriate: true,
    evidence: {
      address: pool.address,
      factoryLookup: pool.address,
      poolCreatedEvent: true,
    },
    unresolvedReasons: [],
    ...overrides,
  };
}

function pinnedPoolMap(
  overrides: Record<string, Partial<PoolProvenanceEvidence>> = {},
): Map<string, PoolProvenanceEvidence> {
  return new Map([
    ...poolMap().entries(),
    ...PINNED_V3_POOLS.map((pool) => [
      pool.address,
      pinnedPoolEvidence(pool, overrides[pool.address] ?? {}),
    ] as const),
  ]);
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
  return withTraceCallers(root);
}

function fullyClassifiedTraceFixture(): TraceNode {
  return withTraceCallers({
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
  });
}

function arbitraryDelegateTrace(): TraceNode {
  return withTraceCallers({
    type: "CALL",
    from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
    to: MANAGER,
    input: `${PITEAS_SWAP_MANAGER_SELECTOR}${"00".repeat(32)}`,
    value: "0x0",
    calls: [call(TOKEN_IMPL, ERC20_TRANSFER_SELECTOR, [], "DELEGATECALL")],
  });
}

function runtimeClosureTraceFixture(): TraceNode {
  const managerChildren: TraceNode[] = [
    call(SMART_ROUTER, "0x04e45aaf", [
      call(SMART_ROUTER_HELPER, "0x4e6c8ed8", [], "DELEGATECALL"),
      call(PINNED_V3_POOLS[0].address, "0x128acb08", [
        call(DIRECT_TOKEN, ERC20_TRANSFER_SELECTOR),
        call(SMART_ROUTER, "0x23a69e75", [
          call(SMART_ROUTER_HELPER, "0x8bdb1925", [], "DELEGATECALL"),
          call(WPLS, ERC20_TRANSFER_FROM_SELECTOR),
        ]),
      ]),
    ]),
    call(STABLE_POOL, "0x5b41b908"),
    ...PINNED_V3_POOLS.slice(1).map((pool) =>
      call(PHUX_ROUTER, "0x414bf389", [
        call(pool.address, "0x128acb08", [
          call(LIBERTY_FACTORY, "0x07200e33", [], "STATICCALL"),
          call(pool.token0, ERC20_TRANSFER_SELECTOR),
          call(pool.token1, ERC20_TRANSFER_SELECTOR),
        ]),
      ]),
    ),
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
      call(TOKEN_PROXY, ERC20_TRANSFER_FROM_SELECTOR, [
        call(TOKEN_IMPL, ERC20_TRANSFER_FROM_SELECTOR, [], "DELEGATECALL"),
      ]),
      call(MANAGER, PITEAS_SWAP_MANAGER_SELECTOR, managerChildren),
      call(DIRECT_TOKEN, ERC20_TRANSFER_SELECTOR),
    ],
  };
  while (countTrace(root) < 154) {
    managerChildren.push(call(DIRECT_TOKEN, ERC20_BALANCE_OF_SELECTOR, [], "STATICCALL"));
  }
  return withTraceCallers(root);
}

function countTrace(root: TraceNode): number {
  return 1 + (root.calls ?? []).reduce((sum, child) => sum + countTrace(child), 0);
}

function withTraceCallers(root: TraceNode): TraceNode {
  const walk = (node: TraceNode) => {
    for (const child of node.calls ?? []) {
      if (node.to) child.from = node.to;
      walk(child);
    }
  };
  walk(root);
  return root;
}

function classifiedCalls(
  root = historicalTraceFixture(),
  pools = poolMap(),
  codes = codeMap(),
  sources = sourceMap(),
): NormalizedExecutionCall[] {
  return classifyCalls({
    calls: normalizeExecutionTrace({
      root,
      runtimeCodeByAddress: codes,
      blockNumber: HISTORICAL_BLOCK,
    }),
    codeByAddress: codes,
    sourceByAddress: sources,
    poolByAddress: pools,
  });
}

function recordsFor(calls = classifiedCalls(), pools = poolMap(), codes = codeMap()) {
  return buildTrustRecordCandidates({
    calls,
    codeByAddress: codes,
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

    expect(implementation?.classification).toBe("UNKNOWN_CONTRACT");
    expect(implementation?.parentRole).not.toBe("TOKEN_PROXY");
    expect(implementation?.unresolvedReasons).toContain(
      "delegatecall_target_unresolved",
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

  it("closes the 154-call Piteas runtime evidence fixture without operator approval", async () => {
    const report = await buildExecutionTrustReport({
      config: baseConfig,
      historicalTransactionHash: HISTORICAL_TX,
      pinnedBlock: HISTORICAL_BLOCK,
      traceRoot: runtimeClosureTraceFixture(),
      provider: provider(pinnedPoolMap()),
    });

    expect(report.callCount).toBe(154);
    expect(report.graphPolicy.classifiedCallCount).toBe(154);
    expect(report.graphPolicy.unresolvedCallCount).toBe(0);
    expect(report.graphPolicy.unresolvedStateChangingCallCount).toBe(0);
    expect(report.graphPolicy.unresolvedDelegatecallCount).toBe(0);
    expect(report.graphPolicy.unknownSelectorCount).toBe(0);
    expect(report.graphPolicy.prohibitedOperationCount).toBe(0);
    expect(report.trustClosureStatus).toBe("COMPLETE");
    expect(report.routeTrustBundle.unresolvedRecords).toEqual([]);
    expect(report.candidateRecords.every((record) => record.operatorApproved === false)).toBe(true);
    expect(report.runtimeResolutionEvidence.map((evidence) => evidence.normalizedAddress)).toEqual(
      expect.arrayContaining([
        SMART_ROUTER,
        SMART_ROUTER_HELPER,
        STABLE_POOL,
        LIBERTY_FACTORY,
        ...PINNED_V3_POOLS.map((pool) => pool.address),
      ]),
    );
  });

  it("classifies SmartRouterHelper only with exact hash, parent, call type, and selector", () => {
    const exact = classifiedCalls(runtimeClosureTraceFixture(), pinnedPoolMap());
    const helper = exact.find((row) => row.to === SMART_ROUTER_HELPER && row.selector === "0x4e6c8ed8");
    expect(helper).toMatchObject({
      classification: "PROTOCOL_LIBRARY",
      classificationEvidenceMode: "PINNED_AUDITED_EVIDENCE",
      unresolvedReasons: [],
    });

    const wrongParent = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: MANAGER,
      input: `${PITEAS_SWAP_MANAGER_SELECTOR}${"00".repeat(32)}`,
      calls: [call(UNKNOWN, "0xabcdef01", [call(SMART_ROUTER_HELPER, "0x4e6c8ed8", [], "DELEGATECALL")])],
    }));
    expect(wrongParent.find((row) => row.to === SMART_ROUTER_HELPER)?.unresolvedReasons).toContain(
      "delegatecall_target_0x2d14_role_not_proven",
    );

    const wrongSelector = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: MANAGER,
      input: `${PITEAS_SWAP_MANAGER_SELECTOR}${"00".repeat(32)}`,
      calls: [call(SMART_ROUTER, "0x04e45aaf", [call(SMART_ROUTER_HELPER, "0xdeadbeef", [], "DELEGATECALL")])],
    }));
    expect(wrongSelector.find((row) => row.to === SMART_ROUTER_HELPER)?.classification).toBe("UNKNOWN_CONTRACT");

    const callInstead = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: MANAGER,
      input: `${PITEAS_SWAP_MANAGER_SELECTOR}${"00".repeat(32)}`,
      calls: [call(SMART_ROUTER, "0x04e45aaf", [call(SMART_ROUTER_HELPER, "0x4e6c8ed8")])],
    }));
    expect(callInstead.find((row) => row.to === SMART_ROUTER_HELPER)?.classification).toBe("UNKNOWN_CONTRACT");

    const badCodes = new Map(codeMap());
    badCodes.set(SMART_ROUTER_HELPER, runtimeEvidence(SMART_ROUTER_HELPER, CODE.smartRouterHelper, codeHash(CODE.smartRouterHelper)));
    const wrongHash = classifiedCalls(runtimeClosureTraceFixture(), pinnedPoolMap(), badCodes);
    expect(wrongHash.find((row) => row.to === SMART_ROUTER_HELPER)?.classification).toBe("UNKNOWN_CONTRACT");
  });

  it("classifies SmartRouter calls only with exact route and callback context", () => {
    const exact = classifiedCalls(runtimeClosureTraceFixture(), pinnedPoolMap());
    expect(exact.find((row) => row.to === SMART_ROUTER && row.selector === "0x04e45aaf")?.classification).toBe(
      "PROTOCOL_ROUTER",
    );
    expect(exact.find((row) => row.to === SMART_ROUTER && row.selector === "0x23a69e75")?.classification).toBe(
      "PROTOCOL_ROUTER",
    );

    const wrongPoolCallback = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: UNKNOWN,
      input: `0x128acb08${"00".repeat(32)}`,
      calls: [call(SMART_ROUTER, "0x23a69e75")],
    }), pinnedPoolMap());
    expect(wrongPoolCallback.find((row) => row.to === SMART_ROUTER)?.classification).toBe("UNKNOWN_CONTRACT");

    const badCodes = new Map(codeMap());
    badCodes.set(SMART_ROUTER_HELPER, runtimeEvidence(SMART_ROUTER_HELPER, CODE.smartRouterHelper, codeHash(CODE.smartRouterHelper)));
    const helperMismatch = classifiedCalls(runtimeClosureTraceFixture(), pinnedPoolMap(), badCodes);
    expect(helperMismatch.find((row) => row.to === SMART_ROUTER && row.selector === "0x04e45aaf")?.classification).toBe(
      "UNKNOWN_CONTRACT",
    );
  });

  it("classifies stable-pool and Liberty factory evidence only for exact selector and caller context", () => {
    const exact = classifiedCalls(runtimeClosureTraceFixture(), pinnedPoolMap());
    expect(exact.find((row) => row.to === STABLE_POOL)?.classification).toBe("STABLE_POOL");
    expect(exact.find((row) => row.to === LIBERTY_FACTORY)?.classification).toBe("PROTOCOL_FACTORY");

    const wrongStableSelector = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: MANAGER,
      input: `${PITEAS_SWAP_MANAGER_SELECTOR}${"00".repeat(32)}`,
      calls: [call(STABLE_POOL, "0xdeadbeef")],
    }));
    expect(wrongStableSelector.find((row) => row.to === STABLE_POOL)?.classification).toBe("UNKNOWN_CONTRACT");

    const wrongFactoryCallType = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: PINNED_V3_POOLS[1].address,
      input: `0x128acb08${"00".repeat(32)}`,
      calls: [call(LIBERTY_FACTORY, "0x07200e33")],
    }), pinnedPoolMap());
    expect(wrongFactoryCallType.find((row) => row.to === LIBERTY_FACTORY)?.classification).toBe("UNKNOWN_CONTRACT");
  });

  it("requires exact V3 pool provenance and rejects factory, token, fee, tick, hash, and caller mismatches", () => {
    for (const pool of PINNED_V3_POOLS) {
      const calls = classifiedCalls(withTraceCallers({
        type: "CALL",
        from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
        to: pool.caller,
        input: `0x414bf389${"00".repeat(32)}`,
        calls: [call(pool.address, "0x128acb08")],
      }), pinnedPoolMap());
      expect(calls.find((row) => row.to === pool.address)?.classification).toBe("V3_POOL");
    }

    const pool = PINNED_V3_POOLS[1];
    const rejects = [
      { factoryAddress: UNKNOWN },
      { token0: WPLS },
      { fee: pool.fee + 1 },
      { tickSpacing: pool.tickSpacing + 1 },
      { factoryVerified: false, unresolvedReasons: ["factory_did_not_confirm_pool"] },
    ];
    for (const override of rejects) {
      const calls = classifiedCalls(withTraceCallers({
        type: "CALL",
        from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
        to: pool.caller,
        input: `0x414bf389${"00".repeat(32)}`,
        calls: [call(pool.address, "0x128acb08")],
      }), pinnedPoolMap({ [pool.address]: override }));
      const record = recordsFor(calls, pinnedPoolMap({ [pool.address]: override })).find((row) => row.normalizedAddress === pool.address);
      expect(record?.confidence).toBe("unresolved");
    }

    const badCodes = new Map(codeMap());
    badCodes.set(pool.address, runtimeEvidence(pool.address, CODE.pool, codeHash(CODE.pool)));
    const wrongHash = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: pool.caller,
      input: `0x414bf389${"00".repeat(32)}`,
      calls: [call(pool.address, "0x128acb08")],
    }), pinnedPoolMap(), badCodes);
    expect(wrongHash.find((row) => row.to === pool.address)?.unresolvedReasons).toContain(
      "pinned_v3_pool_provenance_unresolved",
    );

    const wrongCaller = classifiedCalls(withTraceCallers({
      type: "CALL",
      from: "0x579ecfc5b9e9dc3cf71e4067f199e7146848e68f",
      to: UNKNOWN,
      input: `0x414bf389${"00".repeat(32)}`,
      calls: [call(pool.address, "0x128acb08")],
    }), pinnedPoolMap());
    expect(wrongCaller.find((row) => row.to === pool.address)?.unresolvedReasons).toContain(
      "pinned_v3_pool_provenance_unresolved",
    );
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
