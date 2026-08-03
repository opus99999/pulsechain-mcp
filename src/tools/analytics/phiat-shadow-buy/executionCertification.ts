import {
  decodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import type { AppConfig } from "../../../types.js";
import { PULSECHAIN_CHAIN_ID } from "../../../constants.js";
import {
  ERC20_APPROVE_SELECTOR,
  ERC20_BALANCE_OF_SELECTOR,
  ERC20_TRANSFER_FROM_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  PITEAS_CHANGED_SWAP_MANAGER_TOPIC,
  PITEAS_CONTRACTS_REPOSITORY,
  PITEAS_CONTRACTS_SOURCE_COMMIT,
  PITEAS_OFFICIAL_DOCUMENTED_SWAP_MANAGER,
  PITEAS_PIT_ERC20_SOURCE_HASH,
  PITEAS_ROUTER,
  PITEAS_ROUTER_COMPILER_VERSION,
  PITEAS_ROUTER_EVM_VERSION,
  PITEAS_ROUTER_OPTIMIZER_ENABLED,
  PITEAS_ROUTER_OPTIMIZER_RUNS,
  PITEAS_ROUTER_SOURCE_HASH,
  PITEAS_ROUTER_VERIFIED_ABI_FINGERPRINT,
  PITEAS_ROUTER_VERIFIED_SOURCE_FINGERPRINT,
  PITEAS_SWAP_MANAGER_INTERFACE_SOURCE_HASH,
  PITEAS_SWAP_MANAGER_SELECTOR,
  piteasRouterSwapAbi,
} from "./constants.js";
import type {
  ActiveSwapManager,
  ExecutionGraphCall,
  ExecutionLayerCertification,
  ExecutionTraceStatus,
  ExecutionTrustRecord,
  InternalApprovalEvidence,
  RouteDataCertification,
  RouterCallSequenceEntry,
  RouterManagerBinding,
  SourceEvidence,
  SwapManagerIntegrity,
  TraceBackend,
} from "./types.js";
import type {
  LiveChainStateForManifest,
  LiveExecutionGraphCall,
  ManifestComparisonResult,
  VerifiedTrustManifest,
} from "./executionTrustManifest.js";
import { errorMessage, fingerprint, sameAddress } from "./inputNormalization.js";
import {
  decodeAddressFromStorageWord,
  deriveSwapManagerStorageLayout,
} from "./storageLayout.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const BEACON_IMPLEMENTATION_SELECTOR = "0x5c60da1b";
const MAX_UINT256_TEXT = ((1n << 256n) - 1n).toString();

interface RpcSnapshot {
  rpcUrl: string;
  blockHex: string | null;
  blockNumber: string | null;
  ok: boolean;
  error: string | null;
}

interface TraceNode {
  type?: string;
  from?: string;
  to?: string;
  input?: string;
  output?: string;
  value?: string | number;
  gasUsed?: string | number;
  error?: string;
  revertReason?: string;
  calls?: TraceNode[];
}

interface CodeHashEvidence {
  hash: string | null;
  agreement: "agrees" | "disagrees" | "single_rpc" | "unavailable";
  empty: boolean | null;
}

export function routerSourceEvidence(): SourceEvidence {
  return {
    sourceRepository: PITEAS_CONTRACTS_REPOSITORY,
    sourceCommit: PITEAS_CONTRACTS_SOURCE_COMMIT,
    routerSourceHash: PITEAS_ROUTER_SOURCE_HASH,
    pitErc20SourceHash: PITEAS_PIT_ERC20_SOURCE_HASH,
    swapManagerInterfaceSourceHash: PITEAS_SWAP_MANAGER_INTERFACE_SOURCE_HASH,
    compilerVersion: PITEAS_ROUTER_COMPILER_VERSION,
    optimizerSettings: {
      enabled: PITEAS_ROUTER_OPTIMIZER_ENABLED,
      runs: PITEAS_ROUTER_OPTIMIZER_RUNS,
      evmVersion: PITEAS_ROUTER_EVM_VERSION,
    },
    verifiedAbiFingerprint: PITEAS_ROUTER_VERIFIED_ABI_FINGERPRINT,
    verifiedSourceFingerprint: PITEAS_ROUTER_VERIFIED_SOURCE_FINGERPRINT,
    verifiedAbiFragment: JSON.stringify(piteasRouterSwapAbi[0]),
    verifiedRouterAbi: true,
    verifiedRouterSource: true,
    bytecodeReproduction: {
      attempted: false,
      matched: null,
      reason:
        "Compiler metadata is pinned from BlockScout; local bytecode reproduction is not attempted inside the read-only certificate path.",
    },
  };
}

export async function certifyPiteasExecutionLayer(
  config: AppConfig,
  args: {
    walletAddress: string;
    router: string;
    tokenIn: string;
    tokenOut: string;
    recipient: string;
    amountInRaw: string;
    calldata: string;
    valueWei: string;
    routeDataRaw: string | null;
    referenceBeforeBlock: string | null;
    candidateQuoteBlock: string | null;
    referenceAfterBlock: string | null;
    approvedTrustRecords: ExecutionTrustRecord[];
    signedExecutionTrustManifest?: unknown;
    routerCodeHash?: string | null;
  },
): Promise<ExecutionLayerCertification> {
  const sourceEvidence = routerSourceEvidence();
  const block = await commonBlock(config);
  const activeSwapManager = await discoverActiveSwapManager(config, block.blockHex);
  const swapManagerIntegrity = await readSwapManagerIntegrity(
    config,
    activeSwapManager.address,
    block.blockHex,
    args.approvedTrustRecords,
  );
  const routeData = certifyRouteData(args.routeDataRaw, swapManagerIntegrity);
  const trace = await traceExactPreparedTransaction(config, {
    from: args.walletAddress,
    to: args.router,
    data: args.calldata,
    value: args.valueWei,
    blockHex: block.blockHex,
  });
  const binding = await buildRouterManagerBinding(config, {
    router: args.router,
    manager: activeSwapManager.address,
    quoteAfterBlock: args.referenceAfterBlock,
    certificationBlock: block.blockNumber,
    certificationBlockHex: block.blockHex,
    traceBlock: trace.backend.blockNumber,
  });

  const graph = trace.root
    ? await analyzeExecutionTrace(config, {
        traceRoot: trace.root,
        blockHex: block.blockHex,
        walletAddress: args.walletAddress,
        router: args.router,
        activeSwapManager: activeSwapManager.address,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        recipient: args.recipient,
        amountInRaw: args.amountInRaw,
        managerTrusted: swapManagerIntegrity.trusted,
        approvedTrustRecords: args.approvedTrustRecords,
      })
    : emptyGraphAnalysis(trace.status);

  const baseFailureCodes = failureCodesFor({
    activeSwapManager,
    swapManagerIntegrity,
    binding,
    traceStatus: trace.status,
    graph,
  });
  const manifestGate = await evaluateTrustManifestGate(config, {
    signedExecutionTrustManifest: args.signedExecutionTrustManifest,
    block,
    router: args.router,
    routerCodeHash: args.routerCodeHash ?? null,
    activeSwapManager,
    swapManagerIntegrity,
    graph,
  });
  const failureCodes = finalFailureCodesFor(baseFailureCodes, manifestGate);
  const validationErrors = failureCodes.map(messageForFailureCode);
  const trustRecordFingerprint = fingerprint({
    router: args.router.toLowerCase(),
    activeSwapManager: activeSwapManager.address?.toLowerCase() ?? null,
    managerCodeHash: routeData.managerCodeHash,
    approvedTargets: graph.approvedTargets,
  });
  const managerIntegrityStatus =
    activeSwapManager.address === null || swapManagerIntegrity.address === null
      ? "UNAVAILABLE"
      : swapManagerIntegrity.codeHashAgreement === "disagrees"
        ? "FAILED"
        : swapManagerIntegrity.codeHashesByRpc.every((row) => row.runtimeCodeHash === null)
          ? "UNAVAILABLE"
        : "PASSED";
  const executionGraphStatus = graph.executionGraphStatus;
  const automaticExecutionEligible =
    failureCodes.length === 0 &&
    managerIntegrityStatus === "PASSED" &&
    trace.status === "PASSED" &&
    trace.backend.stateOverridesUsed === false &&
    manifestGate.executionAuthority === "VALID" &&
    manifestGate.comparison?.automaticExecutionEligible === true &&
    graph.prohibitedOperations.length === 0 &&
    !hasStateChangingManifestGap(graph);

  return {
    sourceEvidence,
    managerIntegrityStatus,
    executionTraceStatus: trace.status,
    executionGraphStatus,
    activeSwapManager,
    swapManagerIntegrity,
    routerManagerBinding: {
      quoteBeforeBlock: args.referenceBeforeBlock,
      candidateQuoteBlock: args.candidateQuoteBlock,
      quoteAfterBlock: args.referenceAfterBlock,
      certificationBlock: binding.certificationBlock,
      simulationBlock: trace.backend.blockNumber,
      managerChangedSinceQuote: binding.managerChangedSinceQuote,
      routerCodeChangedSinceQuote: binding.routerCodeChangedSinceQuote,
      managerCodeChangedSinceQuote: binding.managerCodeChangedSinceQuote,
    },
    routeData,
    traceBackend: trace.backend,
    routerCallSequence: graph.routerCallSequence,
    executionGraph: graph.executionGraph,
    approvedTargets: graph.approvedTargets,
    unresolvedTargets: graph.unresolvedTargets,
    prohibitedOperations: graph.prohibitedOperations,
    internalApprovals: graph.internalApprovals,
    managerChangedSinceQuote: binding.managerChangedSinceQuote,
    trustRecordFingerprint,
    automaticExecutionEligible,
    trustManifestVerification: manifestGate.verification,
    trustManifestComparison: manifestGate.comparison,
    executionAuthority: manifestGate.executionAuthority,
    failureCodes,
    validationErrors,
    warnings: warningsFor(activeSwapManager, swapManagerIntegrity, routeData, trace.status),
  };
}

interface TrustManifestGate {
  verification: VerifiedTrustManifest | null;
  comparison: ManifestComparisonResult | null;
  executionAuthority: ExecutionLayerCertification["executionAuthority"];
}

async function evaluateTrustManifestGate(
  config: AppConfig,
  args: {
    signedExecutionTrustManifest?: unknown;
    block: RpcSnapshot;
    router: string;
    routerCodeHash: string | null;
    activeSwapManager: ActiveSwapManager;
    swapManagerIntegrity: SwapManagerIntegrity;
    graph: Awaited<ReturnType<typeof analyzeExecutionTrace>>;
  },
): Promise<TrustManifestGate> {
  if (args.signedExecutionTrustManifest === undefined) {
    return { verification: null, comparison: null, executionAuthority: "MISSING" };
  }
  const {
    compareLiveExecutionGraphToApprovedManifest,
    verifySignedTrustManifest,
  } = await import("./executionTrustManifest.js");
  const verification = verifySignedTrustManifest(args.signedExecutionTrustManifest, {
    pinnedPublicKeys: config.phiatTrustOperatorPublicKeys ?? {},
    currentBlock: args.block.blockNumber,
  });
  if (verification.executionAuthority !== "VALID") {
    return { verification, comparison: null, executionAuthority: verification.executionAuthority };
  }
  const liveGraph = liveGraphCallsForManifest(args.graph);
  const implementationRelationships = await readManifestImplementationRelationships(
    config,
    verification,
    args.block.blockHex,
  );
  const poolStates = await readManifestPoolStates(config, verification, args.block.blockHex);
  const managerRuntimeHash = firstNonNull(
    args.swapManagerIntegrity.codeHashesByRpc.map((row) => row.runtimeCodeHash),
  );
  const liveChainState: LiveChainStateForManifest = {
    chainId: PULSECHAIN_CHAIN_ID,
    router: {
      address: args.router,
      runtimeCodeHash: args.routerCodeHash,
    },
    swapManager: {
      address: args.activeSwapManager.address,
      runtimeCodeHash: managerRuntimeHash,
      storageSlot: args.activeSwapManager.storageSlot,
      storageAddress: args.activeSwapManager.address,
      managerChangeEventBlock: args.activeSwapManager.latestChangeEvent?.blockNumber ?? null,
    },
    currentBlock: args.block.blockNumber,
    currentTime: new Date().toISOString(),
    targetCodeHashes: targetCodeHashesForManifest(args.graph),
    implementationRelationships,
    poolStates,
  };
  return {
    verification,
    comparison: compareLiveExecutionGraphToApprovedManifest(liveGraph, verification, liveChainState),
    executionAuthority: verification.executionAuthority,
  };
}

function liveGraphCallsForManifest(
  graph: Awaited<ReturnType<typeof analyzeExecutionTrace>>,
): LiveExecutionGraphCall[] {
  return [
    ...graph.routerCallSequence.map((call) => ({
      from: call.from,
      to: call.to,
      callType: call.callType,
      selector: call.selector,
      codeHash: call.codeHash,
      parentAddress: call.from,
    })),
    ...graph.executionGraph.map((call) => ({
      tracePath: call.depth.toString(),
      from: call.from,
      to: call.to,
      callType: call.callType,
      selector: call.selector,
      codeHash: call.codeHash,
      parentAddress: call.from,
    })),
  ];
}

function targetCodeHashesForManifest(
  graph: Awaited<ReturnType<typeof analyzeExecutionTrace>>,
): Record<string, string | null> {
  const hashes: Record<string, string | null> = {};
  for (const call of liveGraphCallsForManifest(graph)) {
    if (call.to) hashes[call.to.toLowerCase()] = call.codeHash ?? call.runtimeCodeHash ?? null;
  }
  return hashes;
}

async function readManifestImplementationRelationships(
  config: AppConfig,
  verification: VerifiedTrustManifest,
  blockHex: string | null,
): Promise<NonNullable<LiveChainStateForManifest["implementationRelationships"]>> {
  const manifest = verification.manifest;
  if (!manifest) return [];
  const proxyAddresses = uniqueStrings(
    manifest.records
      .filter((record) => record.role === "TOKEN_IMPLEMENTATION")
      .flatMap((record) => record.parentConstraints.map((constraint) => constraint.parentAddress))
      .filter((value): value is string => typeof value === "string" && isAddressLike(value.toLowerCase()))
      .map((value) => value.toLowerCase()),
  );
  return Promise.all(
    proxyAddresses.map(async (proxyAddress) => {
      const implementationAddress = await readProxyImplementationSlot(
        config,
        proxyAddress,
        blockHex,
        EIP1967_IMPLEMENTATION_SLOT,
      );
      const implementationHash = implementationAddress
        ? await readCodeHashAcrossRpcs(config, implementationAddress, blockHex ?? "latest")
        : null;
      return {
        proxyAddress,
        implementationAddress,
        implementationCodeHash: implementationHash?.hash ?? null,
      };
    }),
  );
}

async function readManifestPoolStates(
  config: AppConfig,
  verification: VerifiedTrustManifest,
  blockHex: string | null,
): Promise<NonNullable<LiveChainStateForManifest["poolStates"]>> {
  const manifest = verification.manifest;
  if (!manifest) return {};
  const poolRecords = manifest.records.filter((record) => record.factoryConstraints || record.tokenConstraints);
  const entries = await Promise.all(
    poolRecords.map(async (record) => [
      record.address,
      await readPoolState(config, record.address, blockHex),
    ] as const),
  );
  return Object.fromEntries(entries);
}

async function readPoolState(
  config: AppConfig,
  pool: string,
  blockHex: string | null,
): Promise<NonNullable<LiveChainStateForManifest["poolStates"]>[string]> {
  const [factoryAddress, token0, token1, fee, tickSpacing] = await Promise.all([
    readAddressFunction(config, pool, "0xc45a0155", blockHex),
    readAddressFunction(config, pool, "0x0dfe1681", blockHex),
    readAddressFunction(config, pool, "0xd21220a7", blockHex),
    readUintFunction(config, pool, "0xddca3f43", blockHex),
    readUintFunction(config, pool, "0xd0c93a7c", blockHex),
  ]);
  return { factoryAddress, token0, token1, fee, tickSpacing };
}

async function readAddressFunction(
  config: AppConfig,
  to: string,
  selector: string,
  blockHex: string | null,
): Promise<string | null> {
  const value = await readCallAcrossRpcs(config, to, selector, blockHex);
  return value ? decodePackedAddress(value, 0)?.toLowerCase() ?? null : null;
}

async function readUintFunction(
  config: AppConfig,
  to: string,
  selector: string,
  blockHex: string | null,
): Promise<number | null> {
  const value = await readCallAcrossRpcs(config, to, selector, blockHex);
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  try {
    const decoded = BigInt(value);
    return decoded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decoded) : null;
  } catch {
    return null;
  }
}

async function readCallAcrossRpcs(
  config: AppConfig,
  to: string,
  data: string,
  blockHex: string | null,
): Promise<string | null> {
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const result = await rpcCall<string>(
        rpcUrl,
        "eth_call",
        [{ to, data }, blockHex ?? "latest"],
        config.httpTimeoutMs,
      );
      if (/^0x[0-9a-fA-F]*$/.test(result) && result.length >= 66) return result;
    } catch {
      continue;
    }
  }
  return null;
}

function finalFailureCodesFor(baseFailureCodes: string[], manifestGate: TrustManifestGate): string[] {
  const codes = manifestGate.comparison?.automaticExecutionEligible === true
    ? baseFailureCodes.filter((code) => code !== "EXECUTION_GRAPH_UNRESOLVED")
    : [...baseFailureCodes];
  if (manifestGate.executionAuthority === "MISSING") codes.push("TRUST_MANIFEST_REQUIRED");
  if (manifestGate.executionAuthority === "INVALID") codes.push("TRUST_MANIFEST_INVALID");
  if (manifestGate.executionAuthority === "EXPIRED") codes.push("TRUST_MANIFEST_EXPIRED");
  if (manifestGate.executionAuthority === "STATE_MISMATCH") codes.push("TRUST_MANIFEST_STATE_MISMATCH");
  if (
    manifestGate.executionAuthority === "VALID" &&
    manifestGate.comparison?.automaticExecutionEligible !== true
  ) {
    codes.push("TRUST_MANIFEST_GRAPH_MISMATCH");
  }
  return uniqueStrings(codes);
}

function hasStateChangingManifestGap(
  graph: Awaited<ReturnType<typeof analyzeExecutionTrace>>,
): boolean {
  return graph.executionGraph.length === 0;
}

export async function discoverActiveSwapManager(
  config: AppConfig,
  blockHex: string | null,
): Promise<ActiveSwapManager> {
  const urls = rpcUrls(config);
  const layout = deriveSwapManagerStorageLayout();
  const storageEvidence = await Promise.all(
    urls.map(async (rpcUrl) => readManagerStorageAt(rpcUrl, blockHex, config.httpTimeoutMs, layout)),
  );
  const decoded = storageEvidence
    .filter((row) => row.ok && row.decodedAddress && row.zeroAddress !== true && row.decodeError === null)
    .map((row) => row.decodedAddress!);
  const storageAddress = agreedAddress(decoded);
  const storageAgreement = storageAgreementFor(storageEvidence);
  const latestChangeEvent = await latestSwapManagerEvent(config, blockHex);
  const storageEventAgreement =
    storageAddress === null
      ? "storage_unavailable"
      : latestChangeEvent?.address
        ? sameAddress(storageAddress, latestChangeEvent.address)
          ? "agrees"
          : "disagrees"
        : "event_unavailable";
  const documentationStatus =
    storageAddress === null
      ? "UNAVAILABLE"
      : sameAddress(storageAddress, PITEAS_OFFICIAL_DOCUMENTED_SWAP_MANAGER)
        ? "MATCHES_CHAIN"
        : "STALE";
  const confidence =
    storageAddress === null
      ? "unavailable"
      : storageAgreement === "agrees" && storageEventAgreement === "agrees"
        ? "high"
        : storageAgreement === "agrees"
          ? "medium"
          : "low";
  return {
    address: storageAddress,
    blockNumber: firstNonNull(storageEvidence.map((row) => row.blockNumber)),
    storageSlot: layout.slot,
    storageOffsetBytes: layout.offsetBytes,
    storageWidthBytes: layout.widthBytes,
    swapManagerStorageLayout: layout,
    storageEvidenceByRpc: storageEvidence,
    latestChangeEvent,
    storageAgreement,
    storageEventAgreement,
    officialDocumentationMatch:
      storageAddress === null
        ? null
        : sameAddress(storageAddress, PITEAS_OFFICIAL_DOCUMENTED_SWAP_MANAGER),
    documentationStatus,
    confidence,
  };
}

export async function readSwapManagerIntegrity(
  config: AppConfig,
  manager: string | null,
  blockHex: string | null,
  approvedTrustRecords: ExecutionTrustRecord[],
): Promise<SwapManagerIntegrity> {
  if (manager === null) return emptySwapManagerIntegrity(null);
  const codeHashesByRpc = await Promise.all(
    rpcUrls(config).map(async (rpcUrl) => readCodeAt(rpcUrl, manager, blockHex, config.httpTimeoutMs)),
  );
  const codeHashAgreement = codeAgreement(codeHashesByRpc.map((row) => row.runtimeCodeHash));
  const managerCodeHash = firstNonNull(codeHashesByRpc.map((row) => row.runtimeCodeHash));
  const proxy = await detectProxy(config, manager, blockHex, codeHashesByRpc);
  const source = await fetchSourceEvidence(config.explorerApi, manager, config.httpTimeoutMs);
  const trusted = trustRecordsFor(
    approvedTrustRecords,
    manager,
    "SwapManager",
    managerCodeHash,
    proxy.implementationAddress,
    firstNonNull(proxy.implementationCodeHashesByRpc.map((row) => row.runtimeCodeHash)),
    null,
  ).length > 0;
  return {
    address: manager,
    codeHashesByRpc,
    codeHashAgreement,
    proxyType: proxy.proxyType,
    proxyDetection: proxy.proxyDetection,
    executionOpcodeObservations: opcodeObservations(firstNonNull(codeHashesByRpc.map((row) => row.bytecode))),
    implementationAddress: proxy.implementationAddress,
    implementationCodeHashesByRpc: proxy.implementationCodeHashesByRpc,
    sourceVerificationStatus: source.status,
    abiFingerprint: source.abiFingerprint,
    sourceFingerprint: source.sourceFingerprint,
    operatorApprovalRequired: !trusted,
    trustRecordFingerprint: fingerprint({
      address: manager.toLowerCase(),
      runtimeCodeHash: managerCodeHash,
      implementationAddress: proxy.implementationAddress?.toLowerCase() ?? null,
      implementationCodeHash: firstNonNull(proxy.implementationCodeHashesByRpc.map((row) => row.runtimeCodeHash)),
      sourceFingerprint: source.sourceFingerprint,
      approvedTrustRecords,
    }),
    trusted,
  };
}

function certifyRouteData(
  routeDataRaw: string | null,
  manager: SwapManagerIntegrity,
): RouteDataCertification {
  const managerCodeHash = firstNonNull(manager.codeHashesByRpc.map((row) => row.runtimeCodeHash));
  return {
    rawFingerprint: routeDataRaw ? fingerprint(routeDataRaw) : null,
    length: routeDataRaw ? Math.max(0, (routeDataRaw.length - 2) / 2) : 0,
    managerCodeHash,
    decoderVersion: "opaque-manager-bound-v1",
    decoderMatchesManagerHash: false,
    authoritativeFields: [],
    heuristicObservations: routeDataRaw ? heuristicAddresses(routeDataRaw) : [],
  };
}

async function buildRouterManagerBinding(
  config: AppConfig,
  args: {
    router: string;
    manager: string | null;
    quoteAfterBlock: string | null;
    certificationBlock: string | null;
    certificationBlockHex: string | null;
    traceBlock: string | null;
  },
): Promise<RouterManagerBinding> {
  if (!args.quoteAfterBlock || !args.certificationBlockHex || !args.manager) {
    return {
      quoteBeforeBlock: null,
      candidateQuoteBlock: null,
      quoteAfterBlock: args.quoteAfterBlock,
      certificationBlock: args.certificationBlock,
      simulationBlock: args.traceBlock,
      managerChangedSinceQuote: null,
      routerCodeChangedSinceQuote: null,
      managerCodeChangedSinceQuote: null,
    };
  }
  const quoteBlockHex = bigintToHex(BigInt(args.quoteAfterBlock));
  const [managerAtQuote, routerQuote, routerNow, managerQuote, managerNow] = await Promise.all([
    readManagerAcrossRpcs(config, quoteBlockHex),
    readCodeHashAcrossRpcs(config, args.router, quoteBlockHex),
    readCodeHashAcrossRpcs(config, args.router, args.certificationBlockHex),
    readCodeHashAcrossRpcs(config, args.manager, quoteBlockHex),
    readCodeHashAcrossRpcs(config, args.manager, args.certificationBlockHex),
  ]);
  return {
    quoteBeforeBlock: null,
    candidateQuoteBlock: null,
    quoteAfterBlock: args.quoteAfterBlock,
    certificationBlock: args.certificationBlock,
    simulationBlock: args.traceBlock,
    managerChangedSinceQuote:
      managerAtQuote === null ? null : !sameAddress(managerAtQuote, args.manager),
    routerCodeChangedSinceQuote: changedHash(routerQuote, routerNow),
    managerCodeChangedSinceQuote: changedHash(managerQuote, managerNow),
  };
}

async function traceExactPreparedTransaction(
  config: AppConfig,
  args: {
    from: string;
    to: string;
    data: string;
    value: string;
    blockHex: string | null;
  },
): Promise<{
  status: ExecutionTraceStatus;
  backend: TraceBackend;
  root: TraceNode | null;
}> {
  const tx = {
    from: args.from,
    to: args.to,
    data: args.data,
    value: bigintToHex(BigInt(args.value)),
  };
  const block = args.blockHex ?? "latest";
  let lastFailure: string | null = null;
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const result = await rpcCall<TraceNode>(
        rpcUrl,
        "debug_traceCall",
        [tx, block, { tracer: "callTracer" }],
        config.httpTimeoutMs,
      );
      return {
        status: traceStatus(result),
        backend: {
          rpc: rpcUrl,
          method: "debug_traceCall",
          blockNumber: hexBlockToString(args.blockHex),
          stateOverridesUsed: false,
          supported: true,
          failureReason: null,
        },
        root: result,
      };
    } catch (err) {
      lastFailure = errorMessage(err);
      if (!isUnsupportedTraceError(lastFailure)) continue;
    }
    try {
      const result = await rpcCall<unknown>(
        rpcUrl,
        "trace_call",
        [tx, ["trace"], block],
        config.httpTimeoutMs,
      );
      const root = traceCallToCallTracer(result, args);
      return {
        status: traceStatus(root),
        backend: {
          rpc: rpcUrl,
          method: "trace_call",
          blockNumber: hexBlockToString(args.blockHex),
          stateOverridesUsed: false,
          supported: true,
          failureReason: null,
        },
        root,
      };
    } catch (err) {
      lastFailure = errorMessage(err);
    }
  }
  return {
    status: isStateInsufficient(lastFailure) ? "STATE_INSUFFICIENT" : "UNSUPPORTED",
    backend: {
      rpc: null,
      method: null,
      blockNumber: hexBlockToString(args.blockHex),
      stateOverridesUsed: false,
      supported: false,
      failureReason: lastFailure ?? "No configured RPC supports debug_traceCall or trace_call",
    },
    root: null,
  };
}

async function analyzeExecutionTrace(
  config: AppConfig,
  args: {
    traceRoot: TraceNode;
    blockHex: string | null;
    walletAddress: string;
    router: string;
    activeSwapManager: string | null;
    tokenIn: string;
    tokenOut: string;
    recipient: string;
    amountInRaw: string;
    managerTrusted: boolean;
    approvedTrustRecords: ExecutionTrustRecord[];
  },
): Promise<{
  executionGraphStatus: ExecutionLayerCertification["executionGraphStatus"];
  routerCallSequence: RouterCallSequenceEntry[];
  executionGraph: ExecutionGraphCall[];
  approvedTargets: ExecutionTrustRecord[];
  unresolvedTargets: string[];
  prohibitedOperations: string[];
  internalApprovals: InternalApprovalEvidence[];
}> {
  const nodes = flattenCalls(args.traceRoot);
  const approvalSpenders = nodes
    .filter((node) => selectorOf(node.input) === ERC20_APPROVE_SELECTOR)
    .map((node) => decodeApprove(node.input).spender)
    .filter((value): value is string => typeof value === "string" && isAddressLike(value));
  const addresses = uniqueStrings(
    nodes
      .flatMap((node) => [node.from, node.to])
      .concat(approvalSpenders)
      .filter((value): value is string => typeof value === "string" && isAddressLike(value)),
  );
  const codeHashes = await readCodeHashes(config, addresses, args.blockHex);
  const routerChildren = args.traceRoot.calls ?? [];
  const routerCallSequence = routerChildren.map((node) =>
    classifyRouterCall(node, args, codeHashes.get(lower(node.to))),
  );
  const managerRoot = routerChildren.find((node) =>
    args.activeSwapManager !== null &&
    sameAddress(node.to, args.activeSwapManager) &&
    selectorOf(node.input) === PITEAS_SWAP_MANAGER_SELECTOR,
  );
  const managerNodes = managerRoot ? flattenChildren(managerRoot) : [];
  const executionGraph = managerNodes.map((node) =>
    graphCall(node, args, codeHashes.get(lower(node.to))),
  );
  const internalApprovals = nodes
    .filter((node) => selectorOf(node.input) === ERC20_APPROVE_SELECTOR)
    .map((node) => approvalEvidence(node, args, codeHashes));
  const prohibitedOperations = prohibitedOps(nodes);
  const unresolvedTargets = unresolvedFor({
    args,
    routerCallSequence,
    executionGraph,
    managerRoot,
    internalApprovals,
    prohibitedOperations,
  });
  const approvedTargets = matchedTrustRecords(
    args.approvedTrustRecords,
    executionGraph,
    routerCallSequence,
    codeHashes,
  );
  const executionGraphStatus =
    prohibitedOperations.length > 0
      ? "FAILED"
      : unresolvedTargets.length === 0 && executionGraph.length > 0
        ? "RESOLVED"
        : executionGraph.length > 0
          ? "PARTIALLY_RESOLVED"
          : "UNRESOLVED";
  return {
    executionGraphStatus,
    routerCallSequence,
    executionGraph,
    approvedTargets,
    unresolvedTargets,
    prohibitedOperations,
    internalApprovals,
  };
}

function emptyGraphAnalysis(
  traceStatus: ExecutionTraceStatus,
): Awaited<ReturnType<typeof analyzeExecutionTrace>> {
  return {
    executionGraphStatus: traceStatus === "NOT_RUN" ? "NOT_EVALUATED" : "UNRESOLVED",
    routerCallSequence: [],
    executionGraph: [],
    approvedTargets: [],
    unresolvedTargets: ["execution_trace_unavailable"],
    prohibitedOperations: [],
    internalApprovals: [],
  };
}

function classifyRouterCall(
  node: TraceNode,
  args: {
    walletAddress: string;
    activeSwapManager: string | null;
    tokenIn: string;
    tokenOut: string;
    recipient: string;
    amountInRaw: string;
  },
  codeHash: CodeHashEvidence | undefined,
): RouterCallSequenceEntry {
  const selector = selectorOf(node.input);
  let classification = "unexpected_router_call";
  if (sameAddress(node.to, args.tokenIn) && selector === ERC20_TRANSFER_FROM_SELECTOR) {
    const transfer = decodeTransferFrom(node.input);
    classification =
      sameAddress(transfer.from, args.walletAddress) &&
      sameAddress(transfer.to, args.activeSwapManager) &&
      transfer.amount === args.amountInRaw
        ? "source_token_transfer_from_wallet_to_swap_manager"
        : "source_token_transfer_from_mismatch";
  } else if (sameAddress(node.to, args.activeSwapManager) && selector === PITEAS_SWAP_MANAGER_SELECTOR) {
    classification = "router_call_to_active_swap_manager";
  } else if (sameAddress(node.to, args.tokenOut) && selector === ERC20_BALANCE_OF_SELECTOR) {
    classification = "destination_token_balance_check";
  } else if (sameAddress(node.to, args.tokenOut) && selector === ERC20_TRANSFER_SELECTOR) {
    const transfer = decodeTransfer(node.input);
    classification = sameAddress(transfer.to, args.recipient)
      ? "destination_token_transfer_to_recipient"
      : "destination_token_transfer_recipient_mismatch";
  }
  return {
    callType: node.type ?? "CALL",
    from: node.from ?? null,
    to: node.to ?? null,
    selector,
    value: valueToString(node.value),
    success: node.error ? false : true,
    gasUsed: valueToString(node.gasUsed),
    codeHash: codeHash?.hash ?? null,
    classification,
  };
}

function graphCall(
  node: TraceNode,
  args: {
    managerTrusted: boolean;
    approvedTrustRecords: ExecutionTrustRecord[];
  },
  codeHash: CodeHashEvidence | undefined,
): ExecutionGraphCall {
  const selector = selectorOf(node.input);
  const classification = classifyProtocolCall(node);
  const trustStatus =
    prohibitedCall(node)
      ? "prohibited"
      : trustRecordsFor(args.approvedTrustRecords, node.to ?? null, roleForClassification(classification), codeHash?.hash ?? null, null, null, selector).length > 0
        ? "trusted"
        : classification === "erc20_balance_check"
          ? "trusted"
          : "unresolved";
  return {
    depth: Number((node as { depth?: number }).depth ?? 0),
    callType: node.type ?? "CALL",
    from: node.from ?? null,
    to: node.to ?? null,
    selector,
    value: valueToString(node.value),
    inputFingerprint: node.input ? fingerprint(node.input) : null,
    outputFingerprint: node.output ? fingerprint(node.output) : null,
    success: node.error ? false : true,
    revertReason: node.revertReason ?? node.error ?? null,
    codeHash: codeHash?.hash ?? null,
    protocolClassification: classification,
    trustStatus: args.managerTrusted && trustStatus === "trusted" ? "trusted" : trustStatus,
  };
}

function approvalEvidence(
  node: TraceNode,
  args: {
    walletAddress: string;
    activeSwapManager: string | null;
    managerTrusted: boolean;
    approvedTrustRecords: ExecutionTrustRecord[];
  },
  codeHashes: Map<string, CodeHashEvidence>,
): InternalApprovalEvidence {
  const approval = decodeApprove(node.input);
  const walletApproval = sameAddress(node.from, args.walletAddress);
  const managerInternalApproval = sameAddress(node.from, args.activeSwapManager);
  const spenderCodeHash = codeHashes.get(lower(approval.spender))?.hash ?? null;
  const trustedSpender =
    trustRecordsFor(
      args.approvedTrustRecords,
      approval.spender,
      "ProtocolRouter",
      spenderCodeHash,
      null,
      null,
      ERC20_APPROVE_SELECTOR,
    ).length > 0;
  const approvedByPolicy =
    walletApproval
      ? approval.amount !== MAX_UINT256_TEXT
      : managerInternalApproval && args.managerTrusted && trustedSpender;
  return {
    token: node.to ?? null,
    ownerContext: walletApproval ? "wallet" : managerInternalApproval ? "swap_manager" : "other_contract",
    spender: approval.spender,
    amount: approval.amount,
    initiatedBy: node.from ?? null,
    walletApproval,
    managerInternalApproval,
    approvedByPolicy,
  };
}

function failureCodesFor(args: {
  activeSwapManager: ActiveSwapManager;
  swapManagerIntegrity: SwapManagerIntegrity;
  binding: RouterManagerBinding;
  traceStatus: ExecutionTraceStatus;
  graph: Awaited<ReturnType<typeof analyzeExecutionTrace>>;
}): string[] {
  const codes: string[] = [];
  const decodedStorageRows = args.activeSwapManager.storageEvidenceByRpc.filter(
    (row) => row.ok && row.decodedAddress && row.zeroAddress !== true && row.decodeError === null,
  );
  if (args.activeSwapManager.swapManagerStorageLayout.status !== "DERIVED") {
    codes.push("SWAP_MANAGER_LAYOUT_UNAVAILABLE");
  }
  if (args.activeSwapManager.storageEvidenceByRpc.some((row) => row.decodeError !== null)) {
    codes.push("SWAP_MANAGER_ADDRESS_INVALID");
  }
  if (args.activeSwapManager.storageEvidenceByRpc.some((row) => row.zeroAddress === true)) {
    codes.push("SWAP_MANAGER_ZERO_ADDRESS");
  }
  if (args.activeSwapManager.address === null) codes.push("SWAP_MANAGER_UNAVAILABLE");
  if (
    args.activeSwapManager.address !== null &&
    (args.activeSwapManager.storageAgreement !== "agrees" || decodedStorageRows.length < 2)
  ) {
    codes.push("SWAP_MANAGER_STORAGE_DISAGREEMENT");
  }
  if (args.activeSwapManager.storageEventAgreement === "event_unavailable") {
    codes.push("SWAP_MANAGER_EVENT_UNAVAILABLE");
  }
  if (args.activeSwapManager.storageEventAgreement === "disagrees") codes.push("SWAP_MANAGER_EVENT_MISMATCH");
  if (args.binding.managerChangedSinceQuote === true) codes.push("SWAP_MANAGER_CHANGED");
  if (args.binding.routerCodeChangedSinceQuote === true) codes.push("ROUTER_CODE_CHANGED");
  if (args.binding.managerCodeChangedSinceQuote === true) codes.push("SWAP_MANAGER_CODE_CHANGED");
  if (args.swapManagerIntegrity.codeHashAgreement === "disagrees") {
    codes.push("SWAP_MANAGER_CODE_HASH_DISAGREEMENT");
  }
  if (args.swapManagerIntegrity.address !== null && args.swapManagerIntegrity.codeHashesByRpc.every((row) => row.runtimeCodeHash === null)) {
    codes.push("SWAP_MANAGER_BYTECODE_UNAVAILABLE");
  }
  if (args.traceStatus === "UNSUPPORTED") codes.push("EXECUTION_TRACE_UNSUPPORTED");
  if (args.traceStatus === "STATE_INSUFFICIENT") codes.push("EXECUTION_TRACE_STATE_INSUFFICIENT");
  if (args.traceStatus === "FAILED") codes.push("EXECUTION_TRACE_FAILED");
  if (args.graph.executionGraphStatus === "UNRESOLVED" || args.graph.executionGraphStatus === "PARTIALLY_RESOLVED") {
    codes.push("EXECUTION_GRAPH_UNRESOLVED");
  }
  if (args.graph.executionGraphStatus === "FAILED") codes.push("EXECUTION_GRAPH_FAILED");
  for (const op of args.graph.prohibitedOperations) codes.push(op);
  return [...new Set(codes)];
}

function messageForFailureCode(code: string): string {
  const messages: Record<string, string> = {
    SWAP_MANAGER_LAYOUT_UNAVAILABLE: "Verified SwapManager storage layout was unavailable.",
    SWAP_MANAGER_ADDRESS_INVALID: "SwapManager address could not be decoded from the verified storage byte range.",
    SWAP_MANAGER_ZERO_ADDRESS: "SwapManager storage decoded to the zero address.",
    SWAP_MANAGER_UNAVAILABLE: "Active Piteas SwapManager could not be proven from router storage.",
    SWAP_MANAGER_STORAGE_DISAGREEMENT: "Active SwapManager storage was not confirmed by at least two matching RPC reads.",
    SWAP_MANAGER_EVENT_UNAVAILABLE: "ChangedSwapManager event evidence was unavailable for independent manager confirmation.",
    SWAP_MANAGER_EVENT_MISMATCH: "Latest ChangedSwapManager event does not match router storage.",
    SWAP_MANAGER_CHANGED: "Active SwapManager changed between quote certification and simulation.",
    ROUTER_CODE_CHANGED: "PiteasRouter bytecode changed between quote certification and simulation.",
    SWAP_MANAGER_CODE_CHANGED: "SwapManager bytecode changed between quote certification and simulation.",
    SWAP_MANAGER_CODE_HASH_DISAGREEMENT: "SwapManager runtime code hash disagrees across RPCs.",
    SWAP_MANAGER_BYTECODE_UNAVAILABLE: "SwapManager bytecode is empty or unavailable.",
    EXECUTION_TRACE_UNSUPPORTED: "No configured RPC supports debug_traceCall or trace_call.",
    EXECUTION_TRACE_STATE_INSUFFICIENT: "Trace backend could not evaluate the wallet's actual state.",
    EXECUTION_TRACE_FAILED: "Exact prepared transaction trace failed.",
    EXECUTION_GRAPH_UNRESOLVED: "Full state-changing execution graph is not resolved.",
    EXECUTION_GRAPH_FAILED: "Execution graph contains a prohibited operation.",
    TRUST_MANIFEST_REQUIRED: "Signed execution trust manifest is required for automatic execution eligibility.",
    TRUST_MANIFEST_INVALID: "Signed execution trust manifest is invalid or was not signed by a pinned operator key.",
    TRUST_MANIFEST_EXPIRED: "Signed execution trust manifest has expired.",
    TRUST_MANIFEST_STATE_MISMATCH: "Signed execution trust manifest does not match the required chain, router, manager, graph, or bundle state.",
    TRUST_MANIFEST_GRAPH_MISMATCH: "Live execution graph does not exactly match the signed trust manifest constraints.",
  };
  return messages[code] ?? code;
}

function warningsFor(
  activeSwapManager: ActiveSwapManager,
  manager: SwapManagerIntegrity,
  routeData: RouteDataCertification,
  traceStatus: ExecutionTraceStatus,
): string[] {
  const warnings: string[] = [];
  if (activeSwapManager.documentationStatus === "STALE") {
    warnings.push("Official Piteas documentation lists a stale SwapManager address; current router storage and event evidence are authoritative.");
  }
  if (manager.operatorApprovalRequired) {
    warnings.push("Active SwapManager code hash requires structured operator approval before automation.");
  }
  if (!routeData.decoderMatchesManagerHash) {
    warnings.push("Piteas route bytes are treated as manager-specific opaque data.");
  }
  if (traceStatus === "UNSUPPORTED") {
    warnings.push("Use a trace-capable RPC or local PulseChain fork node to resolve the internal execution graph.");
  }
  return warnings;
}

async function commonBlock(config: AppConfig): Promise<RpcSnapshot> {
  const snapshots = await Promise.all(
    rpcUrls(config).map(async (rpcUrl) => {
      try {
        const blockHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", [], config.httpTimeoutMs);
        return {
          rpcUrl,
          blockHex,
          blockNumber: BigInt(blockHex).toString(),
          ok: true,
          error: null,
        };
      } catch (err) {
        return {
          rpcUrl,
          blockHex: null,
          blockNumber: null,
          ok: false,
          error: errorMessage(err),
        };
      }
    }),
  );
  const ok = snapshots.filter((snapshot) => snapshot.ok && snapshot.blockHex);
  if (ok.length === 0) return snapshots[0] ?? { rpcUrl: "", blockHex: null, blockNumber: null, ok: false, error: "no rpc urls" };
  const min = ok.map((snapshot) => BigInt(snapshot.blockHex!)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!;
  return {
    rpcUrl: ok[0]!.rpcUrl,
    blockHex: bigintToHex(min),
    blockNumber: min.toString(),
    ok: true,
    error: null,
  };
}

async function readManagerStorageAt(
  rpcUrl: string,
  blockHex: string | null,
  timeoutMs: number,
  layout = deriveSwapManagerStorageLayout(),
): Promise<ActiveSwapManager["storageEvidenceByRpc"][number]> {
  try {
    const block = blockHex ?? "latest";
    const storageWord = await rpcCall<string>(
      rpcUrl,
      "eth_getStorageAt",
      [PITEAS_ROUTER, layout.slot, block],
      timeoutMs,
    );
    const decoded = decodeAddressFromStorageWord({
      storageWord,
      slot: layout.slot,
      offsetBytes: layout.offsetBytes,
      widthBytes: layout.widthBytes,
    });
    return {
      rpcUrl,
      ok: true,
      blockNumber: hexBlockToString(blockHex),
      storageWord,
      decodedAddress: decoded.normalizedAddress,
      zeroAddress: decoded.zeroAddress,
      decodeError: decoded.error,
      error: null,
    };
  } catch (err) {
    return {
      rpcUrl,
      ok: false,
      blockNumber: hexBlockToString(blockHex),
      storageWord: null,
      decodedAddress: null,
      zeroAddress: null,
      decodeError: null,
      error: errorMessage(err),
    };
  }
}

function storageAgreementFor(
  rows: ActiveSwapManager["storageEvidenceByRpc"],
): ActiveSwapManager["storageAgreement"] {
  const decoded = rows
    .filter((row) => row.ok && row.decodedAddress && row.zeroAddress !== true && row.decodeError === null)
    .map((row) => row.decodedAddress!.toLowerCase());
  if (decoded.length === 0) return "unavailable";
  if (new Set(decoded).size !== 1) return "disagrees";
  return decoded.length > 1 ? "agrees" : "single_rpc";
}

async function latestSwapManagerEvent(
  config: AppConfig,
  blockHex: string | null,
): Promise<ActiveSwapManager["latestChangeEvent"]> {
  const params = {
    address: PITEAS_ROUTER,
    fromBlock: "0x0",
    toBlock: blockHex ?? "latest",
    topics: [PITEAS_CHANGED_SWAP_MANAGER_TOPIC],
  };
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const logs = await rpcCall<Array<{
        address?: string;
        topics?: string[];
        blockNumber?: string;
        transactionHash?: string;
        logIndex?: string;
      }>>(rpcUrl, "eth_getLogs", [params], config.httpTimeoutMs);
      const latest = logs
        .filter((log) => sameAddress(log.address, PITEAS_ROUTER) && log.topics?.[1])
        .sort((a, b) => {
          const blockA = BigInt(a.blockNumber ?? "0x0");
          const blockB = BigInt(b.blockNumber ?? "0x0");
          if (blockA !== blockB) return blockA > blockB ? -1 : 1;
          return BigInt(a.logIndex ?? "0x0") > BigInt(b.logIndex ?? "0x0") ? -1 : 1;
        })[0];
      if (!latest) continue;
      return {
        address: topicToAddress(latest.topics![1]!),
        blockNumber: latest.blockNumber ? BigInt(latest.blockNumber).toString() : null,
        transactionHash: latest.transactionHash ?? null,
        logIndex: latest.logIndex ? BigInt(latest.logIndex).toString() : null,
        topic: PITEAS_CHANGED_SWAP_MANAGER_TOPIC,
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function readCodeAt(
  rpcUrl: string,
  address: string,
  blockHex: string | null,
  timeoutMs: number,
): Promise<SwapManagerIntegrity["codeHashesByRpc"][number]> {
  try {
    const block = blockHex ?? "latest";
    const bytecode = await rpcCall<string>(rpcUrl, "eth_getCode", [address, block], timeoutMs);
    return {
      rpcUrl,
      ok: true,
      blockNumber: hexBlockToString(blockHex),
      bytecode,
      runtimeCodeHash: bytecode === "0x" ? null : keccak256(bytecode as Hex),
      bytecodeLength: bytecode === "0x" ? 0 : (bytecode.length - 2) / 2,
      error: null,
    };
  } catch (err) {
    return {
      rpcUrl,
      ok: false,
      blockNumber: hexBlockToString(blockHex),
      bytecode: null,
      runtimeCodeHash: null,
      bytecodeLength: null,
      error: errorMessage(err),
    };
  }
}

async function detectProxy(
  config: AppConfig,
  manager: string,
  blockHex: string | null,
  managerCode: SwapManagerIntegrity["codeHashesByRpc"],
): Promise<Pick<SwapManagerIntegrity, "proxyType" | "proxyDetection" | "implementationAddress" | "implementationCodeHashesByRpc">> {
  const bytecode = firstNonNull(managerCode.map((row) => row.bytecode));
  const minimal = bytecode ? implementationFromMinimalProxy(bytecode) : null;
  const eip1967 = await readProxyImplementationSlot(config, manager, blockHex, EIP1967_IMPLEMENTATION_SLOT);
  const beacon = await readProxyImplementationSlot(config, manager, blockHex, EIP1967_BEACON_SLOT);
  const beaconImplementation = beacon
    ? await readBeaconImplementation(config, beacon, blockHex)
    : null;
  const implementationAddress = eip1967 ?? beaconImplementation ?? minimal;
  const proxyType =
    eip1967
      ? "eip1967"
      : beaconImplementation
        ? "eip1967_beacon"
        : minimal
          ? "eip1167"
          : "none";
  const proxyDetection = {
    proxyType:
      proxyType === "eip1967"
        ? "EIP1967_IMPLEMENTATION"
        : proxyType === "eip1967_beacon"
          ? "EIP1967_BEACON"
          : proxyType === "eip1167"
            ? "EIP1167_MINIMAL"
            : "NONE_DETECTED",
    implementationAddress,
    beaconAddress: beacon,
    evidence: {
      eip1967ImplementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      eip1967ImplementationAddress: eip1967,
      eip1967BeaconSlot: EIP1967_BEACON_SLOT,
      eip1967BeaconAddress: beacon,
      beaconImplementationAddress: beaconImplementation,
      minimalProxyImplementationAddress: minimal,
      bytecodeLength: bytecode === null ? null : bytecode === "0x" ? 0 : (bytecode.length - 2) / 2,
    },
  } as const;
  const implementationCodeHashesByRpc = implementationAddress
    ? await Promise.all(
        rpcUrls(config).map(async (rpcUrl) => {
          const code = await readCodeAt(rpcUrl, implementationAddress, blockHex, config.httpTimeoutMs);
          return {
            rpcUrl: code.rpcUrl,
            ok: code.ok,
            blockNumber: code.blockNumber,
            runtimeCodeHash: code.runtimeCodeHash,
            bytecodeLength: code.bytecodeLength,
            error: code.error,
          };
        }),
      )
    : [];
  return { proxyType, proxyDetection, implementationAddress, implementationCodeHashesByRpc };
}

function opcodeObservations(bytecode: string | null): SwapManagerIntegrity["executionOpcodeObservations"] {
  if (bytecode === null || !/^0x[0-9a-fA-F]*$/.test(bytecode)) {
    return {
      containsDelegatecallOpcode: null,
      containsCallcodeOpcode: null,
      containsCreateOpcode: null,
      containsCreate2Opcode: null,
      containsSelfdestructOpcode: null,
    };
  }
  const bytes = new Set(bytecode.slice(2).toLowerCase().match(/.{2}/g) ?? []);
  return {
    containsDelegatecallOpcode: bytes.has("f4"),
    containsCallcodeOpcode: bytes.has("f2"),
    containsCreateOpcode: bytes.has("f0"),
    containsCreate2Opcode: bytes.has("f5"),
    containsSelfdestructOpcode: bytes.has("ff"),
  };
}

async function readProxyImplementationSlot(
  config: AppConfig,
  address: string,
  blockHex: string | null,
  slot: string,
): Promise<string | null> {
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const storage = await rpcCall<string>(
        rpcUrl,
        "eth_getStorageAt",
        [address, slot, blockHex ?? "latest"],
        config.httpTimeoutMs,
      );
      const decoded = decodePackedAddress(storage, 0);
      if (decoded) return decoded;
    } catch {
      continue;
    }
  }
  return null;
}

async function readBeaconImplementation(
  config: AppConfig,
  beacon: string,
  blockHex: string | null,
): Promise<string | null> {
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const result = await rpcCall<string>(
        rpcUrl,
        "eth_call",
        [{ to: beacon, data: BEACON_IMPLEMENTATION_SELECTOR }, blockHex ?? "latest"],
        config.httpTimeoutMs,
      );
      const decoded = decodePackedAddress(result, 0);
      if (decoded) return decoded;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchSourceEvidence(
  explorerApi: string,
  address: string,
  timeoutMs: number,
): Promise<{ status: SwapManagerIntegrity["sourceVerificationStatus"]; abiFingerprint: string | null; sourceFingerprint: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [abiResponse, sourceResponse] = await Promise.all([
      fetch(`${explorerApi}?module=contract&action=getabi&address=${address}`, { signal: controller.signal }),
      fetch(`${explorerApi}?module=contract&action=getsourcecode&address=${address}`, { signal: controller.signal }),
    ]);
    const abi = await abiResponse.json() as { status?: string; result?: unknown };
    const source = await sourceResponse.json() as { status?: string; result?: unknown };
    const abiText = typeof abi.result === "string" ? abi.result : null;
    const sourceText = JSON.stringify(source.result ?? null);
    return {
      status: abi.status === "1" || source.status === "1" ? "verified" : "unverified",
      abiFingerprint: abiText ? fingerprint(abiText) : null,
      sourceFingerprint: sourceText ? fingerprint(sourceText) : null,
    };
  } catch {
    return { status: "unavailable", abiFingerprint: null, sourceFingerprint: null };
  } finally {
    clearTimeout(timer);
  }
}

async function readManagerAcrossRpcs(config: AppConfig, blockHex: string): Promise<string | null> {
  const rows = await Promise.all(
    rpcUrls(config).map((rpcUrl) => readManagerStorageAt(rpcUrl, blockHex, config.httpTimeoutMs)),
  );
  return agreedAddress(rows.filter((row) => row.ok && row.decodedAddress).map((row) => row.decodedAddress!));
}

async function readCodeHashAcrossRpcs(
  config: AppConfig,
  address: string,
  blockHex: string,
): Promise<CodeHashEvidence> {
  const rows = await Promise.all(
    rpcUrls(config).map((rpcUrl) => readCodeAt(rpcUrl, address, blockHex, config.httpTimeoutMs)),
  );
  return {
    hash: firstNonNull(rows.map((row) => row.runtimeCodeHash)),
    agreement: codeAgreement(rows.map((row) => row.runtimeCodeHash)),
    empty: rows.some((row) => row.ok) ? rows.every((row) => row.bytecode === "0x") : null,
  };
}

async function readCodeHashes(
  config: AppConfig,
  addresses: string[],
  blockHex: string | null,
): Promise<Map<string, CodeHashEvidence>> {
  const out = new Map<string, CodeHashEvidence>();
  await Promise.all(
    addresses.map(async (address) => {
      out.set(lower(address), await readCodeHashAcrossRpcs(config, address, blockHex ?? "latest"));
    }),
  );
  return out;
}

function traceCallToCallTracer(
  result: unknown,
  args: { from: string; to: string; data: string; value: string },
): TraceNode {
  if (!Array.isArray(result)) {
    return {
      type: "CALL",
      from: args.from,
      to: args.to,
      input: args.data,
      value: args.value,
      error: "trace_call result shape is unsupported",
    };
  }
  return {
    type: "CALL",
    from: args.from,
    to: args.to,
    input: args.data,
    value: args.value,
    calls: result.map((entry) => traceCallEntry(entry)),
  };
}

function traceCallEntry(entry: unknown): TraceNode {
  const value = entry as {
    action?: { callType?: string; from?: string; to?: string; input?: string; value?: string };
    result?: { output?: string; gasUsed?: string };
    error?: string;
  };
  return {
    type: value.action?.callType?.toUpperCase() ?? "CALL",
    from: value.action?.from,
    to: value.action?.to,
    input: value.action?.input,
    output: value.result?.output,
    value: value.action?.value,
    gasUsed: value.result?.gasUsed,
    error: value.error,
  };
}

function flattenCalls(root: TraceNode): TraceNode[] {
  const out: TraceNode[] = [];
  const walk = (node: TraceNode, depth: number) => {
    out.push({ ...node, depth } as TraceNode);
    for (const child of node.calls ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

function flattenChildren(root: TraceNode): TraceNode[] {
  return (root.calls ?? []).flatMap((child) => flattenCalls(child));
}

function unresolvedFor(args: {
  args: {
    activeSwapManager: string | null;
    managerTrusted: boolean;
  };
  routerCallSequence: RouterCallSequenceEntry[];
  executionGraph: ExecutionGraphCall[];
  managerRoot: TraceNode | undefined;
  internalApprovals: InternalApprovalEvidence[];
  prohibitedOperations: string[];
}): string[] {
  const unresolved: string[] = [];
  if (!args.managerRoot) unresolved.push("router_to_active_swap_manager_call");
  for (const call of args.routerCallSequence) {
    if (call.classification === "unexpected_router_call") {
      unresolved.push(`unexpected_router_target:${call.to ?? "unknown"}`);
    }
    if (call.classification.endsWith("_mismatch")) unresolved.push(call.classification);
  }
  for (const call of args.executionGraph) {
    if (call.trustStatus === "unresolved") unresolved.push(`unresolved_protocol_target:${call.to ?? "unknown"}:${call.selector ?? "unknown"}`);
    if ((call.callType === "DELEGATECALL" || call.callType === "CALLCODE") && call.trustStatus !== "trusted") {
      unresolved.push(`unknown_delegatecall_target:${call.to ?? "unknown"}`);
    }
  }
  for (const approval of args.internalApprovals) {
    if (!approval.approvedByPolicy) {
      unresolved.push(approval.walletApproval ? "wallet_unlimited_or_unapproved_approval" : "manager_internal_approval_unapproved");
    }
  }
  if (!args.args.managerTrusted) unresolved.push("swap_manager_not_operator_approved");
  if (args.prohibitedOperations.length > 0) unresolved.push("prohibited_operation_present");
  return [...new Set(unresolved)];
}

function prohibitedOps(nodes: TraceNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const type = (node.type ?? "").toUpperCase();
    if (type === "CREATE") out.push("CREATE_REJECTED");
    if (type === "CREATE2") out.push("CREATE2_REJECTED");
    if (type === "SELFDESTRUCT") out.push("SELFDESTRUCT_REJECTED");
    if (type === "CALLCODE") out.push("CALLCODE_REJECTED");
  }
  return [...new Set(out)];
}

function prohibitedCall(node: TraceNode): boolean {
  const type = (node.type ?? "").toUpperCase();
  return type === "CREATE" || type === "CREATE2" || type === "SELFDESTRUCT" || type === "CALLCODE";
}

function classifyProtocolCall(node: TraceNode): string {
  const selector = selectorOf(node.input);
  if (selector === ERC20_APPROVE_SELECTOR) return "erc20_approval";
  if (selector === ERC20_TRANSFER_SELECTOR) return "erc20_transfer";
  if (selector === ERC20_TRANSFER_FROM_SELECTOR) return "erc20_transfer_from";
  if (selector === ERC20_BALANCE_OF_SELECTOR) return "erc20_balance_check";
  if ((node.type ?? "").toUpperCase() === "DELEGATECALL") return "delegatecall";
  if ((node.type ?? "").toUpperCase() === "STATICCALL") return "staticcall_unknown";
  return selector ? "state_changing_selector_unknown" : "native_or_empty_call";
}

function roleForClassification(classification: string): ExecutionTrustRecord["role"] {
  if (classification.startsWith("erc20_")) return "Token";
  if (classification === "delegatecall") return "DelegatecallTarget";
  return "ProtocolRouter";
}

function matchedTrustRecords(
  records: ExecutionTrustRecord[],
  graph: ExecutionGraphCall[],
  routerCalls: RouterCallSequenceEntry[],
  codeHashes: Map<string, CodeHashEvidence>,
): ExecutionTrustRecord[] {
  const matched: ExecutionTrustRecord[] = [];
  for (const call of [...graph, ...routerCalls]) {
    const hash = codeHashes.get(lower(call.to))?.hash ?? call.codeHash;
    matched.push(
      ...trustRecordsFor(records, call.to, roleForClassification(call instanceof Object && "protocolClassification" in call ? call.protocolClassification : ""), hash, null, null, call.selector),
    );
  }
  const seen = new Set<string>();
  return matched.filter((record) => {
    const key = `${record.role}:${record.address.toLowerCase()}:${record.runtimeCodeHash.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function trustRecordsFor(
  records: ExecutionTrustRecord[],
  address: string | null | undefined,
  role: ExecutionTrustRecord["role"] | null,
  runtimeCodeHash: string | null | undefined,
  implementationAddress: string | null | undefined,
  implementationCodeHash: string | null | undefined,
  selector: string | null | undefined,
): ExecutionTrustRecord[] {
  void records;
  void address;
  void role;
  void runtimeCodeHash;
  void implementationAddress;
  void implementationCodeHash;
  void selector;
  // Legacy operatorApproved records are retained as inert evidence only. Execution
  // authority now derives exclusively from a pinned, signed trust manifest.
  return [];
}

function decodeTransferFrom(input: string | undefined): { from: string | null; to: string | null; amount: string | null } {
  try {
    const [from, to, amount] = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      payloadData(input) as Hex,
    );
    return { from, to, amount: amount.toString() };
  } catch {
    return { from: null, to: null, amount: null };
  }
}

function decodeTransfer(input: string | undefined): { to: string | null; amount: string | null } {
  try {
    const [to, amount] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      payloadData(input) as Hex,
    );
    return { to, amount: amount.toString() };
  } catch {
    return { to: null, amount: null };
  }
}

function decodeApprove(input: string | undefined): { spender: string | null; amount: string | null } {
  try {
    const [spender, amount] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      payloadData(input) as Hex,
    );
    return { spender, amount: amount.toString() };
  } catch {
    return { spender: null, amount: null };
  }
}

function payloadData(input: string | undefined): string {
  return typeof input === "string" && input.length >= 10 ? `0x${input.slice(10)}` : "0x";
}

function traceStatus(root: TraceNode): ExecutionTraceStatus {
  if (root.error || root.revertReason) {
    const msg = `${root.error ?? ""} ${root.revertReason ?? ""}`.toLowerCase();
    return isStateInsufficient(msg) ? "STATE_INSUFFICIENT" : "FAILED";
  }
  return "PASSED";
}

function isUnsupportedTraceError(message: string): boolean {
  return /method .*not found|unsupported|not available|does not exist|the method .* does not exist/i.test(message);
}

function isStateInsufficient(message: string | null): boolean {
  return typeof message === "string" && /insufficient funds|allowance|balance|execution reverted/i.test(message);
}

function heuristicAddresses(data: string): RouteDataCertification["heuristicObservations"] {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) return [];
  const out: RouteDataCertification["heuristicObservations"] = [];
  const hex = data.slice(2);
  for (let offset = 0; offset + 64 <= hex.length; offset += 64) {
    const word = hex.slice(offset, offset + 64);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) continue;
    const address = `0x${word.slice(24)}`;
    if (/^0x0{40}$/i.test(address)) continue;
    out.push({ kind: "word_aligned_address", value: address, source: `routeData.word[${offset / 64}]` });
  }
  return out;
}

function decodePackedAddress(storageWord: string, offsetBytesFromRight: number): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(storageWord)) return null;
  const hex = storageWord.slice(2);
  const end = (32 - offsetBytesFromRight) * 2;
  const start = end - 40;
  const address = `0x${hex.slice(start, end)}`;
  return /^0x0{40}$/i.test(address) ? null : address;
}

function implementationFromMinimalProxy(bytecode: string): string | null {
  const lowerBytecode = bytecode.toLowerCase();
  if (!lowerBytecode.startsWith(EIP1167_PREFIX) || !lowerBytecode.endsWith(EIP1167_SUFFIX)) return null;
  const start = EIP1167_PREFIX.length;
  return `0x${lowerBytecode.slice(start, start + 40)}`;
}

function topicToAddress(topic: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}`;
}

function codeAgreement(values: Array<string | null>): CodeHashEvidence["agreement"] {
  const present = values.filter((value): value is string => Boolean(value));
  if (present.length === 0) return "unavailable";
  if (present.length === 1) return "single_rpc";
  return new Set(present.map((value) => value.toLowerCase())).size === 1 ? "agrees" : "disagrees";
}

function changedHash(a: CodeHashEvidence, b: CodeHashEvidence): boolean | null {
  if (!a.hash || !b.hash) return null;
  return a.hash.toLowerCase() !== b.hash.toLowerCase();
}

function agreedAddress(values: string[]): string | null {
  if (values.length === 0) return null;
  const unique = uniqueStrings(values.map(lower));
  return unique.length === 1 ? values[0]! : null;
}

function selectorOf(input: string | undefined): string | null {
  return typeof input === "string" && /^0x[0-9a-fA-F]{8}/.test(input) ? input.slice(0, 10).toLowerCase() : null;
}

function valueToString(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") return value.toString();
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value).toString();
  return value;
}

function bigintToHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function hexBlockToString(blockHex: string | null): string | null {
  if (!blockHex || blockHex === "latest") return null;
  try {
    return BigInt(blockHex).toString();
  } catch {
    return null;
  }
}

function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function rpcUrls(config: AppConfig): string[] {
  return config.rpcUrls.length > 0 ? config.rpcUrls : [config.rpcUrl];
}

function isAddressLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function lower(value: string | null | undefined): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function emptySwapManagerIntegrity(address: string | null): SwapManagerIntegrity {
  return {
    address,
    codeHashesByRpc: [],
    codeHashAgreement: "unavailable",
    proxyType: "unavailable",
    proxyDetection: {
      proxyType: "UNKNOWN_PATTERN",
      implementationAddress: null,
      beaconAddress: null,
      evidence: { reason: "SwapManager integrity was not evaluated." },
    },
    executionOpcodeObservations: {
      containsDelegatecallOpcode: null,
      containsCallcodeOpcode: null,
      containsCreateOpcode: null,
      containsCreate2Opcode: null,
      containsSelfdestructOpcode: null,
    },
    implementationAddress: null,
    implementationCodeHashesByRpc: [],
    sourceVerificationStatus: "unavailable",
    abiFingerprint: null,
    sourceFingerprint: null,
    operatorApprovalRequired: true,
    trustRecordFingerprint: null,
    trusted: false,
  };
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (body.error) throw new Error(body.error.message ?? `${method} RPC error`);
    if (body.result === undefined) throw new Error(`${method} result missing`);
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}
