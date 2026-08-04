import { createPublicKey, generateKeyPairSync, sign as signPayload, verify as verifyPayload } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import type { PhiatTrustOperatorPublicKeyRegistryEntry } from "../src/types.js";
import {
  PITEAS_ROUTER,
  PITEAS_SWAP_MANAGER_SELECTOR,
  buildTrustManifestCandidateFromReport,
  canonicalManifestBytes,
  canonicalizationProfile,
  canonicalizeJson,
  compareLiveExecutionGraphToApprovedManifest,
  manifestFingerprint,
  manifestIdFor,
  publicKeyIdFromSpkiDerBase64,
  registerPhiatTrustManifestTools,
  signatureFrameForManifest,
  signatureFrameSpecification,
  signedManifestPayload,
  TRUST_MANIFEST_CANONICALIZATION,
  TRUST_MANIFEST_DOMAIN_SEPARATOR,
  TRUST_MANIFEST_SIGNATURE_FRAME_MAGIC,
  TRUST_MANIFEST_SIGNATURE_ALGORITHM,
  verifySignedTrustManifest,
  type LiveChainStateForManifest,
  type LiveExecutionGraphCall,
  type SignedTrustManifest,
  type TrustManifest,
  type TrustManifestEdge,
  type TrustManifestRecord,
} from "../src/tools/analytics/phiatShadowBuy.js";
import { exportOfflineSigningMaterials } from "../src/tools/analytics/phiat-shadow-buy/offlineTrustSigner.js";
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
const EXACT_TOKEN_PROXY_A = "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07";
const EXACT_TOKEN_PROXY_B = "0x0cb6f5a34ad42ec934882a05265a7d5f59b51a2f";
const EXACT_TOKEN_IMPL_HASH = "0x57a73a555fee21aa544bcd2feeba6033020677d82977701a78e89b7da0f45b08";
const TEST_OPERATOR_PUBLIC_KEY_ID = `0x${"77".repeat(32)}`;
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

function keyRegistryEntry(
  key: ReturnType<typeof keyMaterial>,
  overrides: Partial<PhiatTrustOperatorPublicKeyRegistryEntry> = {},
): PhiatTrustOperatorPublicKeyRegistryEntry {
  return {
    keyId: key.publicKeyId,
    algorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    spkiDerBase64: key.publicKeySpkiDerBase64,
    status: "ACTIVE",
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-08-05T00:00:00.000Z",
    allowedManifestVersions: ["phiat-execution-trust-v1"],
    allowedChainIds: [369],
    ...overrides,
  };
}

function signManifest(manifest: TrustManifest, key = keyMaterial()): SignedTrustManifest {
  const withKey = { ...manifest, operatorPublicKeyId: key.publicKeyId };
  const manifestForSigning = { ...withKey, manifestId: manifestIdFor(withKey) };
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
    delegatecallContexts: [],
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
    delegatecallContexts: [],
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
  approvedAt?: string | null;
  approvedAtBlock?: string | null;
  expiresAt?: string | null;
  expiresAtBlock?: string | null;
} = {}): TrustManifest {
  const records = [...(args.records ?? [managerRecord(), protocolRecord()])].sort((a, b) =>
    testRecordSortKey(a) < testRecordSortKey(b) ? -1 : testRecordSortKey(a) > testRecordSortKey(b) ? 1 : 0,
  );
  const allowedEdges = [...(args.allowedEdges ?? [protocolEdge()])].sort((a, b) =>
    testEdgeKey(a) < testEdgeKey(b) ? -1 : testEdgeKey(a) > testEdgeKey(b) ? 1 : 0,
  );
  const manifest = {
    version: "phiat-execution-trust-v1",
    manifestId: `0x${"00".repeat(32)}`,
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
    approvedAt: args.approvedAt ?? "2026-08-03T00:00:00.000Z",
    approvedAtBlock: args.approvedAtBlock ?? "27195533",
    expiresAt: args.expiresAt ?? "2026-08-04T00:00:00.000Z",
    expiresAtBlock: args.expiresAtBlock ?? "27195600",
    operatorPublicKeyId: "operator-key-id-required",
  };
  return { ...manifest, manifestId: manifestIdFor(manifest) };
}

function testRecordSortKey(record: TrustManifestRecord): string {
  return [record.role, record.address, record.runtimeCodeHash ?? "null"].join("|");
}

function testEdgeKey(edge: TrustManifestEdge): string {
  return [
    edge.fromRole ?? "null",
    edge.fromAddress ?? "null",
    edge.toRole,
    edge.toAddress,
    edge.callType,
    edge.selector ?? "none",
  ].join("|");
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

function expectCandidateSuccess(candidate: ReturnType<typeof buildTrustManifestCandidateFromReport>) {
  if (candidate.candidateGenerationStatus !== "PASSED") {
    throw new Error(candidate.validationErrors.join(","));
  }
  expect(candidate.candidateGenerationStatus).toBe("PASSED");
  return candidate;
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

function sameTestAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function tokenImplCall(parentAddress: string, selector: string, index = 0) {
  return {
    tracePath: `0.${index}`,
    depth: 3,
    callType: "DELEGATECALL",
    from: parentAddress.toLowerCase(),
    to: TOKEN_IMPL,
    selector,
    valueWei: "0",
    inputFingerprint: null,
    outputFingerprint: null,
    success: true,
    gasUsed: "1",
    parentAddress: parentAddress.toLowerCase(),
    parentRole: "TOKEN_PROXY" as const,
    runtimeCodeHash: EXACT_TOKEN_IMPL_HASH,
    blockNumber: HISTORICAL_BLOCK,
    classification: "TOKEN_IMPLEMENTATION" as const,
    unresolvedReasons: [],
  };
}

function exactTokenImplementationReport(): ExecutionTrustReport {
  return tokenImplementationReport([
    tokenImplCall(EXACT_TOKEN_PROXY_A, "0x23b872dd", 0),
    tokenImplCall(EXACT_TOKEN_PROXY_A, "0xdd62ed3e", 1),
    tokenImplCall(EXACT_TOKEN_PROXY_A, "0x23b872dd", 2),
    tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231", 3),
    tokenImplCall(EXACT_TOKEN_PROXY_B, "0x70a08231", 4),
    tokenImplCall(EXACT_TOKEN_PROXY_B, "0xa9059cbb", 5),
    tokenImplCall(EXACT_TOKEN_PROXY_B, "0x70a08231", 6),
    tokenImplCall(EXACT_TOKEN_PROXY_B, "0xdd62ed3e", 7),
    tokenImplCall(EXACT_TOKEN_PROXY_B, "0x23b872dd", 8),
    tokenImplCall(EXACT_TOKEN_PROXY_A, "0xa9059cbb", 9),
  ]);
}

function tokenImplementationReport(calls: ReturnType<typeof tokenImplCall>[]): ExecutionTrustReport {
  const selectors = [...new Set(calls.map((call) => call.selector.toLowerCase()))].sort();
  const callerConstraints = [...new Map(calls.map((call) => [
    `${call.from.toLowerCase()}|${call.selector.toLowerCase()}`,
    { caller: call.from.toLowerCase(), selector: call.selector, callType: "DELEGATECALL" },
  ])).values()];
  const parentConstraints = [...new Map(calls.map((call) => [
    call.parentAddress.toLowerCase(),
    { parentAddress: call.parentAddress.toLowerCase(), parentRole: "TOKEN_PROXY" as const },
  ])).values()];
  const proxyRecords = [...new Set(calls.map((call) => call.parentAddress.toLowerCase()))].map((address) =>
    reportRecord({
      address,
      role: "TOKEN_PROXY",
      runtimeCodeHash: OTHER_HASH,
      observedSelectors: [],
      parentConstraints: [],
      callerConstraints: [],
    }),
  );
  const implRecord = reportRecord({
    address: TOKEN_IMPL,
    role: "TOKEN_IMPLEMENTATION",
    runtimeCodeHash: EXACT_TOKEN_IMPL_HASH,
    implementationAddress: TOKEN_IMPL,
    implementationCodeHash: EXACT_TOKEN_IMPL_HASH,
    observedSelectors: selectors,
    parentConstraints,
    callerConstraints,
  });
  const base = mockTrustReport();
  return {
    ...base,
    normalizedCalls: calls,
    callCount: calls.length,
    targetClassifications: Object.fromEntries([
      ...proxyRecords.map((record) => [record.normalizedAddress, record.role]),
      [implRecord.normalizedAddress, implRecord.role],
    ]),
    candidateRecords: [...proxyRecords, implRecord],
    routeTrustBundle: {
      ...base.routeTrustBundle,
      requiredRecords: [...proxyRecords, implRecord],
      unresolvedRecords: [],
    },
  };
}

function reportRecord(args: {
  address: string;
  role: ExecutionTrustReport["candidateRecords"][number]["role"];
  runtimeCodeHash: string;
  implementationAddress?: string | null;
  implementationCodeHash?: string | null;
  observedSelectors: string[];
  parentConstraints: ExecutionTrustReport["candidateRecords"][number]["parentConstraints"];
  callerConstraints: ExecutionTrustReport["candidateRecords"][number]["callerConstraints"];
}): ExecutionTrustReport["candidateRecords"][number] {
  return {
    chainId: 369,
    address: args.address,
    normalizedAddress: args.address.toLowerCase(),
    role: args.role,
    runtimeCodeHash: args.runtimeCodeHash,
    proxyType: args.role === "TOKEN_IMPLEMENTATION" ? "TRACE_BOUND_TOKEN_PROXY" : "NONE_DETECTED",
    implementationAddress: args.implementationAddress ?? null,
    implementationCodeHash: args.implementationCodeHash ?? null,
    approvedSelectors: [],
    observedSelectors: args.observedSelectors,
    parentConstraints: args.parentConstraints,
    callerConstraints: args.callerConstraints,
    factoryAddress: null,
    factoryCodeHash: null,
    tokenConstraints: null,
    managerCodeHashConstraint: MANAGER_HASH,
    firstObservedBlock: HISTORICAL_BLOCK,
    lastObservedBlock: HISTORICAL_BLOCK,
    evidence: { source: "test-only fixture" },
    confidence: "high",
    unresolvedReasons: [],
    operatorApproved: false,
  };
}

describe("signed PHIAT execution trust manifests", () => {
  it("canonicalizes object keys deterministically and fingerprints semantic changes", () => {
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalizeJson({ z: null, a: [true, false, "A\n"] })).toBe('{"a":[true,false,"A\\n"],"z":null}');
    expect(canonicalizeJson({ a: [2, 1] })).toBe('{"a":[2,1]}');
    expect(canonicalizeJson({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(() => canonicalizeJson({ amount: 1.5 })).toThrow();
    expect(() => canonicalizeJson({ block: 9_007_199_254_740_992 })).toThrow();
    expect(canonicalizationProfile()).toMatchObject({
      standard: TRUST_MANIFEST_CANONICALIZATION,
      canonicalizationVersion: 1,
    });
    const manifest = trustManifest();
    const reordered = Object.fromEntries(Object.entries(manifest).reverse()) as TrustManifest;
    expect(manifestFingerprint(reordered)).toBe(manifestFingerprint(manifest));
    expect(manifestFingerprint({ ...manifest, chainId: 943 })).not.toBe(manifestFingerprint(manifest));
  });

  it("rejects duplicate keys, trailing JSON, malformed Unicode, and unsafe number input before authority", () => {
    const key = keyMaterial();
    const signed = signManifest(trustManifest(), key);
    const verifyString = (json: string) =>
      verifySignedTrustManifest(json, {
        pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
        nowMs: NOW,
        currentBlock: "27195533",
      });

    expect(verifyString(`{"manifest":{},"manifest":{},"manifestFingerprint":"${`0x${"00".repeat(32)}`}","signatureAlgorithm":"Ed25519","operatorPublicKeyId":"${key.publicKeyId}","signature":"AA=="}`).validationErrors).toContain("STRICT_JSON_DUPLICATE_KEY");
    expect(verifyString(`{"manifest":{"version":"a","version":"b"},"manifestFingerprint":"${`0x${"00".repeat(32)}`}","signatureAlgorithm":"Ed25519","operatorPublicKeyId":"${key.publicKeyId}","signature":"AA=="}`).validationErrors).toContain("STRICT_JSON_DUPLICATE_KEY");
    expect(verifyString(`{"manifest":{},"\\u006d\\u0061\\u006e\\u0069\\u0066\\u0065\\u0073\\u0074":{}}`).validationErrors).toContain("STRICT_JSON_DUPLICATE_KEY");
    expect(verifyString(`${JSON.stringify(signed)} {}`).validationErrors).toContain("STRICT_JSON_TRAILING_DATA");
    expect(verifyString(`{"manifest":{"version":"\\ud800"}}`).validationErrors).toContain("STRICT_JSON_MALFORMED_UNICODE");
    expect(verifyString(`{"manifest":{"chainId":NaN}}`).validationErrors).toContain("STRICT_JSON_INVALID_VALUE");
    expect(verifyString(`{"manifest":{"chainId":Infinity}}`).validationErrors).toContain("STRICT_JSON_INVALID_VALUE");
    expect(verifyString(`{"manifest":{"chainId":9007199254740992}}`).validationErrors).toContain("STRICT_JSON_UNSAFE_INTEGER");

    const unsafeBlock = verifySignedTrustManifest({
      ...signed,
      manifest: { ...signed.manifest, historicalBlock: 9_007_199_254_740_992 },
    }, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(unsafeBlock.validationErrors).toContain("HISTORICAL_BLOCK_INVALID");
    expect(unsafeBlock.executionAuthority).toBe("INVALID");
  });

  it("uses deterministic source-set ordering while canonicalization preserves raw array order", () => {
    const firstReport = mockTrustReportWithTwoRecords(false);
    const secondReport = mockTrustReportWithTwoRecords(true);
    const first = buildTrustManifestCandidateFromReport(firstReport, {
      expiresAtBlock: "27195600",
      expiresAt: "2026-08-04T00:00:00.000Z",
    });
    const second = buildTrustManifestCandidateFromReport(secondReport, {
      expiresAtBlock: "27195600",
      expiresAt: "2026-08-04T00:00:00.000Z",
    });
    expect(first.manifestFingerprint).toBe(second.manifestFingerprint);

    const manifest = trustManifest();
    const reorderedArrays = { ...manifest, records: [...manifest.records].reverse() };
    expect(manifestFingerprint({ ...reorderedArrays, manifestId: manifestIdFor(reorderedArrays) })).not.toBe(
      manifestFingerprint(manifest),
    );

    const key = keyMaterial();
    const reorderedSigned = signManifest(reorderedArrays, key);
    const reorderedResult = verifySignedTrustManifest(reorderedSigned, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(reorderedResult.validationErrors).toContain("RECORDS_NOT_SORTED");
    expect(reorderedResult.executionAuthority).toBe("INVALID");

    const duplicateSelector = signManifest(trustManifest({
      records: [managerRecord(), protocolRecord({ approvedSelectors: ["0xabcdef01", "0xabcdef01"] })],
    }), key);
    expect(verifySignedTrustManifest(duplicateSelector, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).validationErrors).toContain("APPROVED_SELECTORS_DUPLICATE");

    const duplicateEdge = signManifest(trustManifest({
      allowedEdges: [protocolEdge(), protocolEdge()],
    }), key);
    expect(verifySignedTrustManifest(duplicateEdge, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).validationErrors).toContain("ALLOWED_EDGES_DUPLICATE");
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
    expect(valid.verificationScope).toBe("MANIFEST_AUTHORIZATION");
    expect(valid.manifestAuthorizationStatus).toBe("VALID");
    expect(valid.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(valid.graphAuthorityStatus).toBe("NOT_EVALUATED");
    expect(valid.executionAuthority).toBe("NOT_EVALUATED");
    expect(valid.automaticExecutionEligible).toBe(false);
    expect(valid.authorizationLayers.signedManifest).toMatchObject({
      status: "VALID",
      signatureValid: true,
      schemaValid: true,
      temporalValid: true,
    });
    expect(valid.authorizationLayers.execution).toMatchObject({
      status: "NOT_EVALUATED",
      automaticExecutionEligible: false,
    });

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

  it("separates manifest authorization from exact live execution authority", () => {
    const key = keyMaterial();
    const signed = signManifest(trustManifest(), key);
    const publicKeys = { [key.publicKeyId]: key.publicKeySpkiDerBase64 };
    const clearRevocations = { manifests: [], keys: [] };
    const baseVerification = {
      pinnedPublicKeys: publicKeys,
      nowMs: NOW,
      currentBlock: "27195533",
      currentChainId: 369,
    };

    const defaultScope = verifySignedTrustManifest(signed, baseVerification);
    expect(defaultScope.verificationScope).toBe("MANIFEST_AUTHORIZATION");
    expect(defaultScope.manifestAuthorizationStatus).toBe("VALID");
    expect(defaultScope.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(defaultScope.executionAuthority).toBe("NOT_EVALUATED");
    expect(defaultScope.automaticExecutionEligible).toBe(false);

    const signatureOnly = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "SIGNATURE_ONLY",
    });
    expect(signatureOnly.verificationScope).toBe("SIGNATURE_ONLY");
    expect(signatureOnly.signatureValid).toBe(true);
    expect(signatureOnly.manifestAuthorizationStatus).toBe("VALID");
    expect(signatureOnly.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(signatureOnly.executionAuthority).toBe("NOT_EVALUATED");

    const chainState = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "CHAIN_STATE",
      revocations: clearRevocations,
    });
    expect(chainState.verificationScope).toBe("CHAIN_STATE");
    expect(chainState.chainStateStatus).toBe("PASSED");
    expect(chainState.manifestAuthorizationStatus).toBe("VALID");
    expect(chainState.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(chainState.executionAuthority).toBe("NOT_EVALUATED");

    const graphNotEvaluated = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "EXACT_LIVE_GRAPH",
      revocations: clearRevocations,
    });
    expect(graphNotEvaluated.manifestAuthorizationStatus).toBe("VALID");
    expect(graphNotEvaluated.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(graphNotEvaluated.executionAuthority).toBe("NOT_EVALUATED");
    expect(graphNotEvaluated.automaticExecutionEligible).toBe(false);

    const revocationUnavailable = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "EXACT_LIVE_GRAPH",
      liveGraph: [liveCall()],
      liveChainState: liveState(),
      traceStatus: "PASSED",
    });
    expect(revocationUnavailable.manifestAuthorizationStatus).toBe("VALID");
    expect(revocationUnavailable.revocationStatus).toBe("UNCONFIGURED");
    expect(revocationUnavailable.liveExecutionAuthorityStatus).toBe("REVOCATION_UNAVAILABLE");
    expect(revocationUnavailable.executionAuthority).toBe("REVOCATION_UNAVAILABLE");
    expect(revocationUnavailable.validationErrors).toContain("REVOCATION_REGISTRY_REQUIRED");
    expect(revocationUnavailable.automaticExecutionEligible).toBe(false);

    const exactLive = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "EXACT_LIVE_GRAPH",
      revocations: clearRevocations,
      liveGraph: [liveCall()],
      liveChainState: liveState(),
      traceStatus: "PASSED",
    });
    expect(exactLive.manifestAuthorizationStatus).toBe("VALID");
    expect(exactLive.liveExecutionAuthorityStatus).toBe("VALID");
    expect(exactLive.graphAuthorityStatus).toBe("PASSED");
    expect(exactLive.executionAuthority).toBe("VALID");
    expect(exactLive.automaticExecutionEligible).toBe(true);
    expect(exactLive.authorizationLayers).toMatchObject({
      signedManifest: {
        status: "VALID",
        fingerprint: signed.manifestFingerprint,
        keyId: key.publicKeyId,
        signatureValid: true,
        schemaValid: true,
        temporalValid: true,
      },
      revocation: { status: "PASSED", configured: true, clear: true },
      chainState: { status: "PASSED", routerMatched: true, managerMatched: true },
      liveGraph: { status: "VALID", evaluated: true, graphMatched: true },
      execution: { status: "VALID", automaticExecutionEligible: true },
    });

    const traceUnavailable = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "EXACT_LIVE_GRAPH",
      revocations: clearRevocations,
      traceStatus: "UNSUPPORTED",
    });
    expect(traceUnavailable.manifestAuthorizationStatus).toBe("VALID");
    expect(traceUnavailable.liveExecutionAuthorityStatus).toBe("TRACE_UNAVAILABLE");
    expect(traceUnavailable.executionAuthority).toBe("TRACE_UNAVAILABLE");
    expect(traceUnavailable.automaticExecutionEligible).toBe(false);

    const graphMismatch = verifySignedTrustManifest(signed, {
      ...baseVerification,
      verificationScope: "EXACT_LIVE_GRAPH",
      revocations: clearRevocations,
      liveGraph: [
        liveCall({ to: OTHER }),
        liveCall({ selector: "0xdeadbeef" }),
        liveCall({ from: OTHER }),
      ],
      liveChainState: liveState({ targetCodeHashes: { [TARGET]: TARGET_HASH, [OTHER]: TARGET_HASH } }),
      traceStatus: "PASSED",
    });
    expect(graphMismatch.liveExecutionAuthorityStatus).toBe("GRAPH_MISMATCH");
    expect(graphMismatch.graphAuthorityStatus).toBe("FAILED");
    expect(graphMismatch.executionAuthority).toBe("GRAPH_MISMATCH");
    expect(graphMismatch.authorizationLayers.liveGraph.unexpectedTargets).toContain(OTHER);
    expect(graphMismatch.authorizationLayers.liveGraph.unexpectedSelectors).toContain("0xdeadbeef");
    expect(graphMismatch.authorizationLayers.liveGraph.unexpectedEdges.length).toBeGreaterThan(0);
    expect(graphMismatch.automaticExecutionEligible).toBe(false);

    const stateMismatch = verifySignedTrustManifest(signManifest(trustManifest({ routerHash: OTHER_HASH }), key), {
      ...baseVerification,
      verificationScope: "EXACT_LIVE_GRAPH",
      revocations: clearRevocations,
      liveGraph: [liveCall()],
      liveChainState: liveState(),
      traceStatus: "PASSED",
    });
    expect(stateMismatch.manifestAuthorizationStatus).toBe("STATE_MISMATCH");
    expect(stateMismatch.liveExecutionAuthorityStatus).toBe("STATE_MISMATCH");
    expect(stateMismatch.executionAuthority).toBe("STATE_MISMATCH");
    expect(stateMismatch.automaticExecutionEligible).toBe(false);

    const invalidSignature = verifySignedTrustManifest({ ...signed, signature: "AA==" }, baseVerification);
    expect(invalidSignature.manifestAuthorizationStatus).toBe("INVALID");
    expect(invalidSignature.liveExecutionAuthorityStatus).toBe("INVALID");
    expect(invalidSignature.executionAuthority).toBe("INVALID");
    expect(invalidSignature.automaticExecutionEligible).toBe(false);

    const expired = verifySignedTrustManifest(signManifest(trustManifest({
      approvedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      expiresAtBlock: null,
    }), key), baseVerification);
    expect(expired.manifestAuthorizationStatus).toBe("EXPIRED");
    expect(expired.liveExecutionAuthorityStatus).toBe("INVALID");
    expect(expired.executionAuthority).toBe("EXPIRED");
    expect(expired.automaticExecutionEligible).toBe(false);

    const revokedManifest = verifySignedTrustManifest(signed, {
      ...baseVerification,
      revocations: {
        manifests: [{ manifestFingerprint: signed.manifestFingerprint, revokedAt: "2026-08-03T00:00:00.000Z", reason: "test" }],
      },
    });
    expect(revokedManifest.manifestAuthorizationStatus).toBe("REVOKED");
    expect(revokedManifest.liveExecutionAuthorityStatus).toBe("INVALID");
    expect(revokedManifest.executionAuthority).toBe("INVALID");

    const revokedKey = verifySignedTrustManifest(signed, {
      ...baseVerification,
      revocations: {
        keys: [{ keyId: key.publicKeyId, revokedAt: "2026-08-03T00:00:00.000Z", reason: "test" }],
      },
    });
    expect(revokedKey.manifestAuthorizationStatus).toBe("REVOKED");
    expect(revokedKey.liveExecutionAuthorityStatus).toBe("INVALID");
    expect(revokedKey.executionAuthority).toBe("INVALID");
  });

  it("uses an explicit binary signature frame and rejects downgrade, truncation, and wrapper tampering", () => {
    const key = keyMaterial();
    const manifest = trustManifest();
    const signed = signManifest(manifest, key);
    const frame = signatureFrameForManifest(signed.manifest);
    const spec = signatureFrameSpecification(signed.manifest);
    expect(spec.version).toBe(1);
    expect(spec.domainSeparator).toBe(TRUST_MANIFEST_DOMAIN_SEPARATOR);
    expect(frame.subarray(0, "PHIAT_TRUST_MANIFEST_SIG".length).toString("ascii")).toBe("PHIAT_TRUST_MANIFEST_SIG");
    expect(frame.readUInt8("PHIAT_TRUST_MANIFEST_SIG".length)).toBe(1);
    expect(signedManifestPayload(signed.manifest).equals(frame)).toBe(true);

    const prettyJson = JSON.stringify(signed, null, 2);
    expect(verifySignedTrustManifest(prettyJson, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).executionAuthority).toBe("NOT_EVALUATED");

    const oldAmbiguousPayload = Buffer.concat([
      Buffer.from(TRUST_MANIFEST_DOMAIN_SEPARATOR, "utf8"),
      Buffer.from(canonicalManifestBytes(signed.manifest)),
      Buffer.from(signed.manifestFingerprint.slice(2), "hex"),
    ]);
    const oldStyleSignature = {
      ...signed,
      signature: signPayload(null, oldAmbiguousPayload, key.privateKey).toString("base64"),
    };
    expect(verifySignedTrustManifest(oldStyleSignature, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).executionAuthority).toBe("INVALID");

    const wrongDomain = Buffer.from("PULSECHAIN_MCP_OTHER_DOMAIN_V1", "utf8");
    const wrongDomainLength = Buffer.alloc(4);
    wrongDomainLength.writeUInt32BE(wrongDomain.length, 0);
    const manifestBytes = Buffer.from(canonicalManifestBytes(signed.manifest));
    const manifestLength = Buffer.alloc(8);
    manifestLength.writeBigUInt64BE(BigInt(manifestBytes.length), 0);
    const wrongDomainFrame = Buffer.concat([
      Buffer.from(TRUST_MANIFEST_SIGNATURE_FRAME_MAGIC, "ascii"),
      Buffer.from([1]),
      wrongDomainLength,
      wrongDomain,
      manifestLength,
      manifestBytes,
      Buffer.from(signed.manifestFingerprint.slice(2), "hex"),
    ]);
    const wrongDomainSignature = {
      ...signed,
      signature: signPayload(null, wrongDomainFrame, key.privateKey).toString("base64"),
    };
    expect(verifySignedTrustManifest(wrongDomainSignature, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).executionAuthority).toBe("INVALID");

    expect(verifySignedTrustManifest({ ...signed, signature: signed.signature.slice(0, -4) }, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).validationErrors).toContain("SIGNATURE_LENGTH_INVALID");

    expect(verifySignedTrustManifest({ ...signed, manifestFingerprint: `0x${"11".repeat(32)}` }, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    }).validationErrors).toContain("MANIFEST_FINGERPRINT_MISMATCH");

    const alteredManifestOldWrapper = verifySignedTrustManifest({
      ...signed,
      manifest: { ...signed.manifest, chainId: 943 },
    }, {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(alteredManifestOldWrapper.validationErrors).toEqual(expect.arrayContaining([
      "MANIFEST_FINGERPRINT_MISMATCH",
      "MANIFEST_ID_MISMATCH",
      "SIGNATURE_INVALID",
    ]));
    expect(alteredManifestOldWrapper.executionAuthority).toBe("INVALID");
  });

  it("validates Ed25519 SPKI keys, derived key IDs, and RFC 8032 verification vectors", () => {
    const rfcPublicKey = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex"),
    ]);
    const rfcSignature = Buffer.from(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
      "hex",
    );
    expect(verifyPayload(null, Buffer.alloc(0), createPublicKey({
      key: rfcPublicKey,
      format: "der",
      type: "spki",
    }), rfcSignature)).toBe(true);

    const key = keyMaterial();
    const signed = signManifest(trustManifest(), key);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const x25519 = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const ed448 = generateKeyPairSync("ed448").publicKey.export({ format: "der", type: "spki" }).toString("base64");

    for (const spkiDerBase64 of [rsa, ec, x25519, ed448]) {
      const result = verifySignedTrustManifest(signed, {
        keyRegistry: [{ ...keyRegistryEntry(key), spkiDerBase64 }],
        nowMs: NOW,
        currentBlock: "27195533",
      });
      expect(result.validationErrors).toContain("PUBLIC_KEY_NOT_ED25519");
      expect(result.executionAuthority).toBe("INVALID");
    }

    const trailingDer = `${Buffer.concat([
      Buffer.from(key.publicKeySpkiDerBase64, "base64"),
      Buffer.from([0]),
    ]).toString("base64")}`;
    const trailingDerResult = verifySignedTrustManifest(signed, {
      keyRegistry: [{ ...keyRegistryEntry(key), spkiDerBase64: trailingDer }],
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(trailingDerResult.validationErrors.some((error) =>
      ["PUBLIC_KEY_DER_INVALID", "PUBLIC_KEY_DER_NOT_CANONICAL"].includes(error),
    )).toBe(true);

    const wrongKeyId = verifySignedTrustManifest(signed, {
      keyRegistry: [{ ...keyRegistryEntry(key), keyId: `0x${"12".repeat(32)}` }],
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(wrongKeyId.validationErrors).toContain("OPERATOR_PUBLIC_KEY_UNKNOWN");
    expect(wrongKeyId.executionAuthority).toBe("INVALID");
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
      approvedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      expiresAtBlock: null,
    }), key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(expiredByTime.executionAuthority).toBe("EXPIRED");

    const expiredByBlock = verifySignedTrustManifest(signManifest(trustManifest({
      approvedAtBlock: "27195531",
      expiresAt: null,
      expiresAtBlock: "27195532",
    }), key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(expiredByBlock.executionAuthority).toBe("EXPIRED");
  });

  it("enforces public-key registry status, validity windows, chain policy, and revocations", () => {
    const key = keyMaterial();
    const signed = signManifest(trustManifest(), key);
    const verifyWithEntry = (
      entry: PhiatTrustOperatorPublicKeyRegistryEntry,
      extra: Parameters<typeof verifySignedTrustManifest>[1] = {},
    ) => verifySignedTrustManifest(signed, {
      keyRegistry: [entry],
      nowMs: NOW,
      currentBlock: "27195533",
      ...extra,
    });

    const activeKey = verifyWithEntry(keyRegistryEntry(key));
    expect(activeKey.manifestAuthorizationStatus).toBe("VALID");
    expect(activeKey.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(activeKey.executionAuthority).toBe("NOT_EVALUATED");
    expect(verifyWithEntry(keyRegistryEntry(key, { status: "REVOKED" })).keyStatus).toBe("REVOKED");
    expect(verifyWithEntry(keyRegistryEntry(key, { status: "DISABLED" })).keyStatus).toBe("DISABLED");
    expect(verifyWithEntry(keyRegistryEntry(key, { validFrom: "2026-08-04T00:00:00.000Z" })).validationErrors).toContain("OPERATOR_PUBLIC_KEY_NOT_YET_VALID");
    expect(verifyWithEntry(keyRegistryEntry(key, { validUntil: "2026-08-02T00:00:00.000Z" })).validationErrors).toContain("OPERATOR_PUBLIC_KEY_EXPIRED");
    expect(verifyWithEntry(keyRegistryEntry(key, { allowedManifestVersions: ["future-version"] })).validationErrors).toContain("OPERATOR_PUBLIC_KEY_VERSION_NOT_ALLOWED");
    expect(verifyWithEntry(keyRegistryEntry(key, { allowedChainIds: [943] })).validationErrors).toContain("OPERATOR_PUBLIC_KEY_CHAIN_NOT_ALLOWED");

    const duplicateKeys = verifySignedTrustManifest(signed, {
      keyRegistry: [keyRegistryEntry(key), keyRegistryEntry(key)],
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(duplicateKeys.validationErrors).toEqual(expect.arrayContaining([
      "OPERATOR_PUBLIC_KEY_ID_DUPLICATE",
      "OPERATOR_PUBLIC_KEY_DER_DUPLICATE",
    ]));

    const revokedManifest = verifySignedTrustManifest(signed, {
      keyRegistry: [keyRegistryEntry(key)],
      revocations: {
        manifests: [{ manifestFingerprint: signed.manifestFingerprint, revokedAt: "2026-08-03T00:00:00.000Z", reason: "test" }],
      },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(revokedManifest.revocationStatus).toBe("REVOKED");
    expect(revokedManifest.executionAuthority).toBe("INVALID");

    const revokedKey = verifySignedTrustManifest(signed, {
      keyRegistry: [keyRegistryEntry(key)],
      revocations: {
        keys: [{ keyId: key.publicKeyId, revokedAt: "2026-08-03T00:00:00.000Z", reason: "test" }],
      },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(revokedKey.revocationStatus).toBe("REVOKED");
    expect(revokedKey.executionAuthority).toBe("INVALID");

    expect(verifySignedTrustManifest(signed, {
      keyRegistry: [keyRegistryEntry(key)],
      nowMs: NOW,
      currentBlock: "27195533",
    }).revocationStatus).toBe("UNCONFIGURED");
  });

  it("fails closed for future approval, invalid expiration ordering, and unbounded windows", () => {
    const key = keyMaterial();
    const cases: Array<[TrustManifest, string]> = [
      [trustManifest({ approvedAt: "2026-08-04T00:00:00.000Z" }), "APPROVED_AT_IN_FUTURE"],
      [trustManifest({ approvedAtBlock: "27195534" }), "APPROVED_AT_BLOCK_IN_FUTURE"],
      [trustManifest({ approvedAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T00:00:00.000Z" }), "EXPIRES_AT_NOT_AFTER_APPROVED_AT"],
      [trustManifest({ approvedAtBlock: "27195533", expiresAtBlock: "27195533" }), "EXPIRES_AT_BLOCK_NOT_AFTER_APPROVED_AT_BLOCK"],
      [trustManifest({ approvedAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-20T00:00:00.000Z" }), "EXPIRATION_WINDOW_TOO_LONG"],
      [trustManifest({ approvedAtBlock: "27195533", expiresAtBlock: "27300000" }), "EXPIRATION_BLOCK_WINDOW_TOO_LONG"],
    ];

    for (const [manifest, error] of cases) {
      const result = verifySignedTrustManifest(signManifest(manifest, key), {
        pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
        nowMs: NOW,
        currentBlock: "27195533",
      });
      expect(result.validationErrors).toContain(error);
      expect(result.executionAuthority).toBe("INVALID");
    }

    const missingCurrentBlock = verifySignedTrustManifest(signManifest(trustManifest(), key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: null,
    });
    expect(missingCurrentBlock.validationErrors).toContain("CURRENT_BLOCK_REQUIRED_FOR_APPROVAL_BLOCK");
    expect(missingCurrentBlock.validationErrors).toContain("CURRENT_BLOCK_REQUIRED_FOR_BLOCK_EXPIRATION");
    expect(missingCurrentBlock.executionAuthority).toBe("INVALID");
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
    expect(compareLiveExecutionGraphToApprovedManifest([{
      from: MANAGER,
      to: TARGET,
      callType: "STATICCALL",
      selector: "0xabcdef01",
      codeHash: TARGET_HASH,
      parentAddress: MANAGER,
    }], approved, liveState()).failureCodes).toContain("CALL_TYPE_MISMATCH");
    expect(compareLiveExecutionGraphToApprovedManifest([liveCall()], approved, liveState({
      swapManager: {
        address: MANAGER,
        runtimeCodeHash: MANAGER_HASH,
        storageSlot: "0x0000000000000000000000000000000000000000000000000000000000000000",
        storageAddress: MANAGER,
        managerChangeEventBlock: "27195534",
      },
    })).failureCodes).toContain("SWAP_MANAGER_CHANGED");
  });

  it("rejects unknown authority fields and changed graph or bundle bindings", () => {
    const key = keyMaterial();
    const withExtraManifestField = {
      ...trustManifest(),
      extraAuthority: "grant",
    } as TrustManifest & { extraAuthority: string };
    const extraManifestResult = verifySignedTrustManifest(signManifest(withExtraManifestField as TrustManifest, key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(extraManifestResult.validationErrors).toContain("MANIFEST_UNKNOWN_FIELD_extraAuthority");
    expect(extraManifestResult.executionAuthority).toBe("INVALID");

    const graphChanged = verifySignedTrustManifest(signManifest({
      ...trustManifest(),
      graphFingerprint: `0x${"44".repeat(32)}`,
    }, key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(graphChanged.signatureValid).toBe(true);
    expect(graphChanged.validationErrors).toContain("GRAPH_FINGERPRINT_MISMATCH");
    expect(graphChanged.executionAuthority).toBe("STATE_MISMATCH");

    const bundleChanged = verifySignedTrustManifest(signManifest({
      ...trustManifest(),
      bundleFingerprint: `0x${"55".repeat(32)}`,
    }, key), {
      pinnedPublicKeys: { [key.publicKeyId]: key.publicKeySpkiDerBase64 },
      nowMs: NOW,
      currentBlock: "27195533",
    });
    expect(bundleChanged.signatureValid).toBe(true);
    expect(bundleChanged.validationErrors).toContain("BUNDLE_FINGERPRINT_MISMATCH");
    expect(bundleChanged.executionAuthority).toBe("STATE_MISMATCH");
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
      delegatecallContexts: [{
        parentAddress: SMART_ROUTER,
        parentCodeHash: OTHER_HASH,
        callerAddress: SMART_ROUTER,
        callType: "DELEGATECALL",
        targetAddress: SMART_ROUTER_HELPER,
        targetCodeHash: HELPER_HASH,
        selectors: ["0x4e6c8ed8", "0x8bdb1925"],
      }],
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
      delegatecallContexts: [{
        parentAddress: TOKEN_PROXY,
        parentCodeHash: OTHER_HASH,
        callerAddress: TOKEN_PROXY,
        callType: "DELEGATECALL",
        targetAddress: TOKEN_IMPL,
        targetCodeHash: TOKEN_IMPL_HASH,
        selectors: ["0x70a08231"],
      }],
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
    expect(compareLiveExecutionGraphToApprovedManifest([exact], approved, {
      ...state,
      poolStates: { [POOL]: { factoryAddress: FACTORY, token0: TOKEN0, token1: TOKEN1, fee: 2500, tickSpacing: 200 } },
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

  it("normalizes the exact affected token implementation without widening delegatecall authority", () => {
    const candidate = expectCandidateSuccess(buildTrustManifestCandidateFromReport(exactTokenImplementationReport(), {
      expiresAt: "2026-08-04T00:00:00.000Z",
      operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID,
    }));
    const record = candidate.manifest.records.find((entry) => sameTestAddress(entry.address, TOKEN_IMPL))!;

    expect(record.approvedSelectors).toEqual(["0x23b872dd", "0x70a08231", "0xa9059cbb", "0xdd62ed3e"]);
    expect(record.delegatecallContexts).toHaveLength(2);
    for (const context of record.delegatecallContexts) {
      expect(context.targetAddress).toBe(TOKEN_IMPL);
      expect(context.targetCodeHash).toBe(EXACT_TOKEN_IMPL_HASH);
      expect(context.selectors).toEqual([...new Set(context.selectors)].sort());
    }
    expect(record.delegatecallContexts.map((context) => context.parentAddress).sort()).toEqual([
      EXACT_TOKEN_PROXY_B,
      EXACT_TOKEN_PROXY_A,
    ].sort());
    expect(record.callerConstraints).toHaveLength(8);
    expect(record.delegatecallContexts.flatMap((context) => context.selectors)).toHaveLength(8);
  });

  it("merges repeated selectors in the same delegatecall context", () => {
    const candidate = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231"),
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231"),
    ]), { expiresAt: "2026-08-04T00:00:00.000Z", operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID }));
    const record = candidate.manifest.records.find((entry) => sameTestAddress(entry.address, TOKEN_IMPL))!;

    expect(record.delegatecallContexts).toHaveLength(1);
    expect(record.delegatecallContexts[0]!.selectors).toEqual(["0x70a08231"]);
  });

  it("preserves the same selector under two distinct delegatecall parents", () => {
    const candidate = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231"),
      tokenImplCall(EXACT_TOKEN_PROXY_B, "0x70a08231"),
    ]), { expiresAt: "2026-08-04T00:00:00.000Z", operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID }));
    const record = candidate.manifest.records.find((entry) => sameTestAddress(entry.address, TOKEN_IMPL))!;

    expect(record.delegatecallContexts).toHaveLength(2);
    expect(record.delegatecallContexts.every((context) => context.selectors.join(",") === "0x70a08231")).toBe(true);
  });

  it("does not introduce a parent-selector Cartesian product", () => {
    const candidate = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231"),
      tokenImplCall(EXACT_TOKEN_PROXY_B, "0xa9059cbb"),
    ]), { expiresAt: "2026-08-04T00:00:00.000Z", operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID }));
    const record = candidate.manifest.records.find((entry) => sameTestAddress(entry.address, TOKEN_IMPL))!;
    const byParent = new Map(record.delegatecallContexts.map((context) => [context.parentAddress, context.selectors]));

    expect(byParent.get(EXACT_TOKEN_PROXY_A)).toEqual(["0x70a08231"]);
    expect(byParent.get(EXACT_TOKEN_PROXY_B)).toEqual(["0xa9059cbb"]);
  });

  it("normalizes case-equivalent selectors before fingerprinting", () => {
    const lower = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0xabcdef01"),
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0xabcdef01"),
    ]), { expiresAt: "2026-08-04T00:00:00.000Z", operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID }));
    const mixed = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0xABCDEF01"),
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0xabcdef01"),
    ]), { expiresAt: "2026-08-04T00:00:00.000Z", operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID }));

    expect(mixed.manifestFingerprint).toBe(lower.manifestFingerprint);
    expect(canonicalizeJson(mixed.manifest)).toBe(canonicalizeJson(lower.manifest));
  });

  it("fails structured candidate generation on conflicting duplicate source records", () => {
    const report = tokenImplementationReport([tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231")]);
    report.candidateRecords.push({
      ...report.candidateRecords.find((record) => sameTestAddress(record.normalizedAddress, TOKEN_IMPL))!,
      runtimeCodeHash: OTHER_HASH,
    });

    const candidate = buildTrustManifestCandidateFromReport(report, { expiresAt: "2026-08-04T00:00:00.000Z" });
    expect(candidate).toMatchObject({
      candidateGenerationStatus: "FAILED",
      automaticExecutionEligible: false,
      operatorSignatureRequired: true,
    });
    expect(candidate.validationErrors.join("|")).toContain("RECORD_CONFLICT_RUNTIME_CODE_HASH");
  });

  it("round-trips generated candidates through the strict production exporter helpers", () => {
    const candidate = expectCandidateSuccess(buildTrustManifestCandidateFromReport(exactTokenImplementationReport(), {
      expiresAt: "2026-08-04T00:00:00.000Z",
      operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID,
    }));
    const materials = exportOfflineSigningMaterials(JSON.stringify(candidate.manifest));

    expect(materials.manifestFingerprint).toBe(candidate.manifestFingerprint);
    expect(candidate.manifest.manifestId).toBe(manifestIdFor(candidate.manifest));
    expect(materials.canonicalManifestJson).toBe(canonicalizeJson(candidate.manifest));
    expect(materials.signingFrame.equals(signatureFrameForManifest(candidate.manifest))).toBe(true);
    expect(materials.signingFrame.length).toBeGreaterThan(0);
  });

  it("keeps strict external rejection for injected duplicate delegatecall selectors", () => {
    const candidate = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231"),
    ]), { expiresAt: "2026-08-04T00:00:00.000Z", operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID }));
    const manifest = structuredClone(candidate.manifest);
    const record = manifest.records.find((entry) => sameTestAddress(entry.address, TOKEN_IMPL))!;
    record.delegatecallContexts[0]!.selectors = ["0x70a08231", "0x70a08231"];

    expect(() => exportOfflineSigningMaterials(JSON.stringify(manifest))).toThrow("DELEGATECALL_SELECTORS_DUPLICATE");
  });

  it("is deterministic across differently ordered historical observations", () => {
    const calls = [
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x70a08231"),
      tokenImplCall(EXACT_TOKEN_PROXY_B, "0xa9059cbb"),
      tokenImplCall(EXACT_TOKEN_PROXY_A, "0x23b872dd"),
      tokenImplCall(EXACT_TOKEN_PROXY_B, "0xdd62ed3e"),
    ];
    const first = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport(calls), {
      expiresAt: "2026-08-04T00:00:00.000Z",
      operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID,
    }));
    const second = expectCandidateSuccess(buildTrustManifestCandidateFromReport(tokenImplementationReport([...calls].reverse()), {
      expiresAt: "2026-08-04T00:00:00.000Z",
      operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID,
    }));

    expect(second.manifestFingerprint).toBe(first.manifestFingerprint);
    expect(canonicalizeJson(second.manifest)).toBe(canonicalizeJson(first.manifest));
  });

  it("blocks manifest candidates when the source runtime trust report is not complete", () => {
    const report = mockTrustReport();
    const unresolvedRecord = {
      ...report.candidateRecords[0]!,
      confidence: "unresolved" as const,
      unresolvedReasons: ["unknown_contract_classification"],
    };
    const partialReport: ExecutionTrustReport = {
      ...report,
      candidateRecords: [unresolvedRecord],
      routeTrustBundle: {
        ...report.routeTrustBundle,
        requiredRecords: [],
        unresolvedRecords: [unresolvedRecord],
      },
      graphPolicy: {
        ...report.graphPolicy,
        graphStatus: "PARTIALLY_CLASSIFIED",
        unresolvedCallCount: 1,
        unresolvedStateChangingCallCount: 1,
        unknownSelectorCount: 1,
      },
      trustClosureStatus: "PARTIAL",
      trustClosure: {
        unresolvedCallCount: 1,
        unresolvedStateChangingCallCount: 1,
        unresolvedDelegatecallCount: 0,
        unknownSelectorCount: 1,
        prohibitedOperationCount: 0,
        candidateRecordCount: 1,
        unresolvedRecordCount: 1,
      },
    };

    const candidate = buildTrustManifestCandidateFromReport(partialReport, {
      expiresAt: "2026-08-04T00:00:00.000Z",
      operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID,
    });

    expect(candidate.candidateGenerationStatus).toBe("FAILED");
    expect(candidate.automaticExecutionEligible).toBe(false);
    expect(candidate.operatorSignatureRequired).toBe(true);
    expect(candidate.validationErrors).toEqual(expect.arrayContaining([
      "TRUST_CLOSURE_PARTIAL",
      "UNRESOLVED_REQUIRED_RECORDS:1",
      "UNRESOLVED_STATE_CHANGING_CALLS:1",
    ]));
  });

  it("generates unsigned candidates and registers read-only manifest tools", () => {
    const candidate = buildTrustManifestCandidateFromReport(mockTrustReport(), {
      expiresAtBlock: "27195600",
      expiresAt: "2026-08-04T00:00:00.000Z",
      operatorPublicKeyId: TEST_OPERATOR_PUBLIC_KEY_ID,
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

function mockTrustReportWithTwoRecords(reversed: boolean): ExecutionTrustReport {
  const report = mockTrustReport();
  const secondRecord = {
    ...report.candidateRecords[0]!,
    address: OTHER,
    normalizedAddress: OTHER,
    runtimeCodeHash: OTHER_HASH,
    observedSelectors: ["0x12345678"],
    callerConstraints: [{ caller: MANAGER, selector: "0x12345678", callType: "CALL" }],
  };
  const secondCall = {
    ...report.normalizedCalls[0]!,
    to: OTHER,
    selector: "0x12345678",
    runtimeCodeHash: OTHER_HASH,
  };
  const candidateRecords = reversed
    ? [secondRecord, report.candidateRecords[0]!]
    : [report.candidateRecords[0]!, secondRecord];
  const normalizedCalls = reversed
    ? [secondCall, report.normalizedCalls[0]!]
    : [report.normalizedCalls[0]!, secondCall];
  return {
    ...report,
    normalizedCalls,
    candidateRecords,
  };
}
