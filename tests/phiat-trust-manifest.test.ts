import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import {
  PITEAS_ROUTER,
  PITEAS_SWAP_MANAGER_SELECTOR,
  buildTrustManifestCandidateFromReport,
  canonicalizeJson,
  compareLiveExecutionGraphToApprovedManifest,
  manifestFingerprint,
  publicKeyIdFromSpkiDerBase64,
  registerPhiatTrustManifestTools,
  signedManifestPayload,
  TRUST_MANIFEST_SIGNATURE_ALGORITHM,
  verifySignedTrustManifest,
  type LiveChainStateForManifest,
  type LiveExecutionGraphCall,
  type SignedTrustManifest,
  type TrustManifest,
  type TrustManifestEdge,
  type TrustManifestRecord,
} from "../src/tools/analytics/phiatShadowBuy.js";
import type { ExecutionTrustReport } from "../src/tools/analytics/phiat-shadow-buy/executionTrustRegistry.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const HISTORICAL_TX = "0x1a0d519d0b1ae9e0f759d2a068fa720c3759d5f057b611f91c726ef8db570a56";
const HISTORICAL_BLOCK = "27195532";
const GRAPH_FINGERPRINT = "0xce502a0183e96397d87830058d9f5435561d3d83d5f862aa89a0fb697eb3e4a0";
const BUNDLE_FINGERPRINT = "0x31d3699d69625f370d73e9a04e62d636070d9b0019104efe77359202ab00a819";
const ROUTER_HASH = "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b";
const MANAGER = "0x58ab37d02696a481e2e5b5779967f3f4d237baa9";
const MANAGER_HASH = "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb";
const TARGET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TARGET_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SMART_ROUTER = "0xf6076d61a0c46c944852f65838e1b12a2910a717";
const SMART_ROUTER_HELPER = "0x2d14e7701ce7d5558eb02f1919ec431a76fb2cad";
const HELPER_HASH = "0x99dbcfd8791473ebe1f2127aa162bea456a0e88db9bf211872f90a0b1ac14830";
const TOKEN_PROXY = "0x3333333333333333333333333333333333333333";
const TOKEN_IMPL = "0x539a69de74e9ed69fbe7f909fa935d05b8caba11";
const TOKEN_IMPL_HASH = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const POOL = "0x4444444444444444444444444444444444444444";
const POOL_HASH = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const FACTORY = "0x5555555555555555555555555555555555555555";
const TOKEN0 = "0x6666666666666666666666666666666666666666";
const TOKEN1 = "0x7777777777777777777777777777777777777777";
const FACTORY_HASH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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

function keyMaterial() {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiDerBase64 = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const publicKeyId = publicKeyIdFromSpkiDerBase64(publicKeySpkiDerBase64);
  return { ...pair, publicKeySpkiDerBase64, publicKeyId };
}

function signManifest(manifest: TrustManifest, key = keyMaterial()): SignedTrustManifest {
  const manifestForSigning = { ...manifest, operatorPublicKeyId: key.publicKeyId };
  return {
    manifest: manifestForSigning,
    manifestFingerprint: manifestFingerprint(manifestForSigning),
    signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    operatorPublicKeyId: key.publicKeyId,
    signature: signPayload(null, signedManifestPayload(manifestForSigning), key.privateKey).toString("base64"),
  };
}

function protocolRecord(overrides: Partial<TrustManifestRecord> = {}): TrustManifestRecord {
  return {
    address: TARGET,
    role: "PROTOCOL_ROUTER",
    runtimeCodeHash: TARGET_HASH,
    implementationAddress: null,
    implementationCodeHash: null,
    approvedSelectors: ["0xabcdef01"],
    allowedCallTypes: ["CALL"],
    parentConstraints: [{ parentAddress: MANAGER, parentRole: "PITEAS_SWAP_MANAGER" }],
    callerConstraints: [{ caller: MANAGER, selector: "0xabcdef01", callType: "CALL" }],
    factoryConstraints: null,
    tokenConstraints: null,
    managerHashConstraint: MANAGER_HASH,
    routerHashConstraint: ROUTER_HASH,
    delegatecallContext: null,
    firstApprovedBlock: HISTORICAL_BLOCK,
    expiresAtBlock: "27195600",
    residualRisks: [],
    ...overrides,
  };
}

function contextRecord(
  address: string,
  role: TrustManifestRecord["role"],
  runtimeCodeHash: string,
): TrustManifestRecord {
  return {
    address,
    role,
    runtimeCodeHash,
    implementationAddress: null,
    implementationCodeHash: null,
    approvedSelectors: [],
    allowedCallTypes: ["CALL"],
    parentConstraints: [],
    callerConstraints: [],
    factoryConstraints: null,
    tokenConstraints: null,
    managerHashConstraint: MANAGER_HASH,
    routerHashConstraint: ROUTER_HASH,
    delegatecallContext: null,
    firstApprovedBlock: HISTORICAL_BLOCK,
    expiresAtBlock: "27195600",
    residualRisks: [],
  };
}

function managerRecord(): TrustManifestRecord {
  return contextRecord(MANAGER, "PITEAS_SWAP_MANAGER", MANAGER_HASH);
}

function trustManifest(args: {
  records?: TrustManifestRecord[];
  allowedEdges?: TrustManifestEdge[];
  chainId?: number;
  routerAddress?: string;
  routerHash?: string;
  managerAddress?: string;
  managerHash?: string;
  expiresAt?: string | null;
  expiresAtBlock?: string | null;
} = {}): TrustManifest {
  const records = args.records ?? [managerRecord(), protocolRecord()];
  const allowedEdges = args.allowedEdges ?? [protocolEdge()];
  return {
    version: "phiat-execution-trust-v1",
    manifestId: "0x9999999999999999999999999999999999999999999999999999999999999999",
    chainId: args.chainId ?? 369,
    historicalTransaction: HISTORICAL_TX,
    historicalBlock: HISTORICAL_BLOCK,
    graphFingerprint: GRAPH_FINGERPRINT,
    bundleFingerprint: BUNDLE_FINGERPRINT,
    router: {
      address: args.routerAddress ?? PITEAS_ROUTER.toLowerCase(),
      runtimeCodeHash: args.routerHash ?? ROUTER_HASH,
    },
    swapManager: {
      address: args.managerAddress ?? MANAGER,
      runtimeCodeHash: args.managerHash ?? MANAGER_HASH,
      storageSlot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      storageOffsetBytes: 0,
      storageWidthBytes: 20,
      managerChangeEventBlock: null,
    },
    records,
    allowedEdges,
    prohibitedOperations: ["CREATE", "CREATE2", "SELFDESTRUCT", "CALLCODE"],
    approvalPolicy: {
      unexpectedTarget: "REJECT",
      unexpectedSelector: "REJECT",
      unexpectedEdge: "REJECT",
      codeHashChange: "REJECT",
      managerChange: "REJECT",
      routerChange: "REJECT",
      expiredManifest: "REJECT",
    },
    approvedAt: "2026-08-03T00:00:00.000Z",
    approvedAtBlock: "27195533",
    expiresAt: args.expiresAt ?? "2026-08-04T00:00:00.000Z",
    expiresAtBlock: args.expiresAtBlock ?? "27195600",
    operatorPublicKeyId: "operator-key-id-required",
  };
}

function protocolEdge(overrides: Partial<TrustManifestEdge> = {}): TrustManifestEdge {
  return {
    fromRole: "PITEAS_SWAP_MANAGER",
    fromAddress: MANAGER,
    toRole: "PROTOCOL_ROUTER",
    toAddress: TARGET,
    callType: "CALL",
    selector: "0xabcdef01",
    ...overrides,
  };
}

function verified(manifest = trustManifest()) {
  const key = keyMaterial();
  const signed = signManifest(manifest, key);
  return verifySignedTrustManifest(signed, {
    pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
    nowMs: NOW,
    currentBlock: "27195533",
  });
}

function liveCall(overrides: Partial<LiveExecutionGraphCall> = {}): LiveExecutionGraphCall {
  return {
    from: MANAGER,
    to: TARGET,
    callType: "CALL",
    selector: "0xabcdef01",
    codeHash: TARGET_HASH,
    parentAddress: MANAGER,
    ...overrides,
  };
}

function liveState(overrides: Partial<LiveChainStateForManifest> = {}): LiveChainStateForManifest {
  return {
    chainId: 369,
    router: { address: PITEAS_ROUTER.toLowerCase(), runtimeCodeHash: ROUTER_HASH },
    swapManager: {
      address: MANAGER,
      runtimeCodeHash: MANAGER_HASH,
      storageSlot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      storageAddress: MANAGER,
      managerChangeEventBlock: null,
    },
    currentBlock: "27195533",
    currentTime: "2026-08-03T00:00:00.000Z",
    targetCodeHashes: { [TARGET]: TARGET_HASH },
    implementationRelationships: [],
    poolStates: {},
    ...overrides,
  };
}

describe("signed PHIAT execution trust manifests", () => {
  it("canonicalizes object keys deterministically and fingerprints semantic changes", () => {
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    const manifest = trustManifest();
    const reordered = Object.fromEntries(Object.entries(manifest).reverse()) as TrustManifest;
    expect(manifestFingerprint(reordered)).toBe(manifestFingerprint(manifest));
    expect(manifestFingerprint({ ...manifest, chainId: 943 })).not.toBe(manifestFingerprint(manifest));
  });

  it("verifies valid Ed25519 signatures and rejects invalid signatures or keys", () => {
    const key = keyMaterial();
    const signed = signManifest(trustManifest(), key);
    const valid = verifySignedTrustManifest(signed, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(valid.signatureValid).toBe(true);
    expect(valid.executionAuthority).toBe("VALID");

    const fingerprintMismatch = verifySignedTrustManifest({
      ...signed,
      manifestFingerprint: `0x${"00".repeat(32)}`,
    }, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(fingerprintMismatch.validationErrors).toContain("MANIFEST_FINGERPRINT_MISMATCH");
    expect(fingerprintMismatch.executionAuthority).toBe("INVALID");

    const expectedKeyMismatch = verifySignedTrustManifest(signed, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      expectedOperatorPublicKeyId: "different-operator-key",
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(expectedKeyMismatch.validationErrors).toContain("OPERATOR_PUBLIC_KEY_ID_MISMATCH");
    expect(expectedKeyMismatch.executionAuthority).toBe("INVALID");

    const invalidSignature = verifySignedTrustManifest({ ...signed, signature: "AA==" }, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(invalidSignature.signatureValid).toBe(false);
    expect(invalidSignature.executionAuthority).toBe("INVALID");

    const wrongKey = keyMaterial();
    const wrongPublicKey = verifySignedTrustManifest(signed, {
      pinnedPublicKeys: { [key.publicKeyId]: wrongKey.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(wrongPublicKey.signatureValid).toBe(false);
    expect(wrongPublicKey.executionAuthority).toBe("INVALID");
  });

  it("rejects wrong chain, router, manager, and expired manifests", () => {
    const key = keyMaterial();
    for (const manifest of [
      trustManifest({ chainId: 943 }),
      trustManifest({ routerHash: OTHER_HASH }),
      trustManifest({ managerHash: OTHER_HASH }),
    ]) {
      const signed = signManifest(manifest, key);
      const result = verifySignedTrustManifest(signed, {
        pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
        nowMs: NOW,
        currentBlock: "27195533",
      });
      expect(result.signatureValid).toBe(true);
      expect(result.executionAuthority).toBe("STATE_MISMATCH");
    }

    const expiredByTime = verifySignedTrustManifest(signManifest(trustManifest({
      expiresAt: "2026-08-02T00:00:00.000Z",
      expiresAtBlock: null,
    }), key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(expiredByTime.executionAuthority).toBe("EXPIRED");

    const expiredByBlock = verifySignedTrustManifest(signManifest(trustManifest({
      expiresAt: null,
      expiresAtBlock: "27195532",
    }), key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(expiredByBlock.executionAuthority).toBe("EXPIRED");
  });

  it("rejects code-hash, target, selector, edge, call-type, parent, caller, and prohibited-operation mismatches", () => {
    const approved = verified();
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall()], approved, liveState()).automaticExecutionEligible).toBe(true);

    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ codeHash: OTHER_HASH })], approved, liveState()).failureCodes).toContain("CODE_HASH_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ to: OTHER })], approved, liveState()).failureCodes).toContain("UNEXPECTED_TARGET");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ selector: "0xdeadbeef" })], approved, liveState()).failureCodes).toContain("UNEXPECTED_SELECTOR");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ from: OTHER })], approved, liveState()).failureCodes).toContain("UNEXPECTED_EDGE");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ callType: "DELEGATECALL" })], approved, liveState()).failureCodes).toContain("CALL_TYPE_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ parentAddress: OTHER })], approved, liveState()).failureCodes).toContain("PARENT_CONSTRAINT_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall({ from: OTHER, parentAddress: MANAGER })], approved, liveState()).failureCodes).toContain("CALLER_CONSTRAINT_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([{ from: MANAGER, to: null, callType: "CREATE", selector: null }], approved, liveState()).failureCodes).toContain("PROHIBITED_OPERATION");
  });

  it("rejects SmartRouterHelper delegatecalls outside the exact parent and selector context", () => {
    const helperRecord = protocolRecord({
      address: SMART_ROUTER_HELPER,
      role: "PROTOCOL_LIBRARY",
      runtimeCodeHash: HELPER_HASH,
      approvedSelectors: ["0x4e6c8ed8", "0x8bdb1925"],
      allowedCallTypes: ["DELEGATECALL"],
      parentConstraints: [{ parentAddress: SMART_ROUTER, parentRole: "PROTOCOL_ROUTER" }],
      callerConstraints: [
        { caller: SMART_ROUTER, selector: "0x4e6c8ed8", callType: "DELEGATECALL" },
        { caller: SMART_ROUTER, selector: "0x8bdb1925", callType: "DELEGATECALL" },
      ],
      delegatecallContext: {
        parentAddress: SMART_ROUTER,
        callerAddress: SMART_ROUTER,
        allowedSelectors: ["0x4e6c8ed8", "0x8bdb1925"],
      },
    });
    const manifest = trustManifest({
      records: [contextRecord(SMART_ROUTER, "PROTOCOL_ROUTER", OTHER_HASH), helperRecord],
      allowedEdges: [protocolEdge({
        fromRole: "PROTOCOL_ROUTER",
        fromAddress: SMART_ROUTER,
        toRole: "PROTOCOL_LIBRARY",
        toAddress: SMART_ROUTER_HELPER,
        callType: "DELEGATECALL",
        selector: "0x4e6c8ed8",
      })],
    });
    const approved = verified(manifest);
    const exact = liveCall({
      from: SMART_ROUTER,
      to: SMART_ROUTER_HELPER,
      callType: "DELEGATECALL",
      selector: "0x4e6c8ed8",
      codeHash: HELPER_HASH,
      parentAddress: SMART_ROUTER,
    });
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, liveState({
      targetCodeHashes: { [SMART_ROUTER_HELPER]: HELPER_HASH },
    })).automaticExecutionEligible).toBe(true);
    expect(compareLiveExecutionGraphToApprovedManifest([{
      ...exact,
      parentAddress: MANAGER,
    }], approved, liveState()).failureCodes).toContain("DELEGATECALL_CONTEXT_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([{
      ...exact,
      selector: "0xdeadbeef",
    }], approved, liveState()).failureCodes).toContain("UNEXPECTED_SELECTOR");
  });

  it("rejects token implementations unless the live token-proxy parent relationship matches", () => {
    const tokenImplRecord = protocolRecord({
      address: TOKEN_IMPL,
      role: "TOKEN_IMPLEMENTATION",
      runtimeCodeHash: TOKEN_IMPL_HASH,
      approvedSelectors: ["0x70a08231"],
      allowedCallTypes: ["DELEGATECALL"],
      parentConstraints: [{ parentAddress: TOKEN_PROXY, parentRole: "TOKEN_PROXY" }],
      callerConstraints: [{ caller: TOKEN_PROXY, selector: "0x70a08231", callType: "DELEGATECALL" }],
      delegatecallContext: {
        parentAddress: TOKEN_PROXY,
        callerAddress: TOKEN_PROXY,
        allowedSelectors: ["0x70a08231"],
      },
    });
    const manifest = trustManifest({
      records: [contextRecord(TOKEN_PROXY, "TOKEN_PROXY", OTHER_HASH), tokenImplRecord],
      allowedEdges: [protocolEdge({
        fromRole: "TOKEN_PROXY",
        fromAddress: TOKEN_PROXY,
        toRole: "TOKEN_IMPLEMENTATION",
        toAddress: TOKEN_IMPL,
        callType: "DELEGATECALL",
        selector: "0x70a08231",
      })],
    });
    const approved = verified(manifest);
    const exact = liveCall({
      from: TOKEN_PROXY,
      to: TOKEN_IMPL,
      callType: "DELEGATECALL",
      selector: "0x70a08231",
      codeHash: TOKEN_IMPL_HASH,
      parentAddress: TOKEN_PROXY,
    });
    const state = liveState({
      targetCodeHashes: { [TOKEN_IMPL]: TOKEN_IMPL_HASH },
      implementationRelationships: [{
        proxyAddress: TOKEN_PROXY,
        implementationAddress: TOKEN_IMPL,
        implementationCodeHash: TOKEN_IMPL_HASH,
      }],
    });
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, state).automaticExecutionEligible).toBe(true);
    expect(compareLiveExecutionGraphToApprovedManifest([{
      ...exact,
      from: OTHER,
      parentAddress: OTHER,
    }], approved, state).failureCodes).toContain("PARENT_CONSTRAINT_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, liveState({
      targetCodeHashes: { [TOKEN_IMPL]: TOKEN_IMPL_HASH },
      implementationRelationships: [{
        proxyAddress: TOKEN_PROXY,
        implementationAddress: OTHER,
        implementationCodeHash: TOKEN_IMPL_HASH,
      }],
    })).failureCodes).toContain("IMPLEMENTATION_MISMATCH");
  });

  it("rejects wrong V3 pool factory, token pair, and fee tier", () => {
    const poolRecord = protocolRecord({
      address: POOL,
      role: "V3_POOL",
      runtimeCodeHash: POOL_HASH,
      approvedSelectors: ["0x128acb08"],
      allowedCallTypes: ["CALL"],
      parentConstraints: [{ parentAddress: MANAGER, parentRole: "PITEAS_SWAP_MANAGER" }],
      callerConstraints: [{ caller: MANAGER, selector: "0x128acb08", callType: "CALL" }],
      factoryConstraints: {
        factoryAddress: FACTORY,
        factoryCodeHash: FACTORY_HASH,
        protocol: "Mock V3",
        poolAddress: POOL,
        fee: 2500,
        tickSpacing: 50,
      },
      tokenConstraints: {
        token0: TOKEN0,
        token1: TOKEN1,
        assets: [TOKEN0, TOKEN1],
        fee: 2500,
        tickSpacing: 50,
      },
    });
    const manifest = trustManifest({
      records: [managerRecord(), poolRecord],
      allowedEdges: [protocolEdge({
        toRole: "V3_POOL",
        toAddress: POOL,
        selector: "0x128acb08",
      })],
    });
    const approved = verified(manifest);
    const exact = liveCall({ to: POOL, selector: "0x128acb08", codeHash: POOL_HASH });
    const state = liveState({
      targetCodeHashes: { [POOL]: POOL_HASH },
      poolStates: {
        [POOL]: { factoryAddress: FACTORY, token0: TOKEN0, token1: TOKEN1, fee: 2500, tickSpacing: 50 },
      },
    });
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, state).automaticExecutionEligible).toBe(true);
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, {
      ...state,
      poolStates: { [POOL]: { factoryAddress: OTHER, token0: TOKEN0, token1: TOKEN1, fee: 2500, tickSpacing: 50 } },
    }).failureCodes).toContain("FACTORY_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, {
      ...state,
      poolStates: { [POOL]: { factoryAddress: FACTORY, token0: TOKEN1, token1: TOKEN0, fee: 2500, tickSpacing: 50 } },
    }).failureCodes).toContain("TOKEN_CONSTRAINT_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, {
      ...state,
      poolStates: { [POOL]: { factoryAddress: FACTORY, token0: TOKEN0, token1: TOKEN1, fee: 3000, tickSpacing: 50 } },
    }).failureCodes).toContain("FEE_TIER_MISMATCH");
  });

  it("does not treat operatorApproved booleans or unsigned candidates as authority", () => {
    const manifest = trustManifest() as TrustManifest & { operatorApproved?: boolean };
    manifest.operatorApproved = true;
    const unsigned = verifySignedTrustManifest({
      manifest,
      manifestFingerprint: manifestFingerprint(manifest),
      signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
      operatorPublicKeyId: "test",
      signature: "",
      operatorApproved: true,
    }, {
      pinnedPublicKeys: {},
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(unsigned.executionAuthority).toBe("INVALID");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall()], unsigned, liveState()).automaticExecutionEligible).toBe(false);
  });

  it("returns structured invalid results for malformed signed manifest objects", () => {
    expect(() =>
      verifySignedTrustManifest({
        manifest: { version: "phiat-execution-trust-v1" },
        manifestFingerprint: `0x${"00".repeat(32)}`,
        signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
        operatorPublicKeyId: "test",
        signature: "AA==",
      }, {
        pinnedPublicKeys: {},
        nowMs: NOW,
        currentBlock: "27195533",
      }),
    ).not.toThrow();
    const result = verifySignedTrustManifest({
      manifest: { version: "phiat-execution-trust-v1" },
      manifestFingerprint: `0x${"00".repeat(32)}`,
      signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
      operatorPublicKeyId: "test",
      signature: "AA==",
    }, {
      pinnedPublicKeys: {},
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(result.executionAuthority).toBe("INVALID");
    expect(result.validationErrors).toContain("RECORDS_MISSING");
  });

  it("generates unsigned candidates and registers read-only manifest tools", () => {
    const candidate = buildTrustManifestCandidateFromReport(mockTrustReport(), {
      expiresAtBlock: "27195600",
      expiresAt: "2026-08-04T00:00:00.000Z",
    });
    expect(candidate.operatorSignatureRequired).toBe(true);
    expect(candidate.automaticExecutionEligible).toBe(false);
    expect(candidate.unresolvedRecords).toEqual([]);
    expect(candidate.reviewReport).toContain(GRAPH_FINGERPRINT);
    expect(candidate.reviewReport).toContain(BUNDLE_FINGERPRINT);

    const metas = new Map<string, { write?: boolean; category?: string }>();
    const server = {
      registerTool(name: string, meta: { write?: boolean; category?: string }) {
        metas.set(name, { ...meta });
      },
    };
    resetToolRegistry();
    registerPhiatTrustManifestTools(server as never, baseConfig);
    expect(metas.get("phiat_trust_manifest_candidate")).toHaveProperty("inputSchema");
    expect(metas.get("phiat_trust_manifest_verify")).toHaveProperty("inputSchema");
    expect(getRegisteredTools().find((tool) => tool.name === "phiat_trust_manifest_candidate")).toMatchObject({
      write: false,
      category: "analytics",
    });
    expect(getRegisteredTools().find((tool) => tool.name === "phiat_trust_manifest_verify")).toMatchObject({
      write: false,
      category: "analytics",
    });
  });
});

function mockTrustReport(): ExecutionTrustReport {
  const record = {
    chainId: 369,
    address: TARGET,
    normalizedAddress: TARGET,
    role: "PROTOCOL_ROUTER" as const,
    runtimeCodeHash: TARGET_HASH,
    proxyType: "NONE_DETECTED" as const,
    implementationAddress: null,
    implementationCodeHash: null,
    approvedSelectors: [],
    observedSelectors: ["0xabcdef01"],
    parentConstraints: [{ parentAddress: MANAGER, parentRole: "PITEAS_SWAP_MANAGER" as const }],
    callerConstraints: [{ caller: MANAGER, selector: "0xabcdef01", callType: "CALL" }],
    factoryAddress: null,
    factoryCodeHash: null,
    tokenConstraints: null,
    managerCodeHashConstraint: MANAGER_HASH,
    firstObservedBlock: HISTORICAL_BLOCK,
    lastObservedBlock: HISTORICAL_BLOCK,
    evidence: { source: "test-only fixture" },
    confidence: "high" as const,
    unresolvedReasons: [],
    operatorApproved: false as const,
  };
  return {
    chainId: 369,
    historicalTransaction: HISTORICAL_TX,
    historicalBlock: HISTORICAL_BLOCK,
    traceBackend: { rpcUrl: "https://rpc-a.example", method: "debug_traceTransaction", supported: true, attempts: [] },
    normalizedCalls: [{
      tracePath: "0",
      depth: 2,
      callType: "CALL",
      from: MANAGER,
      to: TARGET,
      selector: "0xabcdef01",
      valueWei: "0",
      inputFingerprint: null,
      outputFingerprint: null,
      success: true,
      gasUsed: "1",
      parentAddress: MANAGER,
      parentRole: "PITEAS_SWAP_MANAGER",
      runtimeCodeHash: TARGET_HASH,
      blockNumber: HISTORICAL_BLOCK,
      classification: "PROTOCOL_ROUTER",
      unresolvedReasons: [],
    }],
    callCount: 1,
    targetClassifications: { [TARGET]: "PROTOCOL_ROUTER" },
    runtimeCodeEvidence: [],
    sourceEvidence: [],
    poolProvenance: [],
    delegatecallTargets: [],
    candidateRecords: [record],
    routeTrustBundle: {
      chainId: 369,
      routerAddress: PITEAS_ROUTER.toLowerCase(),
      routerCodeHash: ROUTER_HASH,
      swapManagerAddress: MANAGER,
      swapManagerCodeHash: MANAGER_HASH,
      historicalTransaction: HISTORICAL_TX,
      historicalBlock: HISTORICAL_BLOCK,
      requiredRecords: [record],
      optionalRecords: [],
      unresolvedRecords: [],
      prohibitedOperations: [],
      graphFingerprint: GRAPH_FINGERPRINT,
      bundleFingerprint: BUNDLE_FINGERPRINT,
      operatorApproved: false,
    },
    graphPolicy: {
      graphStatus: "FULLY_CLASSIFIED",
      classifiedCallCount: 1,
      unresolvedCallCount: 0,
      classifiedStateChangingCallCount: 1,
      unresolvedStateChangingCallCount: 0,
      unresolvedDelegatecallCount: 0,
      unknownSelectorCount: 0,
      prohibitedOperationCount: 0,
      automaticExecutionEligible: false,
    },
    liveComparisonPreview: {
      status: "REJECTED",
      failureCodes: ["BUNDLE_NOT_OPERATOR_APPROVED"],
      warnings: [],
      automaticExecutionEligible: false,
    },
  };
}
