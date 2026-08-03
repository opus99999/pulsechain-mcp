import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { keccak256, type Hex } from "viem";
import type { AppConfig } from "../../../types.js";
import { PULSECHAIN_CHAIN_ID } from "../../../constants.js";
import { ok } from "../../../utils/result.js";
import { registerTool } from "../../define.js";
import { PITEAS_ROUTER } from "./constants.js";
import {
  buildExecutionTrustReport,
  type ExecutionTargetClassification,
  type ExecutionTrustReport,
  type NormalizedExecutionCall,
} from "./executionTrustRegistry.js";
import { deriveSwapManagerStorageLayout } from "./storageLayout.js";
import { sameAddress } from "./inputNormalization.js";

export const TRUST_MANIFEST_DOMAIN_SEPARATOR =
  "PULSECHAIN_MCP_PHIAT_EXECUTION_TRUST_V1" as const;
export const TRUST_MANIFEST_SIGNATURE_ALGORITHM = "Ed25519" as const;

const HISTORICAL_TX =
  "0x1a0d519d0b1ae9e0f759d2a068fa720c3759d5f057b611f91c726ef8db570a56" as const;
const HISTORICAL_BLOCK = "27195532" as const;
const HISTORICAL_GRAPH_FINGERPRINT =
  "0xce502a0183e96397d87830058d9f5435561d3d83d5f862aa89a0fb697eb3e4a0" as const;
const HISTORICAL_BUNDLE_FINGERPRINT =
  "0x31d3699d69625f370d73e9a04e62d636070d9b0019104efe77359202ab00a819" as const;
const CURRENT_ROUTER_HASH =
  "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b" as const;
const CURRENT_MANAGER_ADDRESS =
  "0x58ab37d02696a481e2e5b5779967f3f4d237baa9" as const;
const CURRENT_MANAGER_HASH =
  "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb" as const;
const SMART_ROUTER = "0xf6076d61a0c46c944852f65838e1b12a2910a717" as const;
const SMART_ROUTER_HELPER = "0x2d14e7701ce7d5558eb02f1919ec431a76fb2cad" as const;
const TOKEN_IMPLEMENTATION_539A =
  "0x539a69de74e9ed69fbe7f909fa935d05b8caba11" as const;

export type ManifestExecutionAuthority =
  | "VALID"
  | "INVALID"
  | "EXPIRED"
  | "STATE_MISMATCH";

export type ManifestComparisonFailureCode =
  | "UNEXPECTED_TARGET"
  | "UNEXPECTED_SELECTOR"
  | "UNEXPECTED_EDGE"
  | "CALL_TYPE_MISMATCH"
  | "PARENT_CONSTRAINT_MISMATCH"
  | "CALLER_CONSTRAINT_MISMATCH"
  | "DELEGATECALL_CONTEXT_MISMATCH"
  | "CODE_HASH_MISMATCH"
  | "IMPLEMENTATION_MISMATCH"
  | "FACTORY_MISMATCH"
  | "TOKEN_CONSTRAINT_MISMATCH"
  | "FEE_TIER_MISMATCH"
  | "ROUTER_CHANGED"
  | "SWAP_MANAGER_CHANGED"
  | "MANIFEST_EXPIRED"
  | "PROHIBITED_OPERATION";

export interface TrustManifestParentConstraint {
  parentAddress: string | null;
  parentRole: ExecutionTargetClassification | null;
}

export interface TrustManifestCallerConstraint {
  caller: string | null;
  selector: string | null;
  callType: string;
}

export interface TrustManifestFactoryConstraint {
  factoryAddress: string | null;
  factoryCodeHash: string | null;
  protocol: string | null;
  poolAddress?: string | null;
  fee?: number | null;
  tickSpacing?: number | null;
}

export interface TrustManifestTokenConstraint {
  token0: string | null;
  token1: string | null;
  assets: string[];
  fee?: number | null;
  tickSpacing?: number | null;
}

export interface TrustManifestDelegatecallContext {
  parentAddress: string;
  callerAddress: string;
  allowedSelectors: string[];
}

export interface TrustManifestRecord {
  address: string;
  role: ExecutionTargetClassification;
  runtimeCodeHash: string | null;
  implementationAddress: string | null;
  implementationCodeHash: string | null;
  approvedSelectors: string[];
  allowedCallTypes: string[];
  parentConstraints: TrustManifestParentConstraint[];
  callerConstraints: TrustManifestCallerConstraint[];
  factoryConstraints: TrustManifestFactoryConstraint | null;
  tokenConstraints: TrustManifestTokenConstraint | null;
  managerHashConstraint: string | null;
  routerHashConstraint: string | null;
  delegatecallContext: TrustManifestDelegatecallContext | null;
  firstApprovedBlock: string;
  expiresAtBlock: string | null;
  residualRisks: string[];
}

export interface TrustManifestEdge {
  fromRole: ExecutionTargetClassification | null;
  fromAddress: string | null;
  toRole: ExecutionTargetClassification;
  toAddress: string;
  callType: string;
  selector: string | null;
}

export interface TrustManifest {
  version: "phiat-execution-trust-v1";
  manifestId: string;
  chainId: number;
  historicalTransaction: string;
  historicalBlock: string;
  graphFingerprint: string;
  bundleFingerprint: string;
  router: {
    address: string;
    runtimeCodeHash: string;
  };
  swapManager: {
    address: string;
    runtimeCodeHash: string;
    storageSlot: string;
    storageOffsetBytes: number;
    storageWidthBytes: number;
    managerChangeEventBlock: string | null;
  };
  records: TrustManifestRecord[];
  allowedEdges: TrustManifestEdge[];
  prohibitedOperations: ["CREATE", "CREATE2", "SELFDESTRUCT", "CALLCODE"];
  approvalPolicy: {
    unexpectedTarget: "REJECT";
    unexpectedSelector: "REJECT";
    unexpectedEdge: "REJECT";
    codeHashChange: "REJECT";
    managerChange: "REJECT";
    routerChange: "REJECT";
    expiredManifest: "REJECT";
  };
  approvedAt: string | null;
  approvedAtBlock: string | null;
  expiresAt: string | null;
  expiresAtBlock: string | null;
  operatorPublicKeyId: string;
}

export interface SignedTrustManifest {
  manifest: TrustManifest;
  manifestFingerprint: string;
  signatureAlgorithm: typeof TRUST_MANIFEST_SIGNATURE_ALGORITHM;
  operatorPublicKeyId: string;
  signature: string;
}

export interface VerifiedTrustManifest {
  manifest: TrustManifest | null;
  manifestFingerprint: string | null;
  signatureAlgorithm: string | null;
  operatorPublicKeyId: string | null;
  signature: string | null;
  signatureValid: boolean;
  expired: boolean;
  blockRemaining: string | null;
  millisecondsRemaining: number | null;
  chainRouterManagerConsistent: boolean;
  approvedRecordCount: number;
  invalidRecordCount: number;
  validationErrors: string[];
  executionAuthority: ManifestExecutionAuthority;
}

export interface LiveExecutionGraphCall {
  tracePath?: string;
  from: string | null;
  to: string | null;
  callType: string;
  selector: string | null;
  codeHash?: string | null;
  runtimeCodeHash?: string | null;
  parentAddress?: string | null;
  parentRole?: ExecutionTargetClassification | null;
}

export interface LiveChainStateForManifest {
  chainId: number;
  router: {
    address: string;
    runtimeCodeHash: string | null;
  };
  swapManager: {
    address: string | null;
    runtimeCodeHash: string | null;
    storageSlot?: string | null;
    storageAddress?: string | null;
    managerChangeEventBlock?: string | null;
  };
  currentBlock?: string | null;
  currentTime?: string | null;
  targetCodeHashes?: Record<string, string | null>;
  implementationRelationships?: Array<{
    proxyAddress: string;
    implementationAddress: string | null;
    implementationCodeHash: string | null;
  }>;
  poolStates?: Record<
    string,
    LivePoolStateForManifest
  >;
}

interface LivePoolStateForManifest {
  factoryAddress: string | null;
  token0: string | null;
  token1: string | null;
  fee: number | null;
  tickSpacing?: number | null;
}

export interface ManifestComparisonResult {
  status: "PASSED" | "REJECTED";
  automaticExecutionEligible: boolean;
  failureCodes: ManifestComparisonFailureCode[];
  validationErrors: string[];
}

interface BuildTrustManifestCandidateArgs {
  config: AppConfig;
  historicalTransactionHash?: string;
  pinnedBlock?: string;
  expiresAtBlock?: string;
  expiresAt?: string;
  operatorPublicKeyId?: string;
}

interface TrustManifestCandidateResult {
  manifest: TrustManifest;
  manifestFingerprint: string;
  unresolvedRecords: TrustManifestRecord[];
  residualRisks: string[];
  operatorSignatureRequired: true;
  automaticExecutionEligible: false;
  canonicalization: "RFC8785-subset-canonical-json";
  signaturePayload: {
    domainSeparator: typeof TRUST_MANIFEST_DOMAIN_SEPARATOR;
    manifestFingerprint: string;
    signatureAlgorithm: typeof TRUST_MANIFEST_SIGNATURE_ALGORITHM;
  };
  reviewReport: string;
}

interface ClosedRecordOverride {
  role: ExecutionTargetClassification;
  approvedSelectors: string[];
  allowedCallTypes?: string[];
  factoryConstraints?: TrustManifestFactoryConstraint | null;
  tokenConstraints?: TrustManifestTokenConstraint | null;
  delegatecallContext?: TrustManifestDelegatecallContext | null;
  residualRisks?: string[];
}

const CLOSED_RECORD_OVERRIDES: Record<string, ClosedRecordOverride> = {
  [SMART_ROUTER_HELPER]: {
    role: "PROTOCOL_LIBRARY",
    approvedSelectors: ["0x4e6c8ed8", "0x8bdb1925"],
    allowedCallTypes: ["DELEGATECALL"],
    delegatecallContext: {
      parentAddress: SMART_ROUTER,
      callerAddress: SMART_ROUTER,
      allowedSelectors: ["0x4e6c8ed8", "0x8bdb1925"],
    },
    residualRisks: [
      "Approval is valid only as a SmartRouter delegatecall library, never as a global address approval.",
    ],
  },
  [SMART_ROUTER]: {
    role: "PROTOCOL_ROUTER",
    approvedSelectors: ["0x04e45aaf", "0x23a69e75"],
    residualRisks: [
      "SmartRouter can initiate downstream protocol calls; exact edge constraints are required.",
    ],
  },
  "0xe3acfa6c40d53c3faf2aa62d0a715c737071511c": {
    role: "STABLE_POOL",
    approvedSelectors: ["0x5b41b908"],
    residualRisks: ["Stable-pool state changes are route-local only."],
  },
  "0x796fcbdc956b85797efe21145aa97599b7fb36a6": {
    role: "PROTOCOL_FACTORY",
    approvedSelectors: ["0x07200e33"],
    allowedCallTypes: ["STATICCALL"],
    residualRisks: ["Only feeProtocolDistributionInfo() is included; mutators are not approved."],
  },
  "0x55b432ad0518a4285ded6bb4d15e9a7182ef7a4d": {
    role: "V3_POOL",
    approvedSelectors: ["0x128acb08"],
    factoryConstraints: {
      factoryAddress: "0xe50dbdc88e87a2c92984d794bcf3d1d76f619c68",
      factoryCodeHash: "0x7c7dc7bf84221881cc7961d92b890d2d93036ae0f34c8e6177ff6e5ee6a43971",
      protocol: "PancakeSwap V3",
      poolAddress: "0x55b432ad0518a4285ded6bb4d15e9a7182ef7a4d",
      fee: 10000,
      tickSpacing: 200,
    },
    tokenConstraints: {
      token0: "0x6b175474e89094c44da98b954eedeac495271d0f",
      token1: "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
      assets: [
        "0x6b175474e89094c44da98b954eedeac495271d0f",
        "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
      ],
      fee: 10000,
      tickSpacing: 200,
    },
  },
  "0x096af49f24293318661cbbf749a1e3f93ce1fbb2": {
    role: "V3_POOL",
    approvedSelectors: ["0x128acb08"],
    factoryConstraints: libertyFactory("0x096af49f24293318661cbbf749a1e3f93ce1fbb2", 2500, 50),
    tokenConstraints: tokenPair(
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
      2500,
      50,
    ),
  },
  "0x13500f3449e337464eb8b5897dc2b06fe3fa692a": {
    role: "V3_POOL",
    approvedSelectors: ["0x128acb08"],
    factoryConstraints: libertyFactory("0x13500f3449e337464eb8b5897dc2b06fe3fa692a", 2500, 50),
    tokenConstraints: tokenPair(
      "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07",
      "0xc10a4ed9b4042222d69ff0b374eddd47ed90fc1f",
      2500,
      50,
    ),
  },
  "0x475e1f945427cc02bfb2d76f111c5541413505c0": {
    role: "V3_POOL",
    approvedSelectors: ["0x128acb08"],
    factoryConstraints: libertyFactory("0x475e1f945427cc02bfb2d76f111c5541413505c0", 10000, 200),
    tokenConstraints: tokenPair(
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0xc10a4ed9b4042222d69ff0b374eddd47ed90fc1f",
      10000,
      200,
    ),
  },
  "0x042ff2668957c7ad7d8b42232af59f339803cd10": {
    role: "V3_POOL",
    approvedSelectors: ["0x128acb08"],
    factoryConstraints: libertyFactory("0x042ff2668957c7ad7d8b42232af59f339803cd10", 2500, 50),
    tokenConstraints: tokenPair(
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0xc10a4ed9b4042222d69ff0b374eddd47ed90fc1f",
      2500,
      50,
    ),
  },
};

function libertyFactory(poolAddress: string, fee: number, tickSpacing: number): TrustManifestFactoryConstraint {
  return {
    factoryAddress: "0x796fcbdc956b85797efe21145aa97599b7fb36a6",
    factoryCodeHash: "0x06980a00918587c043af9085626962ebb94f9d0482e0028ff9a9f233d34cebd3",
    protocol: "LibertySwap V3 fork",
    poolAddress,
    fee,
    tickSpacing,
  };
}

function tokenPair(
  token0: string,
  token1: string,
  fee: number,
  tickSpacing: number,
): TrustManifestTokenConstraint {
  return {
    token0,
    token1,
    assets: [token0, token1],
    fee,
    tickSpacing,
  };
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

export function canonicalManifestBytes(manifest: TrustManifest): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(manifest));
}

export function manifestFingerprint(manifest: TrustManifest): string {
  return keccak256(bytesToHex(canonicalManifestBytes(manifest)));
}

export function signedManifestPayload(manifest: TrustManifest): Buffer {
  const canonicalBytes = Buffer.from(canonicalManifestBytes(manifest));
  const fingerprintBytes = Buffer.from(manifestFingerprint(manifest).slice(2), "hex");
  return Buffer.concat([
    Buffer.from(TRUST_MANIFEST_DOMAIN_SEPARATOR, "utf8"),
    canonicalBytes,
    fingerprintBytes,
  ]);
}

export function publicKeyIdFromSpkiDerBase64(publicKeySpkiDerBase64: string): string {
  const bytes = Buffer.from(publicKeySpkiDerBase64, "base64");
  return keccak256(bytesToHex(bytes));
}

export async function buildTrustManifestCandidate(
  args: BuildTrustManifestCandidateArgs,
): Promise<TrustManifestCandidateResult> {
  const report = await buildExecutionTrustReport({
    config: args.config,
    historicalTransactionHash: args.historicalTransactionHash ?? HISTORICAL_TX,
    pinnedBlock: args.pinnedBlock ?? HISTORICAL_BLOCK,
    includeSourceLookup: true,
    includeFactoryVerification: true,
  });
  return buildTrustManifestCandidateFromReport(report, {
    expiresAtBlock: args.expiresAtBlock,
    expiresAt: args.expiresAt,
    operatorPublicKeyId: args.operatorPublicKeyId,
  });
}

export function buildTrustManifestCandidateFromReport(
  report: ExecutionTrustReport,
  args: {
    expiresAtBlock?: string;
    expiresAt?: string;
    operatorPublicKeyId?: string;
    approvedAt?: string | null;
    approvedAtBlock?: string | null;
  } = {},
): TrustManifestCandidateResult {
  const expiresAt = args.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const expiresAtBlock = args.expiresAtBlock ?? null;
  const closed = isClosedHistoricalReport(report);
  const records = report.candidateRecords
    .filter((record) => record.role !== "EOA" && record.role !== "PRECOMPILE")
    .map((record) => manifestRecordFromCandidate(report, record.normalizedAddress, closed, expiresAtBlock))
    .sort((a, b) => a.address.localeCompare(b.address));
  const unresolvedRecords = records.filter((record) =>
    closed ? false : record.residualRisks.some((risk) => risk.startsWith("unresolved:")),
  );
  const layout = deriveSwapManagerStorageLayout();
  const manifestWithoutId: Omit<TrustManifest, "manifestId"> = {
    version: "phiat-execution-trust-v1",
    chainId: PULSECHAIN_CHAIN_ID,
    historicalTransaction: report.historicalTransaction.toLowerCase(),
    historicalBlock: report.historicalBlock,
    graphFingerprint: report.routeTrustBundle.graphFingerprint,
    bundleFingerprint: report.routeTrustBundle.bundleFingerprint,
    router: {
      address: PITEAS_ROUTER.toLowerCase(),
      runtimeCodeHash: CURRENT_ROUTER_HASH,
    },
    swapManager: {
      address: CURRENT_MANAGER_ADDRESS,
      runtimeCodeHash: CURRENT_MANAGER_HASH,
      storageSlot: layout.slot,
      storageOffsetBytes: layout.offsetBytes,
      storageWidthBytes: layout.widthBytes,
      managerChangeEventBlock: null,
    },
    records,
    allowedEdges: allowedEdges(report.normalizedCalls, closed),
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
    approvedAt: args.approvedAt ?? null,
    approvedAtBlock: args.approvedAtBlock ?? null,
    expiresAt,
    expiresAtBlock,
    operatorPublicKeyId: args.operatorPublicKeyId ?? "operator-key-id-required",
  };
  const manifestId = keccak256(
    bytesToHex(new TextEncoder().encode(canonicalizeJson(manifestWithoutId))),
  );
  const manifest: TrustManifest = { manifestId, ...manifestWithoutId };
  const fp = manifestFingerprint(manifest);
  const residualRisks = uniqueStrings(records.flatMap((record) => record.residualRisks));
  return {
    manifest,
    manifestFingerprint: fp,
    unresolvedRecords,
    residualRisks,
    operatorSignatureRequired: true,
    automaticExecutionEligible: false,
    canonicalization: "RFC8785-subset-canonical-json",
    signaturePayload: {
      domainSeparator: TRUST_MANIFEST_DOMAIN_SEPARATOR,
      manifestFingerprint: fp,
      signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    },
    reviewReport: renderTrustManifestReview(manifest, residualRisks),
  };
}

export function verifySignedTrustManifest(
  signedManifestInput: unknown,
  args: {
    pinnedPublicKeys: Record<string, string>;
    expectedOperatorPublicKeyId?: string;
    nowMs?: number;
    currentBlock?: string | null;
  },
): VerifiedTrustManifest {
  const validationErrors: string[] = [];
  const parsed = parseSignedManifest(signedManifestInput);
  if (!parsed.ok) {
    return invalidVerification([parsed.error]);
  }
  const signedManifest = parsed.value;
  const manifest = signedManifest.manifest;
  const shapeErrors = manifestShapeErrors(manifest);
  if (shapeErrors.length > 0) return invalidVerification(shapeErrors);
  const canonicalFingerprint = manifestFingerprint(manifest);
  if (signedManifest.manifestFingerprint !== canonicalFingerprint) {
    validationErrors.push("MANIFEST_FINGERPRINT_MISMATCH");
  }
  if (signedManifest.signatureAlgorithm !== TRUST_MANIFEST_SIGNATURE_ALGORITHM) {
    validationErrors.push("UNSUPPORTED_SIGNATURE_ALGORITHM");
  }
  if (args.expectedOperatorPublicKeyId && signedManifest.operatorPublicKeyId !== args.expectedOperatorPublicKeyId) {
    validationErrors.push("OPERATOR_PUBLIC_KEY_ID_MISMATCH");
  }
  if (manifest.operatorPublicKeyId !== signedManifest.operatorPublicKeyId) {
    validationErrors.push("MANIFEST_OPERATOR_KEY_ID_MISMATCH");
  }
  const publicKey = args.pinnedPublicKeys[signedManifest.operatorPublicKeyId];
  if (!publicKey) validationErrors.push("OPERATOR_PUBLIC_KEY_NOT_PINNED");
  const signatureValid =
    publicKey !== undefined &&
    validationErrors.filter((error) => error === "UNSUPPORTED_SIGNATURE_ALGORITHM").length === 0 &&
    verifyEd25519Signature(publicKey, signedManifest.signature, signedManifestPayload(manifest));
  if (!signatureValid) validationErrors.push("SIGNATURE_INVALID");

  const expiration = expirationStatus(manifest, args.nowMs ?? Date.now(), args.currentBlock ?? null);
  validationErrors.push(...expiration.errors);
  const consistencyErrors = manifestConsistencyErrors(manifest);
  validationErrors.push(...consistencyErrors);
  const invalidRecordCount = manifest.records.filter((record) => recordErrors(record).length > 0).length;
  if (invalidRecordCount > 0) validationErrors.push("INVALID_RECORDS");
  const chainRouterManagerConsistent = consistencyErrors.length === 0;
  const invalidAuthority = validationErrors.some((error) => !consistencyErrors.includes(error)) ||
    !signatureValid ||
    invalidRecordCount > 0;
  const executionAuthority: ManifestExecutionAuthority = invalidAuthority
    ? "INVALID"
    : expiration.expired
      ? "EXPIRED"
      : chainRouterManagerConsistent
        ? "VALID"
        : "STATE_MISMATCH";
  return {
    manifest,
    manifestFingerprint: canonicalFingerprint,
    signatureAlgorithm: signedManifest.signatureAlgorithm,
    operatorPublicKeyId: signedManifest.operatorPublicKeyId,
    signature: signedManifest.signature,
    signatureValid,
    expired: expiration.expired,
    blockRemaining: expiration.blockRemaining,
    millisecondsRemaining: expiration.millisecondsRemaining,
    chainRouterManagerConsistent,
    approvedRecordCount: manifest.records.length - invalidRecordCount,
    invalidRecordCount,
    validationErrors: uniqueStrings(validationErrors),
    executionAuthority,
  };
}

export function compareLiveExecutionGraphToApprovedManifest(
  liveGraph: LiveExecutionGraphCall[] | { calls?: LiveExecutionGraphCall[] },
  verifiedManifest: VerifiedTrustManifest,
  liveChainState: LiveChainStateForManifest,
): ManifestComparisonResult {
  const manifest = verifiedManifest.manifest;
  const failureCodes: ManifestComparisonFailureCode[] = [];
  const validationErrors: string[] = [];
  if (!manifest || verifiedManifest.executionAuthority !== "VALID") {
    if (verifiedManifest.executionAuthority === "EXPIRED") failureCodes.push("MANIFEST_EXPIRED");
    else failureCodes.push("UNEXPECTED_TARGET");
    validationErrors.push(`manifest_authority_${verifiedManifest.executionAuthority.toLowerCase()}`);
    return comparisonResult(failureCodes, validationErrors);
  }
  if (liveChainState.chainId !== manifest.chainId) failureCodes.push("ROUTER_CHANGED");
  if (!sameAddress(liveChainState.router.address, manifest.router.address) ||
    lower(liveChainState.router.runtimeCodeHash) !== lower(manifest.router.runtimeCodeHash)) {
    failureCodes.push("ROUTER_CHANGED");
  }
  if (!sameNullableAddress(liveChainState.swapManager.address, manifest.swapManager.address) ||
    lower(liveChainState.swapManager.runtimeCodeHash) !== lower(manifest.swapManager.runtimeCodeHash) ||
    (liveChainState.swapManager.storageAddress &&
      !sameAddress(liveChainState.swapManager.storageAddress, manifest.swapManager.address))) {
    failureCodes.push("SWAP_MANAGER_CHANGED");
  }
  const expiration = expirationStatus(
    manifest,
    liveChainState.currentTime ? Date.parse(liveChainState.currentTime) : Date.now(),
    liveChainState.currentBlock ?? null,
  );
  if (expiration.expired) failureCodes.push("MANIFEST_EXPIRED");

  const calls = Array.isArray(liveGraph) ? liveGraph : liveGraph.calls ?? [];
  const recordByAddress = new Map(manifest.records.map((record) => [record.address, record]));
  const edgeSet = new Set(manifest.allowedEdges.map(edgeKey));
  const expectedStateChangingEdges = new Set(
    manifest.allowedEdges
      .filter((edge) => isStateChangingCallType(edge.callType, manifest.prohibitedOperations))
      .map(edgeKey),
  );
  const observedStateChangingEdges = new Set<string>();
  for (const call of calls) {
    const callType = call.callType.toUpperCase();
    if (manifest.prohibitedOperations.includes(callType as never)) {
      failureCodes.push("PROHIBITED_OPERATION");
      continue;
    }
    if (!call.to || callType === "STATICCALL") continue;
    const to = call.to.toLowerCase();
    const record = recordByAddress.get(to);
    if (!record) {
      failureCodes.push("UNEXPECTED_TARGET");
      continue;
    }
    if (!record.allowedCallTypes.map((value) => value.toUpperCase()).includes(callType)) {
      failureCodes.push("CALL_TYPE_MISMATCH");
    }
    if (call.selector && !record.approvedSelectors.map(lower).includes(call.selector.toLowerCase())) {
      failureCodes.push("UNEXPECTED_SELECTOR");
    }
    if (!edgeSet.has(edgeKeyForCall(call, record, manifest))) {
      failureCodes.push("UNEXPECTED_EDGE");
    }
    if (isStateChangingCallType(callType, manifest.prohibitedOperations)) {
      observedStateChangingEdges.add(edgeKeyForCall(call, record, manifest));
    }
    const observedHash = lower(
      call.codeHash ?? call.runtimeCodeHash ?? liveChainState.targetCodeHashes?.[to],
    );
    if (record.runtimeCodeHash && observedHash !== lower(record.runtimeCodeHash)) {
      failureCodes.push("CODE_HASH_MISMATCH");
    }
    if (!parentConstraintMatches(record, call)) failureCodes.push("PARENT_CONSTRAINT_MISMATCH");
    if (!callerConstraintMatches(record, call)) failureCodes.push("CALLER_CONSTRAINT_MISMATCH");
    if (!delegatecallContextMatches(record, call)) failureCodes.push("DELEGATECALL_CONTEXT_MISMATCH");
    if (!implementationRelationshipMatches(record, call, liveChainState)) {
      failureCodes.push("IMPLEMENTATION_MISMATCH");
    }
    const poolState = liveChainState.poolStates?.[to];
    if (record.factoryConstraints && !factoryMatches(record.factoryConstraints, poolState)) {
      failureCodes.push("FACTORY_MISMATCH");
    }
    if (record.tokenConstraints && !tokenConstraintMatches(record.tokenConstraints, poolState)) {
      failureCodes.push("TOKEN_CONSTRAINT_MISMATCH");
    }
    if (
      record.tokenConstraints?.fee !== undefined &&
      poolState &&
      poolState.fee !== record.tokenConstraints.fee
    ) {
      failureCodes.push("FEE_TIER_MISMATCH");
    }
  }
  if (!sameSet(expectedStateChangingEdges, observedStateChangingEdges)) {
    failureCodes.push("UNEXPECTED_EDGE");
  }
  return comparisonResult(failureCodes, validationErrors);
}

export function registerPhiatTrustManifestTools(server: McpServer, config: AppConfig): void {
  registerTool(server, config, {
    name: "phiat_trust_manifest_candidate",
    description:
      "Read-only unsigned PHIAT/Piteas execution trust manifest candidate. It canonicalizes historical evidence and requires an external operator signature before any authority exists.",
    category: "analytics",
    write: false,
    inputSchema: {
      historicalTransactionHash: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/)
        .default(HISTORICAL_TX),
      pinnedBlock: z.string().regex(/^\d+$/).optional(),
      expiresAtBlock: z.string().regex(/^\d+$/).optional(),
      expiresAt: z.string().datetime().optional(),
      operatorPublicKeyId: z.string().min(1).max(128).optional(),
    },
    handler: async (args, cfg) =>
      ok(
        await buildTrustManifestCandidate({
          config: cfg,
          historicalTransactionHash: args.historicalTransactionHash as string | undefined,
          pinnedBlock: args.pinnedBlock as string | undefined,
          expiresAtBlock: args.expiresAtBlock as string | undefined,
          expiresAt: args.expiresAt as string | undefined,
          operatorPublicKeyId: args.operatorPublicKeyId as string | undefined,
        }),
      ),
  });

  registerTool(server, config, {
    name: "phiat_trust_manifest_verify",
    description:
      "Read-only PHIAT/Piteas execution trust manifest verifier. Verifies canonical fingerprint, pinned Ed25519 operator signature, expiration, and static router/manager constraints.",
    category: "analytics",
    write: false,
    inputSchema: {
      signedManifest: z.union([z.record(z.string(), z.unknown()), z.string()]),
      expectedOperatorPublicKeyId: z.string().min(1).optional(),
    },
    handler: async (args, cfg) =>
      ok(
        verifySignedTrustManifest(args.signedManifest, {
          pinnedPublicKeys: cfg.phiatTrustOperatorPublicKeys ?? {},
          expectedOperatorPublicKeyId: args.expectedOperatorPublicKeyId as string | undefined,
        }),
      ),
  });
}

function manifestRecordFromCandidate(
  report: ExecutionTrustReport,
  address: string,
  closed: boolean,
  expiresAtBlock: string | null,
): TrustManifestRecord {
  const record = report.candidateRecords.find((candidate) => candidate.normalizedAddress === address);
  if (!record) throw new Error(`Missing trust record ${address}`);
  const override = closed ? CLOSED_RECORD_OVERRIDES[address] : undefined;
  const observedSelectors = uniqueStrings(record.observedSelectors.map((value) => value.toLowerCase())).sort();
  const parentConstraints = record.parentConstraints.map((constraint) => ({
    parentAddress: constraint.parentAddress ? constraint.parentAddress.toLowerCase() : null,
    parentRole: constraint.parentRole,
  }));
  const callerConstraints = record.callerConstraints.map((constraint) => ({
    caller: constraint.caller ? constraint.caller.toLowerCase() : null,
    selector: constraint.selector ? constraint.selector.toLowerCase() : null,
    callType: constraint.callType.toUpperCase(),
  }));
  const role = override?.role ?? record.role;
  return {
    address,
    role,
    runtimeCodeHash: record.runtimeCodeHash?.toLowerCase() ?? null,
    implementationAddress: implementationAddressFor(record.implementationAddress, address),
    implementationCodeHash: record.implementationCodeHash?.toLowerCase() ?? null,
    approvedSelectors: uniqueStrings(
      (override?.approvedSelectors ?? observedSelectors).map((value) => value.toLowerCase()),
    ).sort(),
    allowedCallTypes: uniqueStrings(
      (override?.allowedCallTypes ?? callerConstraints.map((constraint) => constraint.callType)).map((value) =>
        value.toUpperCase(),
      ),
    ).sort(),
    parentConstraints,
    callerConstraints,
    factoryConstraints: override?.factoryConstraints ?? factoryConstraintFromRecord(record),
    tokenConstraints: override?.tokenConstraints ?? tokenConstraintFromRecord(record),
    managerHashConstraint: record.managerCodeHashConstraint?.toLowerCase() ?? null,
    routerHashConstraint: CURRENT_ROUTER_HASH,
    delegatecallContext: delegatecallContextFor(address, override, callerConstraints),
    firstApprovedBlock: report.historicalBlock,
    expiresAtBlock,
    residualRisks: residualRisks(record.unresolvedReasons, override),
  };
}

function implementationAddressFor(value: string | null, address: string): string | null {
  if (!value) return null;
  if (sameAddress(value, address) && sameAddress(address, TOKEN_IMPLEMENTATION_539A)) return address;
  return value.toLowerCase();
}

function factoryConstraintFromRecord(record: ExecutionTrustReport["candidateRecords"][number]): TrustManifestFactoryConstraint | null {
  if (!record.factoryAddress && !record.factoryCodeHash) return null;
  return {
    factoryAddress: record.factoryAddress?.toLowerCase() ?? null,
    factoryCodeHash: record.factoryCodeHash?.toLowerCase() ?? null,
    protocol: null,
  };
}

function tokenConstraintFromRecord(record: ExecutionTrustReport["candidateRecords"][number]): TrustManifestTokenConstraint | null {
  if (!record.tokenConstraints) return null;
  return {
    token0: record.tokenConstraints.token0?.toLowerCase() ?? null,
    token1: record.tokenConstraints.token1?.toLowerCase() ?? null,
    assets: record.tokenConstraints.assets.map((value) => value.toLowerCase()).sort(),
  };
}

function delegatecallContextFor(
  address: string,
  override: ClosedRecordOverride | undefined,
  callerConstraints: TrustManifestCallerConstraint[],
): TrustManifestDelegatecallContext | null {
  if (override?.delegatecallContext) return override.delegatecallContext;
  if (!sameAddress(address, TOKEN_IMPLEMENTATION_539A)) return null;
  const delegatecall = callerConstraints.find((constraint) => constraint.callType === "DELEGATECALL");
  return delegatecall?.caller
    ? {
        parentAddress: delegatecall.caller,
        callerAddress: delegatecall.caller,
        allowedSelectors: callerConstraints
          .filter((constraint) => constraint.callType === "DELEGATECALL" && constraint.selector)
          .map((constraint) => constraint.selector!.toLowerCase())
          .sort(),
      }
    : null;
}

function residualRisks(unresolvedReasons: string[], override: ClosedRecordOverride | undefined): string[] {
  const risks = [...(override?.residualRisks ?? [])];
  if (!override) risks.push(...unresolvedReasons.map((reason) => `unresolved:${reason}`));
  return uniqueStrings(risks).sort();
}

function allowedEdges(calls: NormalizedExecutionCall[], closed: boolean): TrustManifestEdge[] {
  const byAddress = new Map<string, ExecutionTargetClassification>();
  for (const call of calls) {
    if (!call.to) continue;
    byAddress.set(call.to, closed && CLOSED_RECORD_OVERRIDES[call.to] ? CLOSED_RECORD_OVERRIDES[call.to]!.role : call.classification);
  }
  const seen = new Set<string>();
  const edges: TrustManifestEdge[] = [];
  for (const call of calls) {
    if (!call.to || call.classification === "EOA" || call.classification === "PRECOMPILE") continue;
    const edge: TrustManifestEdge = {
      fromRole: call.from ? byAddress.get(call.from) ?? null : null,
      fromAddress: call.from,
      toRole: byAddress.get(call.to) ?? call.classification,
      toAddress: call.to,
      callType: call.callType.toUpperCase(),
      selector: call.selector?.toLowerCase() ?? null,
    };
    const key = edgeKey(edge);
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

function isClosedHistoricalReport(report: ExecutionTrustReport): boolean {
  return (
    report.historicalTransaction.toLowerCase() === HISTORICAL_TX &&
    report.historicalBlock === HISTORICAL_BLOCK &&
    report.routeTrustBundle.graphFingerprint === HISTORICAL_GRAPH_FINGERPRINT &&
    report.routeTrustBundle.bundleFingerprint === HISTORICAL_BUNDLE_FINGERPRINT &&
    report.routeTrustBundle.prohibitedOperations.length === 0
  );
}

function renderTrustManifestReview(manifest: TrustManifest, residualRisks: string[]): string {
  const lines = [
    `PHIAT execution trust manifest ${manifest.manifestId}`,
    `graph ${manifest.graphFingerprint}`,
    `bundle ${manifest.bundleFingerprint}`,
    `router ${manifest.router.address} ${manifest.router.runtimeCodeHash}`,
    `manager ${manifest.swapManager.address} ${manifest.swapManager.runtimeCodeHash}`,
    `expiresAt ${manifest.expiresAt ?? "none"} expiresAtBlock ${manifest.expiresAtBlock ?? "none"}`,
    `prohibited ${manifest.prohibitedOperations.join(",")}`,
    "records:",
  ];
  for (const record of manifest.records) {
    lines.push(
      `- ${record.address} role=${record.role} codeHash=${record.runtimeCodeHash ?? "none"} selectors=${record.approvedSelectors.join(",") || "none"} callTypes=${record.allowedCallTypes.join(",")}`,
    );
    if (record.parentConstraints.length > 0) {
      lines.push(`  parents=${JSON.stringify(record.parentConstraints)}`);
    }
    if (record.callerConstraints.length > 0) {
      lines.push(`  callers=${JSON.stringify(record.callerConstraints)}`);
    }
    if (record.factoryConstraints) lines.push(`  factory=${JSON.stringify(record.factoryConstraints)}`);
    if (record.tokenConstraints) lines.push(`  tokens=${JSON.stringify(record.tokenConstraints)}`);
    if (record.residualRisks.length > 0) lines.push(`  residualRisks=${record.residualRisks.join("; ")}`);
  }
  if (residualRisks.length > 0) lines.push(`manifestResidualRisks=${residualRisks.join("; ")}`);
  return lines.join("\n");
}

function parseSignedManifest(input: unknown): { ok: true; value: SignedTrustManifest } | { ok: false; error: string } {
  const parsedInput = typeof input === "string" ? safeJsonParse(input) : input;
  if (parsedInput === null || typeof parsedInput !== "object") {
    return { ok: false, error: "SIGNED_MANIFEST_NOT_OBJECT" };
  }
  const obj = parsedInput as Partial<SignedTrustManifest>;
  if (!obj.manifest || typeof obj.manifest !== "object") return { ok: false, error: "MANIFEST_MISSING" };
  if (typeof obj.manifestFingerprint !== "string") return { ok: false, error: "MANIFEST_FINGERPRINT_MISSING" };
  if (typeof obj.signatureAlgorithm !== "string") return { ok: false, error: "SIGNATURE_ALGORITHM_MISSING" };
  if (typeof obj.operatorPublicKeyId !== "string") return { ok: false, error: "OPERATOR_PUBLIC_KEY_ID_MISSING" };
  if (typeof obj.signature !== "string") return { ok: false, error: "SIGNATURE_MISSING" };
  return { ok: true, value: obj as SignedTrustManifest };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function verifyEd25519Signature(publicKeySpkiDerBase64: string, signatureBase64: string, payload: Buffer): boolean {
  try {
    const key = publicKeyFromSpki(publicKeySpkiDerBase64);
    return verifySignature(null, payload, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function publicKeyFromSpki(publicKeySpkiDerBase64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(publicKeySpkiDerBase64, "base64"),
    format: "der",
    type: "spki",
  });
}

function expirationStatus(
  manifest: TrustManifest,
  nowMs: number,
  currentBlock: string | null,
): {
  expired: boolean;
  blockRemaining: string | null;
  millisecondsRemaining: number | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (!manifest.expiresAt && !manifest.expiresAtBlock) errors.push("EXPIRATION_REQUIRED");
  let expired = false;
  let blockRemaining: string | null = null;
  let millisecondsRemaining: number | null = null;
  if (manifest.expiresAt) {
    const expiresMs = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresMs)) errors.push("EXPIRES_AT_INVALID");
    else {
      millisecondsRemaining = expiresMs - nowMs;
      if (millisecondsRemaining < 0) expired = true;
    }
  }
  if (manifest.expiresAtBlock && currentBlock) {
    try {
      const remaining = BigInt(manifest.expiresAtBlock) - BigInt(currentBlock);
      blockRemaining = remaining.toString();
      if (remaining < 0n) expired = true;
    } catch {
      errors.push("EXPIRES_AT_BLOCK_INVALID");
    }
  }
  return { expired, blockRemaining, millisecondsRemaining, errors };
}

function manifestConsistencyErrors(manifest: TrustManifest): string[] {
  const errors: string[] = [];
  if (manifest.chainId !== PULSECHAIN_CHAIN_ID) errors.push("CHAIN_ID_MISMATCH");
  if (!sameAddress(manifest.router.address, PITEAS_ROUTER)) errors.push("ROUTER_ADDRESS_MISMATCH");
  if (lower(manifest.router.runtimeCodeHash) !== CURRENT_ROUTER_HASH) errors.push("ROUTER_CODE_HASH_MISMATCH");
  if (!sameAddress(manifest.swapManager.address, CURRENT_MANAGER_ADDRESS)) errors.push("MANAGER_ADDRESS_MISMATCH");
  if (lower(manifest.swapManager.runtimeCodeHash) !== CURRENT_MANAGER_HASH) errors.push("MANAGER_CODE_HASH_MISMATCH");
  if (manifest.graphFingerprint !== HISTORICAL_GRAPH_FINGERPRINT) errors.push("GRAPH_FINGERPRINT_MISMATCH");
  if (manifest.bundleFingerprint !== HISTORICAL_BUNDLE_FINGERPRINT) errors.push("BUNDLE_FINGERPRINT_MISMATCH");
  return errors;
}

function manifestShapeErrors(manifest: TrustManifest): string[] {
  const value = manifest as unknown as Partial<TrustManifest>;
  const errors: string[] = [];
  if (value.version !== "phiat-execution-trust-v1") errors.push("VERSION_INVALID");
  if (typeof value.manifestId !== "string") errors.push("MANIFEST_ID_MISSING");
  if (typeof value.chainId !== "number") errors.push("CHAIN_ID_MISSING");
  if (typeof value.historicalTransaction !== "string") errors.push("HISTORICAL_TRANSACTION_MISSING");
  if (typeof value.historicalBlock !== "string") errors.push("HISTORICAL_BLOCK_MISSING");
  if (typeof value.graphFingerprint !== "string") errors.push("GRAPH_FINGERPRINT_MISSING");
  if (typeof value.bundleFingerprint !== "string") errors.push("BUNDLE_FINGERPRINT_MISSING");
  if (!value.router || typeof value.router.address !== "string" || typeof value.router.runtimeCodeHash !== "string") {
    errors.push("ROUTER_CONSTRAINT_MISSING");
  }
  if (
    !value.swapManager ||
    typeof value.swapManager.address !== "string" ||
    typeof value.swapManager.runtimeCodeHash !== "string"
  ) {
    errors.push("SWAP_MANAGER_CONSTRAINT_MISSING");
  }
  if (!Array.isArray(value.records)) errors.push("RECORDS_MISSING");
  if (!Array.isArray(value.allowedEdges)) errors.push("ALLOWED_EDGES_MISSING");
  if (!Array.isArray(value.prohibitedOperations)) errors.push("PROHIBITED_OPERATIONS_MISSING");
  if (!value.approvalPolicy || typeof value.approvalPolicy !== "object") errors.push("APPROVAL_POLICY_MISSING");
  if (typeof value.operatorPublicKeyId !== "string") errors.push("MANIFEST_OPERATOR_KEY_ID_MISSING");
  return errors;
}

function recordErrors(record: TrustManifestRecord): string[] {
  const errors: string[] = [];
  if (!/^0x[a-f0-9]{40}$/.test(record.address)) errors.push("BAD_ADDRESS");
  if (record.runtimeCodeHash && !/^0x[a-f0-9]{64}$/.test(record.runtimeCodeHash)) errors.push("BAD_CODE_HASH");
  if (!Array.isArray(record.approvedSelectors)) {
    errors.push("BAD_SELECTOR_LIST");
    return errors;
  }
  if (!Array.isArray(record.allowedCallTypes)) errors.push("BAD_CALL_TYPE_LIST");
  if (!Array.isArray(record.parentConstraints)) errors.push("BAD_PARENT_CONSTRAINTS");
  if (!Array.isArray(record.callerConstraints)) errors.push("BAD_CALLER_CONSTRAINTS");
  if (errors.length > 0) return errors;
  if (record.approvedSelectors.some((selector) => !/^0x[a-f0-9]{8}$/.test(selector))) {
    errors.push("BAD_SELECTOR");
  }
  if (
    sameAddress(record.address, SMART_ROUTER_HELPER) &&
    (!record.delegatecallContext ||
      !sameAddress(record.delegatecallContext.parentAddress, SMART_ROUTER) ||
      record.approvedSelectors.some((selector) => !["0x4e6c8ed8", "0x8bdb1925"].includes(selector)))
  ) {
    errors.push("SMART_ROUTER_HELPER_CONTEXT_INVALID");
  }
  if (sameAddress(record.address, TOKEN_IMPLEMENTATION_539A) && record.parentConstraints.length === 0) {
    errors.push("TOKEN_IMPLEMENTATION_PARENT_REQUIRED");
  }
  return errors;
}

function invalidVerification(validationErrors: string[]): VerifiedTrustManifest {
  return {
    manifest: null,
    manifestFingerprint: null,
    signatureAlgorithm: null,
    operatorPublicKeyId: null,
    signature: null,
    signatureValid: false,
    expired: false,
    blockRemaining: null,
    millisecondsRemaining: null,
    chainRouterManagerConsistent: false,
    approvedRecordCount: 0,
    invalidRecordCount: 0,
    validationErrors,
    executionAuthority: "INVALID",
  };
}

function parentConstraintMatches(record: TrustManifestRecord, call: LiveExecutionGraphCall): boolean {
  if (record.parentConstraints.length === 0) return true;
  const parentAddress = call.parentAddress ?? call.from;
  return record.parentConstraints.some((constraint) =>
    sameNullableAddress(constraint.parentAddress, parentAddress) &&
    (call.parentRole === undefined || constraint.parentRole === null || call.parentRole === constraint.parentRole),
  );
}

function callerConstraintMatches(record: TrustManifestRecord, call: LiveExecutionGraphCall): boolean {
  return record.callerConstraints.some((constraint) =>
    sameNullableAddress(constraint.caller, call.from) &&
    lower(constraint.selector) === lower(call.selector) &&
    constraint.callType.toUpperCase() === call.callType.toUpperCase(),
  );
}

function delegatecallContextMatches(record: TrustManifestRecord, call: LiveExecutionGraphCall): boolean {
  if (call.callType.toUpperCase() !== "DELEGATECALL") return true;
  if (!record.delegatecallContext) return false;
  return (
    sameNullableAddress(record.delegatecallContext.parentAddress, call.parentAddress ?? call.from) &&
    sameNullableAddress(record.delegatecallContext.callerAddress, call.from) &&
    (call.selector === null || record.delegatecallContext.allowedSelectors.map(lower).includes(call.selector.toLowerCase()))
  );
}

function implementationRelationshipMatches(
  record: TrustManifestRecord,
  call: LiveExecutionGraphCall,
  liveChainState: LiveChainStateForManifest,
): boolean {
  if (!sameAddress(record.address, TOKEN_IMPLEMENTATION_539A)) return true;
  const proxy = call.parentAddress ?? call.from;
  if (!proxy) return false;
  if (!record.parentConstraints.some((constraint) => sameNullableAddress(constraint.parentAddress, proxy))) {
    return false;
  }
  const relationship = liveChainState.implementationRelationships?.find((candidate) =>
    sameAddress(candidate.proxyAddress, proxy),
  );
  if (!relationship) return false;
  return (
    sameNullableAddress(relationship.implementationAddress, record.address) &&
    lower(relationship.implementationCodeHash) === lower(record.runtimeCodeHash)
  );
}

function factoryMatches(
  constraint: TrustManifestFactoryConstraint,
  poolState: LivePoolStateForManifest | undefined,
): boolean {
  if (!poolState) return false;
  return sameNullableAddress(constraint.factoryAddress, poolState.factoryAddress);
}

function tokenConstraintMatches(
  constraint: TrustManifestTokenConstraint,
  poolState: LivePoolStateForManifest | undefined,
): boolean {
  if (!poolState) return false;
  return (
    sameNullableAddress(constraint.token0, poolState.token0) &&
    sameNullableAddress(constraint.token1, poolState.token1)
  );
}

function comparisonResult(
  failureCodes: ManifestComparisonFailureCode[],
  validationErrors: string[],
): ManifestComparisonResult {
  const uniqueFailures = uniqueStrings(failureCodes).sort() as ManifestComparisonFailureCode[];
  return {
    status: uniqueFailures.length === 0 ? "PASSED" : "REJECTED",
    automaticExecutionEligible: uniqueFailures.length === 0,
    failureCodes: uniqueFailures,
    validationErrors: uniqueStrings(validationErrors).sort(),
  };
}

function edgeKeyForCall(
  call: LiveExecutionGraphCall,
  record: TrustManifestRecord,
  manifest: TrustManifest,
): string {
  const fromAddress = call.from?.toLowerCase() ?? null;
  const fromRole = fromAddress
    ? manifest.records.find((candidate) => candidate.address === fromAddress)?.role ?? null
    : null;
  return edgeKey({
    fromRole,
    fromAddress,
    toRole: record.role,
    toAddress: record.address,
    callType: call.callType.toUpperCase(),
    selector: call.selector?.toLowerCase() ?? null,
  });
}

function edgeKey(edge: TrustManifestEdge): string {
  return [
    edge.fromRole ?? "null",
    edge.fromAddress?.toLowerCase() ?? "null",
    edge.toRole,
    edge.toAddress.toLowerCase(),
    edge.callType.toUpperCase(),
    edge.selector?.toLowerCase() ?? "none",
  ].join("|");
}

function isStateChangingCallType(callType: string, prohibitedOperations: readonly string[]): boolean {
  const normalized = callType.toUpperCase();
  return normalized !== "STATICCALL" && !prohibitedOperations.includes(normalized);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function sameNullableAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  return sameAddress(a, b);
}

function lower(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null;
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}
