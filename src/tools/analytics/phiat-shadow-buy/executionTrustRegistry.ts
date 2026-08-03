import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toFunctionSelector,
  type Hex,
} from "viem";
import type { AppConfig } from "../../../types.js";
import { PULSECHAIN_CHAIN_ID, WPLS_ADDRESS } from "../../../constants.js";
import { ok } from "../../../utils/result.js";
import { registerTool } from "../../define.js";
import {
  ERC20_ALLOWANCE_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  ERC20_BALANCE_OF_SELECTOR,
  ERC20_TRANSFER_FROM_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  PITEAS_ROUTER,
} from "./constants.js";
import { discoverActiveSwapManager } from "./executionCertification.js";
import { errorMessage, fingerprint, sameAddress } from "./inputNormalization.js";

export type ExecutionTargetClassification =
  | "PITEAS_ROUTER"
  | "PITEAS_SWAP_MANAGER"
  | "TOKEN_PROXY"
  | "TOKEN_IMPLEMENTATION"
  | "ERC20_DIRECT"
  | "WRAPPED_NATIVE_TOKEN"
  | "PROTOCOL_ROUTER"
  | "PROTOCOL_FACTORY"
  | "V2_POOL"
  | "V3_POOL"
  | "STABLE_POOL"
  | "WEIGHTED_POOL"
  | "PROTOCOL_LIBRARY"
  | "UNKNOWN_CONTRACT"
  | "EOA"
  | "PRECOMPILE";

export type TrustCandidateConfidence = "high" | "medium" | "low" | "unresolved";
export type GraphStatus =
  | "FULLY_CLASSIFIED"
  | "PARTIALLY_CLASSIFIED"
  | "UNRESOLVED"
  | "FAILED";

export interface TraceNode {
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

export interface NormalizedExecutionCall {
  tracePath: string;
  depth: number;
  callType: string;
  from: string | null;
  to: string | null;
  selector: string | null;
  valueWei: string | null;
  inputFingerprint: string | null;
  outputFingerprint: string | null;
  success: boolean;
  gasUsed: string | null;
  parentAddress: string | null;
  parentRole: ExecutionTargetClassification | null;
  runtimeCodeHash: string | null;
  blockNumber: string;
  classification: ExecutionTargetClassification;
  unresolvedReasons: string[];
}

export interface RuntimeCodeEvidence {
  address: string;
  normalizedAddress: string;
  blockNumber: string;
  runtimeCodeHash: string | null;
  codeHashAgreement: "agrees" | "disagrees" | "single_rpc" | "unavailable";
  rpcSamples: Array<{
    rpcUrl: string;
    ok: boolean;
    runtimeCodeHash: string | null;
    bytecodeLength: number | null;
    error: string | null;
  }>;
  bytecodeLength: number | null;
  bytecode: string | null;
}

export interface SourceLookupEvidence {
  address: string;
  verified: boolean;
  contractName: string | null;
  abiSelectors: string[];
  sourceFingerprint: string | null;
  error: string | null;
}

export interface ProxyRelationshipEvidence {
  proxyType: "NONE_DETECTED" | "EIP1967_IMPLEMENTATION" | "EIP1967_BEACON" | "EIP1167_MINIMAL" | "TRACE_BOUND_TOKEN_PROXY" | "UNKNOWN_PATTERN";
  implementationAddress: string | null;
  implementationCodeHash: string | null;
  evidence: Record<string, unknown>;
}

export interface PoolProvenanceEvidence {
  protocol: string | null;
  poolType: ExecutionTargetClassification | null;
  factoryAddress: string | null;
  factoryCodeHash: string | null;
  token0: string | null;
  token1: string | null;
  assets: string[];
  factoryVerified: boolean;
  selectorAppropriate: boolean;
  evidence: Record<string, unknown>;
  unresolvedReasons: string[];
}

export interface ExecutionTrustRecordCandidate {
  chainId: number;
  address: string;
  normalizedAddress: string;
  role: ExecutionTargetClassification;
  runtimeCodeHash: string | null;
  proxyType: ProxyRelationshipEvidence["proxyType"];
  implementationAddress: string | null;
  implementationCodeHash: string | null;
  approvedSelectors: string[];
  observedSelectors: string[];
  parentConstraints: Array<{
    parentAddress: string | null;
    parentRole: ExecutionTargetClassification | null;
  }>;
  callerConstraints: Array<{
    caller: string | null;
    selector: string | null;
    callType: string;
  }>;
  factoryAddress: string | null;
  factoryCodeHash: string | null;
  tokenConstraints: {
    token0: string | null;
    token1: string | null;
    assets: string[];
  } | null;
  managerCodeHashConstraint: string | null;
  firstObservedBlock: string;
  lastObservedBlock: string;
  evidence: Record<string, unknown>;
  confidence: TrustCandidateConfidence;
  unresolvedReasons: string[];
  operatorApproved: false;
}

export interface RouteTrustBundleCandidate {
  chainId: number;
  routerAddress: string;
  routerCodeHash: string | null;
  swapManagerAddress: string;
  swapManagerCodeHash: string | null;
  historicalTransaction: string;
  historicalBlock: string;
  requiredRecords: ExecutionTrustRecordCandidate[];
  optionalRecords: ExecutionTrustRecordCandidate[];
  unresolvedRecords: ExecutionTrustRecordCandidate[];
  prohibitedOperations: string[];
  graphFingerprint: string;
  bundleFingerprint: string;
  operatorApproved: false;
}

export type OperatorReviewedExecutionTrustRecordCandidate = Omit<
  ExecutionTrustRecordCandidate,
  "operatorApproved"
> & {
  operatorApproved: boolean;
};

export type OperatorReviewedRouteTrustBundleCandidate = Omit<
  RouteTrustBundleCandidate,
  "requiredRecords" | "optionalRecords" | "unresolvedRecords" | "operatorApproved"
> & {
  requiredRecords: OperatorReviewedExecutionTrustRecordCandidate[];
  optionalRecords: OperatorReviewedExecutionTrustRecordCandidate[];
  unresolvedRecords: OperatorReviewedExecutionTrustRecordCandidate[];
  operatorApproved: boolean;
};

export interface GraphPolicyEvaluation {
  graphStatus: GraphStatus;
  classifiedCallCount: number;
  unresolvedCallCount: number;
  classifiedStateChangingCallCount: number;
  unresolvedStateChangingCallCount: number;
  unresolvedDelegatecallCount: number;
  unknownSelectorCount: number;
  prohibitedOperationCount: number;
  automaticExecutionEligible: false;
}

export interface LiveGraphComparisonResult {
  status: "PASSED" | "REJECTED";
  failureCodes: string[];
  warnings: string[];
  automaticExecutionEligible: boolean;
}

export interface ExecutionTrustReport {
  chainId: number;
  historicalTransaction: string;
  historicalBlock: string;
  traceBackend: {
    rpcUrl: string | null;
    method: "debug_traceTransaction" | "trace_transaction" | null;
    supported: boolean;
    attempts: Array<{ rpcUrl: string; method: string; error: string }>;
  };
  normalizedCalls: NormalizedExecutionCall[];
  callCount: number;
  targetClassifications: Record<string, ExecutionTargetClassification>;
  runtimeCodeEvidence: RuntimeCodeEvidence[];
  sourceEvidence: SourceLookupEvidence[];
  poolProvenance: PoolProvenanceEvidence[];
  delegatecallTargets: Array<{
    address: string;
    normalizedAddress: string;
    classification: ExecutionTargetClassification;
    contexts: Array<{
      tracePath: string;
      parentAddress: string | null;
      parentRole: ExecutionTargetClassification | null;
      selector: string | null;
    }>;
    unresolvedReasons: string[];
  }>;
  candidateRecords: ExecutionTrustRecordCandidate[];
  routeTrustBundle: RouteTrustBundleCandidate;
  graphPolicy: GraphPolicyEvaluation;
  liveComparisonPreview: LiveGraphComparisonResult;
}

export interface EvidenceProvider {
  getRuntimeCode(address: string, blockNumber: string): Promise<RuntimeCodeEvidence>;
  getSource?(address: string): Promise<SourceLookupEvidence>;
  verifyPool?(address: string, blockNumber: string, selectors: string[]): Promise<PoolProvenanceEvidence>;
}

const HISTORICAL_DIAGNOSTIC_TX =
  "0x1a0d519d0b1ae9e0f759d2a068fa720c3759d5f057b611f91c726ef8db570a56" as const;
const HISTORICAL_DIAGNOSTIC_BLOCK = "27195532" as const;
const CURRENT_ROUTER_HASH =
  "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b" as const;
const CURRENT_MANAGER_ADDRESS =
  "0x58ab37d02696a481e2e5b5779967f3f4d237baa9" as const;
const CURRENT_MANAGER_HASH =
  "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb" as const;
const TOKEN_PROXY_IMPLEMENTATION_539A =
  "0x539a69de74e9ed69fbe7f909fa935d05b8caba11" as const;

const ERC20_SELECTORS = new Set([
  ERC20_TRANSFER_SELECTOR,
  ERC20_TRANSFER_FROM_SELECTOR,
  ERC20_APPROVE_SELECTOR,
  ERC20_BALANCE_OF_SELECTOR,
  ERC20_ALLOWANCE_SELECTOR,
  "0x06fdde03", // name()
  "0x95d89b41", // symbol()
  "0x313ce567", // decimals()
  "0x18160ddd", // totalSupply()
]);
const V2_POOL_SELECTORS = new Set(["0x0902f1ac", "0x022c0d9f", "0x0dfe1681", "0xd21220a7", "0xc45a0155"]);
const V3_POOL_SELECTORS = new Set(["0x128acb08", "0x0dfe1681", "0xd21220a7", "0xc45a0155", "0xddca3f43"]);
const ROUTER_SELECTORS = new Set([
  "0x38ed1739",
  "0x414bf389",
  "0x31e2ba55",
  "0x128acb08",
]);
const PROHIBITED_CALL_TYPES = new Set(["CREATE", "CREATE2", "SELFDESTRUCT", "CALLCODE"]);
const STATELESS_CALL_TYPES = new Set(["STATICCALL"]);

const KNOWN_PROTOCOL_ROUTERS = new Map<string, string>([
  ["0x98bf93ebf5c380c0e6ae8e192a7e2ae08edacc02", "PulseX V1 Router"],
  ["0x165c3410fc91ef562c50559f7d2289febed552d9", "PulseX V2 Router"],
  ["0x48e8100374ae6ff2cc8871db6224b296718eeb0d", "Phux/Algebra-style Router"],
]);

const KNOWN_PROTOCOL_FACTORIES = new Map<string, string>([
  ["0x1715a3e4a142d8b698131108995174f37aeba10d", "PulseX V1 Factory"],
  ["0x29ea7545def87022badc76323f373ea1e707c523", "PulseX V2 Factory"],
]);

const getPairAbi = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    outputs: [{ name: "pair", type: "address" }],
  },
] as const;

export function normalizeExecutionTrace(args: {
  root: TraceNode;
  runtimeCodeByAddress: Map<string, RuntimeCodeEvidence>;
  blockNumber: string;
}): NormalizedExecutionCall[] {
  const calls: NormalizedExecutionCall[] = [];
  const walk = (
    node: TraceNode,
    path: string,
    depth: number,
    parentAddress: string | null,
  ) => {
    const to = normalizeAddress(node.to);
    const code = to ? args.runtimeCodeByAddress.get(to) : undefined;
    calls.push({
      tracePath: path,
      depth,
      callType: (node.type ?? "CALL").toUpperCase(),
      from: normalizeAddress(node.from),
      to,
      selector: selectorOf(node.input),
      valueWei: valueToDecimal(node.value),
      inputFingerprint: node.input ? fingerprint(node.input) : null,
      outputFingerprint: node.output ? fingerprint(node.output) : null,
      success: !node.error && !node.revertReason,
      gasUsed: valueToDecimal(node.gasUsed),
      parentAddress,
      parentRole: null,
      runtimeCodeHash: code?.runtimeCodeHash ?? null,
      blockNumber: args.blockNumber,
      classification: to ? "UNKNOWN_CONTRACT" : "EOA",
      unresolvedReasons: [],
    });
    node.calls?.forEach((child, index) =>
      walk(child, `${path}.${index}`, depth + 1, to),
    );
  };
  walk(args.root, "0", 0, null);
  return calls;
}

export async function buildExecutionTrustReport(args: {
  config: AppConfig;
  historicalTransactionHash: string;
  pinnedBlock?: string;
  includeSourceLookup?: boolean;
  includeFactoryVerification?: boolean;
  traceRoot?: TraceNode;
  provider?: EvidenceProvider;
}): Promise<ExecutionTrustReport> {
  const historicalBlock = args.pinnedBlock ?? HISTORICAL_DIAGNOSTIC_BLOCK;
  const trace = args.traceRoot
    ? {
        supported: true,
        rpcUrl: null,
        method: null,
        root: args.traceRoot,
        attempts: [],
      }
    : await fetchHistoricalTrace(args.config, args.historicalTransactionHash);
  if (!trace.root) {
    throw new Error("historical trace unavailable");
  }

  const rawAddresses = uniqueStrings(
    flattenTrace(trace.root)
      .flatMap((node) => [node.from, node.to])
      .filter((value): value is string => isAddress(value))
      .concat([PITEAS_ROUTER, CURRENT_MANAGER_ADDRESS]),
  ).map((address) => address.toLowerCase());
  const provider = args.provider ?? createRpcEvidenceProvider(args.config);
  const codeEvidence = await Promise.all(
    rawAddresses.map((address) => provider.getRuntimeCode(address, historicalBlock)),
  );
  const codeByAddress = new Map(
    codeEvidence.map((evidence) => [evidence.normalizedAddress, evidence]),
  );
  const normalizedBase = normalizeExecutionTrace({
    root: trace.root,
    runtimeCodeByAddress: codeByAddress,
    blockNumber: historicalBlock,
  });

  const sourceEvidence = args.includeSourceLookup === false || !provider.getSource
    ? []
    : await Promise.all(rawAddresses.map((address) => provider.getSource!(address)));
  const sourceByAddress = new Map(
    sourceEvidence.map((evidence) => [evidence.address.toLowerCase(), evidence]),
  );
  const poolProvenance = args.includeFactoryVerification === false || !provider.verifyPool
    ? []
    : await verifyObservedPools(provider, normalizedBase, historicalBlock);
  const poolByAddress = new Map(
    poolProvenance.map((evidence) => [
      evidence.evidence.address?.toString().toLowerCase() ?? "",
      evidence,
    ]),
  );

  const normalizedCalls = classifyCalls({
    calls: normalizedBase,
    codeByAddress,
    sourceByAddress,
    poolByAddress,
  });
  const records = buildTrustRecordCandidates({
    calls: normalizedCalls,
    codeByAddress,
    sourceByAddress,
    poolByAddress,
    managerCodeHash: CURRENT_MANAGER_HASH,
  });
  const prohibitedOperations = prohibitedOperationsFor(normalizedCalls);
  const graphFingerprint = buildGraphFingerprint(normalizedCalls);
  const bundle = buildRouteTrustBundleCandidate({
    historicalTransaction: args.historicalTransactionHash,
    historicalBlock,
    records,
    prohibitedOperations,
    graphFingerprint,
  });
  const graphPolicy = evaluateHistoricalGraphPolicy(normalizedCalls, records);
  const liveComparisonPreview = compareLiveTraceAgainstTrustBundle({
    bundle,
    calls: normalizedCalls,
    routerAddress: PITEAS_ROUTER,
    routerCodeHash: bundle.routerCodeHash,
    swapManagerAddress: CURRENT_MANAGER_ADDRESS,
    swapManagerCodeHash: bundle.swapManagerCodeHash,
    requireOperatorApproval: true,
  });

  return {
    chainId: PULSECHAIN_CHAIN_ID,
    historicalTransaction: args.historicalTransactionHash,
    historicalBlock,
    traceBackend: {
      rpcUrl: trace.rpcUrl,
      method: trace.method,
      supported: trace.supported,
      attempts: trace.attempts,
    },
    normalizedCalls,
    callCount: normalizedCalls.length,
    targetClassifications: Object.fromEntries(
      records.map((record) => [record.normalizedAddress, record.role]),
    ),
    runtimeCodeEvidence: codeEvidence.map(withoutBytecode),
    sourceEvidence,
    poolProvenance,
    delegatecallTargets: delegatecallTargetSummaries(normalizedCalls),
    candidateRecords: records,
    routeTrustBundle: bundle,
    graphPolicy,
    liveComparisonPreview,
  };
}

export function classifyCalls(args: {
  calls: NormalizedExecutionCall[];
  codeByAddress: Map<string, RuntimeCodeEvidence>;
  sourceByAddress?: Map<string, SourceLookupEvidence>;
  poolByAddress?: Map<string, PoolProvenanceEvidence>;
}): NormalizedExecutionCall[] {
  const childrenByPath = new Map<string, NormalizedExecutionCall[]>();
  for (const call of args.calls) {
    const parentPath = parentTracePath(call.tracePath);
    if (parentPath) {
      const list = childrenByPath.get(parentPath) ?? [];
      list.push(call);
      childrenByPath.set(parentPath, list);
    }
  }

  const provisional = new Map<string, ExecutionTargetClassification>();
  for (const call of args.calls) {
    provisional.set(
      call.tracePath,
      classifySingleCall({
        call,
        children: childrenByPath.get(call.tracePath) ?? [],
        code: call.to ? args.codeByAddress.get(call.to) : undefined,
        source: call.to ? args.sourceByAddress?.get(call.to) : undefined,
        pool: call.to ? args.poolByAddress?.get(call.to) : undefined,
      }),
    );
  }

  return args.calls.map((call) => {
    const parentRole =
      parentTracePath(call.tracePath) === null
        ? null
        : provisional.get(parentTracePath(call.tracePath)!) ?? null;
    const classification = provisional.get(call.tracePath) ?? "UNKNOWN_CONTRACT";
    const unresolvedReasons = unresolvedReasonsFor(call, classification, parentRole);
    return {
      ...call,
      parentRole,
      classification,
      unresolvedReasons,
    };
  });
}

export function buildTrustRecordCandidates(args: {
  calls: NormalizedExecutionCall[];
  codeByAddress: Map<string, RuntimeCodeEvidence>;
  sourceByAddress?: Map<string, SourceLookupEvidence>;
  poolByAddress?: Map<string, PoolProvenanceEvidence>;
  managerCodeHash: string | null;
}): ExecutionTrustRecordCandidate[] {
  const callsByAddress = new Map<string, NormalizedExecutionCall[]>();
  for (const call of args.calls) {
    if (!call.to) continue;
    const list = callsByAddress.get(call.to) ?? [];
    list.push(call);
    callsByAddress.set(call.to, list);
  }
  return [...callsByAddress.entries()]
    .map(([address, calls]) => {
      const first = calls[0]!;
      const code = args.codeByAddress.get(address);
      const source = args.sourceByAddress?.get(address);
      const pool = args.poolByAddress?.get(address);
      const role = dominantRole(calls);
      const proxy = proxyRelationshipFor(address, calls, args.codeByAddress);
      const observedSelectors = uniqueStrings(
        calls.map((call) => call.selector).filter((value): value is string => Boolean(value)),
      ).sort();
      const unresolvedReasons = uniqueStrings(
        calls.flatMap((call) => call.unresolvedReasons).concat(
          pool?.unresolvedReasons ?? [],
          proxy.proxyType === "UNKNOWN_PATTERN" ? ["proxy_relationship_unresolved"] : [],
        ),
      );
      const confidence = confidenceFor(role, code, unresolvedReasons, pool, proxy);
      return {
        chainId: PULSECHAIN_CHAIN_ID,
        address: first.to!,
        normalizedAddress: address,
        role,
        runtimeCodeHash: code?.runtimeCodeHash ?? null,
        proxyType: proxy.proxyType,
        implementationAddress: proxy.implementationAddress,
        implementationCodeHash: proxy.implementationCodeHash,
        approvedSelectors: [],
        observedSelectors,
        parentConstraints: uniqueParentConstraints(calls),
        callerConstraints: uniqueCallerConstraints(calls),
        factoryAddress: pool?.factoryAddress ?? null,
        factoryCodeHash: pool?.factoryCodeHash ?? null,
        tokenConstraints: pool
          ? {
              token0: pool.token0,
              token1: pool.token1,
              assets: pool.assets,
            }
          : null,
        managerCodeHashConstraint: stateChangingCalls(calls).length > 0 ? args.managerCodeHash : null,
        firstObservedBlock: first.blockNumber,
        lastObservedBlock: calls[calls.length - 1]?.blockNumber ?? first.blockNumber,
        evidence: {
          codeHashAgreement: code?.codeHashAgreement ?? "unavailable",
          bytecodeLength: code?.bytecodeLength ?? null,
          source,
          pool,
          observedCallCount: calls.length,
          observedTracePaths: calls.map((call) => call.tracePath),
          historicalEvidenceOnly: true,
          operatorApprovalRequired: true,
        },
        confidence,
        unresolvedReasons,
        operatorApproved: false as const,
      };
    })
    .sort((a, b) => a.normalizedAddress.localeCompare(b.normalizedAddress));
}

export function buildRouteTrustBundleCandidate(args: {
  historicalTransaction: string;
  historicalBlock: string;
  records: ExecutionTrustRecordCandidate[];
  prohibitedOperations: string[];
  graphFingerprint: string;
}): RouteTrustBundleCandidate {
  const requiredRecords = args.records.filter((record) =>
    record.role === "PITEAS_ROUTER" ||
    record.role === "PITEAS_SWAP_MANAGER" ||
    record.observedSelectors.some((selector) => selector !== null) &&
      record.callerConstraints.some((constraint) => isStateChangingCallType(constraint.callType)),
  );
  const unresolvedRecords = args.records.filter((record) =>
    record.confidence === "unresolved" || record.unresolvedReasons.length > 0,
  );
  const optionalRecords = args.records.filter(
    (record) => !requiredRecords.includes(record) && !unresolvedRecords.includes(record),
  );
  const routerRecord = args.records.find((record) => record.role === "PITEAS_ROUTER");
  const managerRecord = args.records.find((record) => record.role === "PITEAS_SWAP_MANAGER");
  const base = {
    chainId: PULSECHAIN_CHAIN_ID,
    routerAddress: PITEAS_ROUTER,
    routerCodeHash: routerRecord?.runtimeCodeHash ?? CURRENT_ROUTER_HASH,
    swapManagerAddress: CURRENT_MANAGER_ADDRESS,
    swapManagerCodeHash: managerRecord?.runtimeCodeHash ?? CURRENT_MANAGER_HASH,
    historicalTransaction: args.historicalTransaction,
    historicalBlock: args.historicalBlock,
    requiredRecords,
    optionalRecords,
    unresolvedRecords,
    prohibitedOperations: args.prohibitedOperations,
    graphFingerprint: args.graphFingerprint,
    operatorApproved: false as const,
  };
  return {
    ...base,
    bundleFingerprint: fingerprint({
      chainId: base.chainId,
      routerAddress: base.routerAddress.toLowerCase(),
      routerCodeHash: base.routerCodeHash,
      swapManagerAddress: base.swapManagerAddress.toLowerCase(),
      swapManagerCodeHash: base.swapManagerCodeHash,
      historicalTransaction: base.historicalTransaction.toLowerCase(),
      historicalBlock: base.historicalBlock,
      graphFingerprint: base.graphFingerprint,
      requiredRecords: base.requiredRecords.map(recordFingerprintMaterial),
      optionalRecords: base.optionalRecords.map(recordFingerprintMaterial),
      unresolvedRecords: base.unresolvedRecords.map(recordFingerprintMaterial),
      prohibitedOperations: base.prohibitedOperations,
      operatorApproved: false,
    }),
  };
}

export function evaluateHistoricalGraphPolicy(
  calls: NormalizedExecutionCall[],
  records: ExecutionTrustRecordCandidate[],
): GraphPolicyEvaluation {
  const unresolvedCalls = calls.filter((call) => call.unresolvedReasons.length > 0);
  const stateChanging = calls.filter(isStateChangingCall);
  const unresolvedStateChanging = stateChanging.filter((call) => call.unresolvedReasons.length > 0);
  const prohibitedOperationCount = calls.filter((call) => PROHIBITED_CALL_TYPES.has(call.callType)).length;
  const unresolvedDelegatecallCount = calls.filter(
    (call) => call.callType === "DELEGATECALL" && call.unresolvedReasons.length > 0,
  ).length;
  const unknownSelectorCount = calls.filter(
    (call) =>
      call.selector !== null &&
      call.classification === "UNKNOWN_CONTRACT",
  ).length;
  const hasUnresolvedRecord = records.some(
    (record) => record.unresolvedReasons.length > 0 || record.confidence === "unresolved",
  );
  const graphStatus: GraphStatus =
    prohibitedOperationCount > 0
      ? "FAILED"
      : unresolvedCalls.length === 0 && !hasUnresolvedRecord
        ? "FULLY_CLASSIFIED"
        : unresolvedCalls.length < calls.length
          ? "PARTIALLY_CLASSIFIED"
          : "UNRESOLVED";
  return {
    graphStatus,
    classifiedCallCount: calls.length - unresolvedCalls.length,
    unresolvedCallCount: unresolvedCalls.length,
    classifiedStateChangingCallCount: stateChanging.length - unresolvedStateChanging.length,
    unresolvedStateChangingCallCount: unresolvedStateChanging.length,
    unresolvedDelegatecallCount,
    unknownSelectorCount,
    prohibitedOperationCount,
    automaticExecutionEligible: false,
  };
}

export function compareLiveTraceAgainstTrustBundle(args: {
  bundle: RouteTrustBundleCandidate | OperatorReviewedRouteTrustBundleCandidate;
  calls: NormalizedExecutionCall[];
  routerAddress: string;
  routerCodeHash: string | null;
  swapManagerAddress: string;
  swapManagerCodeHash: string | null;
  requireOperatorApproval?: boolean;
}): LiveGraphComparisonResult {
  const failureCodes: string[] = [];
  const warnings: string[] = [];
  if (!sameAddress(args.routerAddress, args.bundle.routerAddress)) failureCodes.push("ROUTER_ADDRESS_CHANGED");
  if (!sameString(args.routerCodeHash, args.bundle.routerCodeHash)) failureCodes.push("ROUTER_CODE_HASH_CHANGED");
  if (!sameAddress(args.swapManagerAddress, args.bundle.swapManagerAddress)) failureCodes.push("MANAGER_ADDRESS_CHANGED");
  if (!sameString(args.swapManagerCodeHash, args.bundle.swapManagerCodeHash)) failureCodes.push("MANAGER_CODE_HASH_CHANGED");
  if (args.requireOperatorApproval !== false && !args.bundle.operatorApproved) {
    failureCodes.push("BUNDLE_NOT_OPERATOR_APPROVED");
  }

  const approvedRecords = new Map(
    [...args.bundle.requiredRecords, ...args.bundle.optionalRecords]
      .filter((record) => record.operatorApproved)
      .map((record) => [record.normalizedAddress, record]),
  );
  const historicalEdges = new Set(
    [...args.bundle.requiredRecords, ...args.bundle.optionalRecords].flatMap((record) =>
      record.callerConstraints.map((constraint) =>
        edgeKey(constraint.caller, record.normalizedAddress, constraint.selector, constraint.callType),
      ),
    ),
  );

  for (const call of args.calls) {
    if (PROHIBITED_CALL_TYPES.has(call.callType)) {
      failureCodes.push(`PROHIBITED_OPERATION_${call.callType}`);
      continue;
    }
    if (!call.to || !isStateChangingCall(call)) continue;
    const record = approvedRecords.get(call.to);
    if (!record) {
      failureCodes.push(`UNAPPROVED_STATE_CHANGING_TARGET:${call.to}`);
      continue;
    }
    if (call.selector && !record.approvedSelectors.includes(call.selector)) {
      failureCodes.push(`SELECTOR_NOT_APPROVED:${call.to}:${call.selector}`);
    }
    if (!historicalEdges.has(edgeKey(call.from, call.to, call.selector, call.callType))) {
      failureCodes.push(`UNEXPECTED_CALL_EDGE:${call.from ?? "unknown"}:${call.to}:${call.selector ?? "none"}`);
    }
    if (record.factoryAddress && record.tokenConstraints) {
      warnings.push(`pool_factory_constraints_must_be_revalidated:${record.normalizedAddress}`);
    }
  }

  return {
    status: failureCodes.length === 0 ? "PASSED" : "REJECTED",
    failureCodes: uniqueStrings(failureCodes).sort(),
    warnings: uniqueStrings(warnings).sort(),
    automaticExecutionEligible: failureCodes.length === 0,
  };
}

export function buildGraphFingerprint(calls: NormalizedExecutionCall[]): string {
  return fingerprint(
    calls.map((call) => ({
      tracePath: call.tracePath,
      depth: call.depth,
      callType: call.callType,
      from: call.from,
      to: call.to,
      selector: call.selector,
      valueWei: call.valueWei,
      inputFingerprint: call.inputFingerprint,
      outputFingerprint: call.outputFingerprint,
      success: call.success,
      parentAddress: call.parentAddress,
      runtimeCodeHash: call.runtimeCodeHash,
      classification: call.classification,
    })),
  );
}

export function registerPhiatExecutionTrustReportTool(
  server: McpServer,
  config: AppConfig,
): void {
  registerTool(server, config, {
    name: "phiat_execution_trust_report",
    description:
      "Read-only PHIAT/Piteas historical execution-target trust report. Fetches and normalizes a historical trace, classifies candidate trust records, and never approves, signs, submits, broadcasts, executes, or writes to disk.",
    category: "analytics",
    write: false,
    inputSchema: {
      historicalTransactionHash: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/)
        .default(HISTORICAL_DIAGNOSTIC_TX),
      pinnedBlock: z.string().regex(/^\d+$/).optional(),
      includeSourceLookup: z.boolean().optional().default(true),
      includeFactoryVerification: z.boolean().optional().default(true),
    },
    handler: async (args, cfg) =>
      ok(
        await buildExecutionTrustReport({
          config: cfg,
          historicalTransactionHash:
            (args.historicalTransactionHash as string | undefined) ?? HISTORICAL_DIAGNOSTIC_TX,
          pinnedBlock: args.pinnedBlock as string | undefined,
          includeSourceLookup: args.includeSourceLookup as boolean | undefined,
          includeFactoryVerification: args.includeFactoryVerification as boolean | undefined,
        }),
      ),
  });
}

async function fetchHistoricalTrace(
  config: AppConfig,
  transactionHash: string,
): Promise<{
  supported: boolean;
  rpcUrl: string | null;
  method: "debug_traceTransaction" | "trace_transaction" | null;
  root: TraceNode | null;
  attempts: Array<{ rpcUrl: string; method: string; error: string }>;
}> {
  const attempts: Array<{ rpcUrl: string; method: string; error: string }> = [];
  const tx = await fetchTransaction(config, transactionHash);
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const root = await rpcCall<TraceNode>(
        rpcUrl,
        "debug_traceTransaction",
        [transactionHash, { tracer: "callTracer" }],
        config.httpTimeoutMs,
      );
      return { supported: true, rpcUrl, method: "debug_traceTransaction", root, attempts };
    } catch (err) {
      attempts.push({ rpcUrl, method: "debug_traceTransaction", error: errorMessage(err) });
    }
    try {
      const parity = await rpcCall<unknown[]>(
        rpcUrl,
        "trace_transaction",
        [transactionHash],
        config.httpTimeoutMs,
      );
      return {
        supported: true,
        rpcUrl,
        method: "trace_transaction",
        root: parityTraceToTree(parity, tx),
        attempts,
      };
    } catch (err) {
      attempts.push({ rpcUrl, method: "trace_transaction", error: errorMessage(err) });
    }
  }
  return { supported: false, rpcUrl: null, method: null, root: null, attempts };
}

function createRpcEvidenceProvider(config: AppConfig): EvidenceProvider {
  return {
    getRuntimeCode: async (address, blockNumber) => readRuntimeCodeEvidence(config, address, blockNumber),
    getSource: async (address) => fetchSourceEvidence(config, address),
    verifyPool: async (address, blockNumber, selectors) =>
      verifyPoolProvenance(config, address, blockNumber, selectors),
  };
}

async function readRuntimeCodeEvidence(
  config: AppConfig,
  address: string,
  blockNumber: string,
): Promise<RuntimeCodeEvidence> {
  const normalizedAddress = address.toLowerCase();
  const blockHex = decimalBlockToHex(blockNumber);
  const rpcSamples = await Promise.all(
    rpcUrls(config).map(async (rpcUrl) => {
      try {
        const bytecode = await rpcCall<string>(rpcUrl, "eth_getCode", [address, blockHex], config.httpTimeoutMs);
        return {
          rpcUrl,
          ok: true,
          runtimeCodeHash: bytecode === "0x" ? null : keccak256(bytecode as Hex),
          bytecodeLength: bytecode === "0x" ? 0 : (bytecode.length - 2) / 2,
          bytecode,
          error: null,
        };
      } catch (err) {
        return {
          rpcUrl,
          ok: false,
          runtimeCodeHash: null,
          bytecodeLength: null,
          bytecode: null,
          error: errorMessage(err),
        };
      }
    }),
  );
  const firstBytecode = rpcSamples.find((sample) => sample.bytecode)?.bytecode ?? null;
  const firstHash = rpcSamples.find((sample) => sample.runtimeCodeHash)?.runtimeCodeHash ?? null;
  return {
    address,
    normalizedAddress,
    blockNumber,
    runtimeCodeHash: firstHash,
    codeHashAgreement: hashAgreement(rpcSamples.map((sample) => sample.runtimeCodeHash)),
    rpcSamples: rpcSamples.map(({ bytecode: _bytecode, ...sample }) => sample),
    bytecodeLength: rpcSamples.find((sample) => sample.bytecodeLength !== null)?.bytecodeLength ?? null,
    bytecode: firstBytecode,
  };
}

async function fetchSourceEvidence(
  config: AppConfig,
  address: string,
): Promise<SourceLookupEvidence> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
  try {
    const [abiResponse, sourceResponse] = await Promise.all([
      fetch(`${config.explorerApi}?module=contract&action=getabi&address=${address}`, {
        signal: controller.signal,
      }),
      fetch(`${config.explorerApi}?module=contract&action=getsourcecode&address=${address}`, {
        signal: controller.signal,
      }),
    ]);
    const abi = await abiResponse.json() as { status?: string; result?: unknown };
    const source = await sourceResponse.json() as {
      status?: string;
      result?: Array<{ ContractName?: string; SourceCode?: string }> | unknown;
    };
    const abiText = typeof abi.result === "string" ? abi.result : null;
    const sourceRows = Array.isArray(source.result) ? source.result : [];
    const contractName = sourceRows[0]?.ContractName ?? null;
    return {
      address: address.toLowerCase(),
      verified: abi.status === "1" || source.status === "1",
      contractName,
      abiSelectors: abiText ? abiFunctionSelectors(abiText) : [],
      sourceFingerprint: sourceRows.length > 0 ? fingerprint(sourceRows) : null,
      error: null,
    };
  } catch (err) {
    return {
      address: address.toLowerCase(),
      verified: false,
      contractName: null,
      abiSelectors: [],
      sourceFingerprint: null,
      error: errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyObservedPools(
  provider: EvidenceProvider,
  calls: NormalizedExecutionCall[],
  blockNumber: string,
): Promise<PoolProvenanceEvidence[]> {
  const poolLike = uniqueStrings(
    calls
      .filter((call) => call.to && (V2_POOL_SELECTORS.has(call.selector ?? "") || V3_POOL_SELECTORS.has(call.selector ?? "")))
      .map((call) => call.to!),
  );
  return Promise.all(
    poolLike.map((address) =>
      provider.verifyPool!(
        address,
        blockNumber,
        uniqueStrings(calls.filter((call) => call.to === address).map((call) => call.selector ?? "")),
      ),
    ),
  );
}

async function verifyPoolProvenance(
  config: AppConfig,
  address: string,
  blockNumber: string,
  selectors: string[],
): Promise<PoolProvenanceEvidence> {
  const blockHex = decimalBlockToHex(blockNumber);
  const evidence: Record<string, unknown> = { address: address.toLowerCase(), selectors };
  const unresolvedReasons: string[] = [];
  const token0 = await ethCallAddress(config, address, "0x0dfe1681", blockHex);
  const token1 = await ethCallAddress(config, address, "0xd21220a7", blockHex);
  const factory = await ethCallAddress(config, address, "0xc45a0155", blockHex);
  let factoryCodeHash: string | null = null;
  let factoryVerified = false;
  if (factory) {
    const factoryCode = await readRuntimeCodeEvidence(config, factory, blockNumber);
    factoryCodeHash = factoryCode.runtimeCodeHash;
    const pairFromFactory =
      token0 && token1
        ? await getPairFromFactory(config, factory, token0, token1, blockHex)
        : null;
    factoryVerified = pairFromFactory !== null && sameAddress(pairFromFactory, address);
    evidence.factoryGetPair = pairFromFactory;
  } else {
    unresolvedReasons.push("factory_unavailable");
  }
  if (!token0 || !token1) unresolvedReasons.push("pool_tokens_unavailable");
  if (factory && !factoryVerified) unresolvedReasons.push("factory_did_not_confirm_pool");
  const selectorAppropriate = selectors.some((selector) =>
    V2_POOL_SELECTORS.has(selector) || V3_POOL_SELECTORS.has(selector),
  );
  if (!selectorAppropriate) unresolvedReasons.push("selector_not_pool_appropriate");
  const poolType = selectors.includes("0x128acb08")
    ? "V3_POOL"
    : selectors.some((selector) => V2_POOL_SELECTORS.has(selector))
      ? "V2_POOL"
      : null;
  return {
    protocol: factory ? KNOWN_PROTOCOL_FACTORIES.get(factory.toLowerCase()) ?? null : null,
    poolType,
    factoryAddress: factory,
    factoryCodeHash,
    token0,
    token1,
    assets: [token0, token1].filter((value): value is string => Boolean(value)),
    factoryVerified,
    selectorAppropriate,
    evidence,
    unresolvedReasons,
  };
}

function classifySingleCall(args: {
  call: NormalizedExecutionCall;
  children: NormalizedExecutionCall[];
  code?: RuntimeCodeEvidence;
  source?: SourceLookupEvidence;
  pool?: PoolProvenanceEvidence;
}): ExecutionTargetClassification {
  const { call } = args;
  if (!call.to) return "EOA";
  if (isPrecompile(call.to)) return "PRECOMPILE";
  if (args.code?.bytecodeLength === 0 || args.code?.runtimeCodeHash === null) return "EOA";
  if (sameAddress(call.to, PITEAS_ROUTER)) return "PITEAS_ROUTER";
  if (sameAddress(call.to, CURRENT_MANAGER_ADDRESS)) return "PITEAS_SWAP_MANAGER";
  if (sameAddress(call.to, WPLS_ADDRESS)) return "WRAPPED_NATIVE_TOKEN";
  if (KNOWN_PROTOCOL_ROUTERS.has(call.to)) return "PROTOCOL_ROUTER";
  if (KNOWN_PROTOCOL_FACTORIES.has(call.to)) return "PROTOCOL_FACTORY";
  if (args.pool?.poolType) return args.pool.poolType;
  if (call.callType === "DELEGATECALL") {
    return classifyDelegatecallTarget(call, args.source);
  }
  if (hasDelegatecallChildWithErc20Selector(args.children, args.code, args.source)) {
    return "TOKEN_PROXY";
  }
  if (call.selector && V2_POOL_SELECTORS.has(call.selector)) return "V2_POOL";
  if (call.selector && V3_POOL_SELECTORS.has(call.selector)) return "V3_POOL";
  if (call.selector && ROUTER_SELECTORS.has(call.selector)) return "PROTOCOL_ROUTER";
  if (call.selector && ERC20_SELECTORS.has(call.selector)) return "ERC20_DIRECT";
  return "UNKNOWN_CONTRACT";
}

function classifyDelegatecallTarget(
  call: NormalizedExecutionCall,
  source?: SourceLookupEvidence,
): ExecutionTargetClassification {
  if (
    call.to &&
    sameAddress(call.to, TOKEN_PROXY_IMPLEMENTATION_539A) &&
    call.selector &&
    ERC20_SELECTORS.has(call.selector)
  ) {
    return "TOKEN_IMPLEMENTATION";
  }
  if (source?.contractName && /library/i.test(source.contractName)) return "PROTOCOL_LIBRARY";
  return "UNKNOWN_CONTRACT";
}

function hasDelegatecallChildWithErc20Selector(
  children: NormalizedExecutionCall[],
  code: RuntimeCodeEvidence | undefined,
  source: SourceLookupEvidence | undefined,
): boolean {
  const hasRuntimeProxyStructure =
    code?.bytecode ? opcodePresence(code.bytecode).containsDelegatecallOpcode : false;
  const hasTokenProxyMetadata =
    source?.contractName ? /tokenproxy|token_proxy|proxy/i.test(source.contractName) : false;
  return (
    (hasRuntimeProxyStructure || hasTokenProxyMetadata) &&
    children.some(
      (child) =>
        child.callType === "DELEGATECALL" &&
        child.selector !== null &&
        ERC20_SELECTORS.has(child.selector),
    )
  );
}

function unresolvedReasonsFor(
  call: NormalizedExecutionCall,
  classification: ExecutionTargetClassification,
  parentRole: ExecutionTargetClassification | null,
): string[] {
  const reasons: string[] = [];
  if (PROHIBITED_CALL_TYPES.has(call.callType)) reasons.push(`prohibited_operation:${call.callType}`);
  if (classification === "UNKNOWN_CONTRACT") reasons.push("unknown_contract_classification");
  if (
    call.callType === "DELEGATECALL" &&
    classification === "TOKEN_IMPLEMENTATION" &&
    parentRole !== "TOKEN_PROXY"
  ) {
    reasons.push("token_implementation_without_token_proxy_parent");
  }
  if (
    call.callType === "DELEGATECALL" &&
    call.to &&
    sameAddress(call.to, "0x2d14e7701ce7d5558eb02f1919ec431a76fb2cad")
  ) {
    reasons.push("delegatecall_target_0x2d14_role_not_proven");
  }
  if (call.callType === "DELEGATECALL" && classification === "UNKNOWN_CONTRACT") {
    reasons.push("delegatecall_target_unresolved");
  }
  if (isStateChangingCall(call) && classification === "EOA") reasons.push("state_changing_eoa_target");
  if (call.runtimeCodeHash === null && classification !== "EOA" && classification !== "PRECOMPILE") {
    reasons.push("runtime_code_hash_unavailable");
  }
  return uniqueStrings(reasons);
}

function proxyRelationshipFor(
  address: string,
  calls: NormalizedExecutionCall[],
  codeByAddress: Map<string, RuntimeCodeEvidence>,
): ProxyRelationshipEvidence {
  const tokenImplCall = calls.find(
    (call) =>
      call.callType === "DELEGATECALL" &&
      call.classification === "TOKEN_IMPLEMENTATION" &&
      call.parentRole === "TOKEN_PROXY",
  );
  if (tokenImplCall?.parentAddress) {
    const code = codeByAddress.get(address);
    return {
      proxyType: "TRACE_BOUND_TOKEN_PROXY",
      implementationAddress: address,
      implementationCodeHash: code?.runtimeCodeHash ?? null,
      evidence: {
        relationship: "delegatecall_target_under_token_proxy_parent",
        parentAddress: tokenImplCall.parentAddress,
        tracePath: tokenImplCall.tracePath,
        selector: tokenImplCall.selector,
        codeHashAgreement: code?.codeHashAgreement ?? "unavailable",
      },
    };
  }
  const directCode = codeByAddress.get(address);
  if (directCode?.bytecode && implementationFromMinimalProxy(directCode.bytecode)) {
    return {
      proxyType: "EIP1167_MINIMAL",
      implementationAddress: implementationFromMinimalProxy(directCode.bytecode),
      implementationCodeHash: null,
      evidence: { minimalProxyRuntime: true },
    };
  }
  return {
    proxyType: calls.some((call) => call.classification === "UNKNOWN_CONTRACT")
      ? "UNKNOWN_PATTERN"
      : "NONE_DETECTED",
    implementationAddress: null,
    implementationCodeHash: null,
    evidence: {},
  };
}

function confidenceFor(
  role: ExecutionTargetClassification,
  code: RuntimeCodeEvidence | undefined,
  unresolvedReasons: string[],
  pool: PoolProvenanceEvidence | undefined,
  proxy: ProxyRelationshipEvidence,
): TrustCandidateConfidence {
  if (unresolvedReasons.length > 0) return "unresolved";
  if (role === "EOA" || role === "PRECOMPILE") return "medium";
  if (!code?.runtimeCodeHash || code.codeHashAgreement === "disagrees" || code.codeHashAgreement === "unavailable") {
    return "unresolved";
  }
  if (role.endsWith("_POOL") && pool?.factoryVerified !== true) return "low";
  if (role === "TOKEN_IMPLEMENTATION" && proxy.proxyType !== "TRACE_BOUND_TOKEN_PROXY") return "low";
  return code.codeHashAgreement === "agrees" ? "high" : "medium";
}

function delegatecallTargetSummaries(calls: NormalizedExecutionCall[]): ExecutionTrustReport["delegatecallTargets"] {
  const byAddress = new Map<string, NormalizedExecutionCall[]>();
  for (const call of calls) {
    if (call.callType !== "DELEGATECALL" || !call.to) continue;
    const list = byAddress.get(call.to) ?? [];
    list.push(call);
    byAddress.set(call.to, list);
  }
  return [...byAddress.entries()].map(([address, rows]) => ({
    address,
    normalizedAddress: address,
    classification: dominantRole(rows),
    contexts: rows.map((call) => ({
      tracePath: call.tracePath,
      parentAddress: call.parentAddress,
      parentRole: call.parentRole,
      selector: call.selector,
    })),
    unresolvedReasons: uniqueStrings(rows.flatMap((row) => row.unresolvedReasons)),
  }));
}

function dominantRole(calls: NormalizedExecutionCall[]): ExecutionTargetClassification {
  const counts = new Map<ExecutionTargetClassification, number>();
  for (const call of calls) counts.set(call.classification, (counts.get(call.classification) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN_CONTRACT";
}

function uniqueParentConstraints(calls: NormalizedExecutionCall[]): ExecutionTrustRecordCandidate["parentConstraints"] {
  const seen = new Set<string>();
  const out: ExecutionTrustRecordCandidate["parentConstraints"] = [];
  for (const call of calls) {
    const item = { parentAddress: call.parentAddress, parentRole: call.parentRole };
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniqueCallerConstraints(calls: NormalizedExecutionCall[]): ExecutionTrustRecordCandidate["callerConstraints"] {
  const seen = new Set<string>();
  const out: ExecutionTrustRecordCandidate["callerConstraints"] = [];
  for (const call of calls) {
    const item = { caller: call.from, selector: call.selector, callType: call.callType };
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function recordFingerprintMaterial(record: ExecutionTrustRecordCandidate): Record<string, unknown> {
  return {
    address: record.normalizedAddress,
    role: record.role,
    runtimeCodeHash: record.runtimeCodeHash,
    proxyType: record.proxyType,
    implementationAddress: record.implementationAddress,
    implementationCodeHash: record.implementationCodeHash,
    observedSelectors: record.observedSelectors,
    parentConstraints: record.parentConstraints,
    callerConstraints: record.callerConstraints,
    factoryAddress: record.factoryAddress,
    factoryCodeHash: record.factoryCodeHash,
    tokenConstraints: record.tokenConstraints,
    managerCodeHashConstraint: record.managerCodeHashConstraint,
    unresolvedReasons: record.unresolvedReasons,
    operatorApproved: false,
  };
}

function prohibitedOperationsFor(calls: NormalizedExecutionCall[]): string[] {
  return uniqueStrings(
    calls
      .filter((call) => PROHIBITED_CALL_TYPES.has(call.callType))
      .map((call) => `${call.callType}_REJECTED`),
  );
}

function isStateChangingCall(call: NormalizedExecutionCall): boolean {
  return isStateChangingCallType(call.callType);
}

function isStateChangingCallType(callType: string): boolean {
  return !STATELESS_CALL_TYPES.has(callType.toUpperCase());
}

function stateChangingCalls(calls: NormalizedExecutionCall[]): NormalizedExecutionCall[] {
  return calls.filter(isStateChangingCall);
}

function edgeKey(
  from: string | null,
  to: string | null,
  selector: string | null,
  callType: string,
): string {
  return `${from ?? "null"}>${to ?? "null"}:${selector ?? "none"}:${callType}`;
}

function withoutBytecode(evidence: RuntimeCodeEvidence): RuntimeCodeEvidence {
  return { ...evidence, bytecode: null };
}

function flattenTrace(root: TraceNode): TraceNode[] {
  const out: TraceNode[] = [];
  const walk = (node: TraceNode) => {
    out.push(node);
    node.calls?.forEach(walk);
  };
  walk(root);
  return out;
}

function parityTraceToTree(result: unknown[], tx: TraceNode): TraceNode {
  const root: TraceNode = {
    type: "CALL",
    from: tx.from,
    to: tx.to,
    input: tx.input,
    value: tx.value,
    calls: [],
  };
  const nodes = new Map<string, TraceNode>([["", root]]);
  for (const entry of result) {
    const row = entry as {
      traceAddress?: number[];
      type?: string;
      action?: { callType?: string; from?: string; to?: string; input?: string; value?: string };
      result?: { output?: string; gasUsed?: string };
      error?: string;
    };
    const key = (row.traceAddress ?? []).join(".");
    const parentKey = (row.traceAddress ?? []).slice(0, -1).join(".");
    const node: TraceNode = {
      type: (row.action?.callType ?? row.type ?? "CALL").toUpperCase(),
      from: row.action?.from,
      to: row.action?.to,
      input: row.action?.input,
      output: row.result?.output,
      value: row.action?.value,
      gasUsed: row.result?.gasUsed,
      error: row.error,
      calls: [],
    };
    nodes.set(key, node);
    (nodes.get(parentKey)?.calls ?? root.calls)?.push(node);
  }
  return root;
}

async function fetchTransaction(config: AppConfig, transactionHash: string): Promise<TraceNode> {
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const tx = await rpcCall<{
        from?: string;
        to?: string;
        input?: string;
        value?: string;
      }>(rpcUrl, "eth_getTransactionByHash", [transactionHash], config.httpTimeoutMs);
      return {
        type: "CALL",
        from: tx.from,
        to: tx.to,
        input: tx.input,
        value: tx.value,
      };
    } catch {
      continue;
    }
  }
  throw new Error(`transaction not found: ${transactionHash}`);
}

async function ethCallAddress(
  config: AppConfig,
  address: string,
  selector: string,
  blockHex: string,
): Promise<string | null> {
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const result = await rpcCall<string>(
        rpcUrl,
        "eth_call",
        [{ to: address, data: selector }, blockHex],
        config.httpTimeoutMs,
      );
      return wordToAddress(result);
    } catch {
      continue;
    }
  }
  return null;
}

async function getPairFromFactory(
  config: AppConfig,
  factory: string,
  token0: string,
  token1: string,
  blockHex: string,
): Promise<string | null> {
  const data = encodeFunctionData({
    abi: getPairAbi,
    functionName: "getPair",
    args: [token0 as `0x${string}`, token1 as `0x${string}`],
  });
  for (const rpcUrl of rpcUrls(config)) {
    try {
      const result = await rpcCall<string>(
        rpcUrl,
        "eth_call",
        [{ to: factory, data }, blockHex],
        config.httpTimeoutMs,
      );
      return wordToAddress(result);
    } catch {
      continue;
    }
  }
  return null;
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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

function abiFunctionSelectors(abiText: string): string[] {
  try {
    const abi = JSON.parse(abiText) as Array<{ type?: string; name?: string; inputs?: Array<{ type: string }> }>;
    return uniqueStrings(
      abi
        .filter((item) => item.type === "function" && item.name)
        .map((item) => {
          const signature = `${item.name}(${(item.inputs ?? []).map((input) => input.type).join(",")})`;
          return selectorFromSignature(signature);
        }),
    ).sort();
  } catch {
    return [];
  }
}

function selectorFromSignature(signature: string): string {
  return toFunctionSelector(signature);
}

function opcodePresence(bytecode: string): {
  containsDelegatecallOpcode: boolean;
} {
  const bytes = bytecode.slice(2).toLowerCase();
  for (let i = 0; i < bytes.length; i += 2) {
    const op = Number.parseInt(bytes.slice(i, i + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      i += (op - 0x5f) * 2;
      continue;
    }
    if (op === 0xf4) return { containsDelegatecallOpcode: true };
  }
  return { containsDelegatecallOpcode: false };
}

function implementationFromMinimalProxy(bytecode: string): string | null {
  const lower = bytecode.toLowerCase();
  const prefix = "0x363d3d373d3d3d363d73";
  const suffix = "5af43d82803e903d91602b57fd5bf3";
  if (!lower.startsWith(prefix) || !lower.endsWith(suffix)) return null;
  return `0x${lower.slice(prefix.length, prefix.length + 40)}`;
}

function selectorOf(input: string | undefined): string | null {
  return typeof input === "string" && /^0x[0-9a-fA-F]{8}/.test(input)
    ? input.slice(0, 10).toLowerCase()
    : null;
}

function valueToDecimal(value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value.toString();
  const trimmed = value.trim();
  try {
    return /^0x[0-9a-fA-F]+$/.test(trimmed) ? BigInt(trimmed).toString() : trimmed;
  } catch {
    return trimmed;
  }
}

function wordToAddress(value: string | null | undefined): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) return null;
  const address = `0x${value!.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(address) ? null : address;
}

function normalizeAddress(value: string | undefined): string | null {
  return isAddress(value) ? value.toLowerCase() : null;
}

function isAddress(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isPrecompile(address: string): boolean {
  try {
    const value = BigInt(address);
    return value >= 1n && value <= 9n;
  } catch {
    return false;
  }
}

function parentTracePath(path: string): string | null {
  const index = path.lastIndexOf(".");
  return index === -1 ? null : path.slice(0, index);
}

function decimalBlockToHex(blockNumber: string): string {
  return `0x${BigInt(blockNumber).toString(16)}`;
}

function hashAgreement(values: Array<string | null>): RuntimeCodeEvidence["codeHashAgreement"] {
  const present = values.filter((value): value is string => Boolean(value));
  if (present.length === 0) return "unavailable";
  if (present.length === 1) return "single_rpc";
  return new Set(present.map((value) => value.toLowerCase())).size === 1
    ? "agrees"
    : "disagrees";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sameString(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function rpcUrls(config: AppConfig): string[] {
  return config.rpcUrls.length > 0 ? config.rpcUrls : [config.rpcUrl];
}

// Import anchor: keeps the storage-derived manager path visible in this module's
// dependency graph for audits, without forcing extra live storage reads in tests.
void discoverActiveSwapManager;
void decodeAbiParameters;
