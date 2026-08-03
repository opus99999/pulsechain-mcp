import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { keccak256, type Hex } from "viem";
import type {
  AppConfig,
  PhiatTrustOperatorPublicKeyRegistryEntry,
  PhiatTrustRevocationRegistry,
} from "../../../types.js";
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
export const TRUST_MANIFEST_CANONICALIZATION = "PHIAT_TRUST_CANONICAL_JSON_V1" as const;
export const TRUST_MANIFEST_CANONICALIZATION_VERSION = 1 as const;
export const TRUST_MANIFEST_SIGNATURE_FRAME_VERSION = 1 as const;
export const TRUST_MANIFEST_SIGNATURE_FRAME_MAGIC = "PHIAT_TRUST_MANIFEST_SIG" as const;

const ED25519_SIGNATURE_LENGTH_BYTES = 64;
const TRUST_MANIFEST_MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const TRUST_MANIFEST_MAX_VALIDITY_BLOCKS = 100_000n;
const APPROVED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const SELECTOR_RE = /^0x[a-f0-9]{8}$/;
const DECIMAL_STRING_RE = /^(0|[1-9]\d*)$/;

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

export type TrustManifestVerifierStatus =
  | "PASSED"
  | "FAILED"
  | "EXPIRED"
  | "REVOKED"
  | "UNKNOWN_KEY"
  | "DISABLED"
  | "STATE_MISMATCH"
  | "UNCONFIGURED"
  | "NOT_EVALUATED";

export interface TrustManifestTemporalAuthority {
  currentTime: string;
  currentBlock: string | null;
  expiresAt: string | null;
  expiresAtBlock: string | null;
  timeRemainingMs: number | null;
  blocksRemaining: string | null;
  status: "PASSED" | "EXPIRED" | "FAILED";
}

export interface TrustManifestCanonicalizationProfile {
  standard: typeof TRUST_MANIFEST_CANONICALIZATION;
  implementedRequirements: string[];
  intentionallyRestrictedTypes: string[];
  rejectedTypes: string[];
  numericPolicy: string;
  unicodePolicy: string;
  duplicateKeyPolicy: string;
  canonicalizationVersion: typeof TRUST_MANIFEST_CANONICALIZATION_VERSION;
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
  canonicalizationProfile: TrustManifestCanonicalizationProfile;
  cryptographicStatus: TrustManifestVerifierStatus;
  schemaStatus: TrustManifestVerifierStatus;
  canonicalizationStatus: TrustManifestVerifierStatus;
  keyStatus: TrustManifestVerifierStatus;
  temporalStatus: TrustManifestVerifierStatus;
  revocationStatus: TrustManifestVerifierStatus;
  chainStateStatus: TrustManifestVerifierStatus;
  graphAuthorityStatus: TrustManifestVerifierStatus;
  temporalAuthority: TrustManifestTemporalAuthority | null;
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
  factoryCodeHash?: string | null;
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
  canonicalization: typeof TRUST_MANIFEST_CANONICALIZATION;
  canonicalizationProfile: TrustManifestCanonicalizationProfile;
  signaturePayload: {
    domainSeparator: typeof TRUST_MANIFEST_DOMAIN_SEPARATOR;
    manifestFingerprint: string;
    signatureAlgorithm: typeof TRUST_MANIFEST_SIGNATURE_ALGORITHM;
    signatureFrame: ReturnType<typeof signatureFrameSpecification>;
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
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new Error("Cannot canonicalize malformed Unicode string");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite number");
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Cannot canonicalize unsupported number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, entryValue] of entries) {
      if (hasLoneSurrogate(key)) throw new Error("Cannot canonicalize malformed Unicode key");
      if (entryValue === undefined) throw new Error("Cannot canonicalize undefined property");
    }
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

export function manifestIdFor(manifest: Omit<TrustManifest, "manifestId"> | TrustManifest): string {
  const { manifestId: _manifestId, ...manifestWithoutId } = manifest as TrustManifest;
  void _manifestId;
  return keccak256(
    bytesToHex(new TextEncoder().encode(canonicalizeJson(manifestWithoutId))),
  );
}

export function signedManifestPayload(manifest: TrustManifest): Buffer {
  return signatureFrameForManifest(manifest);
}

export function signatureFrameForManifest(manifest: TrustManifest): Buffer {
  const canonicalBytes = Buffer.from(canonicalManifestBytes(manifest));
  const fingerprintBytes = Buffer.from(manifestFingerprint(manifest).slice(2), "hex");
  if (fingerprintBytes.length !== 32) throw new Error("Manifest fingerprint must be 32 bytes");
  const magic = Buffer.from(TRUST_MANIFEST_SIGNATURE_FRAME_MAGIC, "ascii");
  const domain = Buffer.from(TRUST_MANIFEST_DOMAIN_SEPARATOR, "utf8");
  const version = Buffer.from([TRUST_MANIFEST_SIGNATURE_FRAME_VERSION]);
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32BE(domain.length, 0);
  const manifestLength = Buffer.alloc(8);
  manifestLength.writeBigUInt64BE(BigInt(canonicalBytes.length), 0);
  return Buffer.concat([
    magic,
    version,
    domainLength,
    domain,
    manifestLength,
    canonicalBytes,
    fingerprintBytes,
  ]);
}

export function signatureFrameSpecification(manifest?: TrustManifest): {
  version: typeof TRUST_MANIFEST_SIGNATURE_FRAME_VERSION;
  domainSeparator: typeof TRUST_MANIFEST_DOMAIN_SEPARATOR;
  binaryEncoding: string;
  lengthEncoding: string;
  signedByteDefinition: string;
  digestDefinition: string;
  testVector: string | null;
} {
  return {
    version: TRUST_MANIFEST_SIGNATURE_FRAME_VERSION,
    domainSeparator: TRUST_MANIFEST_DOMAIN_SEPARATOR,
    binaryEncoding:
      "ASCII magic, one-byte frame version, UTF-8 domain bytes, UTF-8 canonical manifest bytes, raw 32-byte manifest fingerprint",
    lengthEncoding: "uint32BE domain length and uint64BE canonical manifest length",
    signedByteDefinition:
      "PHIAT_TRUST_MANIFEST_SIG || 0x01 || uint32BE(domainLength) || domainUtf8 || uint64BE(manifestLength) || canonicalManifestUtf8 || manifestFingerprintBytes32",
    digestDefinition: "Ed25519 signs the complete framed payload directly; no external prehash is used.",
    testVector: manifest ? signatureFrameForManifest(manifest).toString("hex") : null,
  };
}

export function canonicalizationProfile(): TrustManifestCanonicalizationProfile {
  return {
    standard: TRUST_MANIFEST_CANONICALIZATION,
    implementedRequirements: [
      "deterministic lexicographic object-key ordering",
      "no emitted whitespace",
      "ECMAScript JSON.stringify serialization for strings, booleans, null, and bounded non-negative integers",
      "strict rejection of duplicate property names for string verifier input before JSON.parse",
      "strict rejection of malformed Unicode and lone surrogates",
      "strict rejection of NaN, Infinity, floating-point numbers, negative numbers, unsafe integers, undefined, symbols, functions, and BigInt",
    ],
    intentionallyRestrictedTypes: [
      "authority-bearing block numbers, timestamps, hashes, addresses, selectors, and token amounts use decimal or 0x strings",
      "JSON numbers are allowed only for bounded non-negative integer fields such as chainId, storage offsets, storage widths, fee, and tickSpacing",
      "arrays preserve order during canonicalization; semantically unordered manifest arrays are sorted by the candidate generator and validated as sorted during verification",
    ],
    rejectedTypes: [
      "duplicate object keys",
      "malformed Unicode or lone surrogate strings",
      "NaN and Infinity",
      "floating-point and exponent-form numbers",
      "unsafe integer literals",
      "negative numbers",
      "undefined, functions, symbols, and BigInt",
    ],
    numericPolicy:
      "Only safe non-negative integer JSON numbers are permitted. Unbounded authority values such as blocks and timestamps are decimal strings; 0x identities are lowercase strings.",
    unicodePolicy:
      "UTF-8 canonical bytes are emitted from JSON.stringify string serialization after rejecting lone surrogate code units. No Unicode normalization is applied.",
    duplicateKeyPolicy:
      "String input is parsed by a duplicate-key-detecting strict JSON parser, including escape-equivalent key spellings. Already-parsed JavaScript objects cannot retain duplicate source keys and are therefore schema-validated before canonicalization.",
    canonicalizationVersion: TRUST_MANIFEST_CANONICALIZATION_VERSION,
  };
}

export function publicKeyIdFromSpkiDerBase64(publicKeySpkiDerBase64: string): string {
  const validation = validateEd25519PublicKey(publicKeySpkiDerBase64);
  if (!validation.key || !validation.canonicalSpkiDer) {
    throw new Error(validation.errors.join(",") || "Invalid Ed25519 SPKI public key");
  }
  return keccak256(bytesToHex(validation.canonicalSpkiDer));
}

export function publicKeyIdFromSpkiDer(publicKeySpkiDer: Uint8Array): string {
  return publicKeyIdFromSpkiDerBase64(Buffer.from(publicKeySpkiDer).toString("base64"));
}

export function parseTrustManifestJsonText(input: string): { ok: true; value: unknown } | { ok: false; error: string } {
  return strictJsonParse(input);
}

export function trustManifestSchemaErrors(manifest: TrustManifest): string[] {
  return manifestShapeErrors(manifest);
}

export function extractUnsignedTrustManifest(input: unknown): {
  ok: true;
  manifest: TrustManifest;
} | {
  ok: false;
  errors: string[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["UNSIGNED_MANIFEST_INPUT_NOT_OBJECT"] };
  }
  const value = input as Record<string, unknown>;
  if (value.signature !== undefined) return { ok: false, errors: ["SIGNED_WRAPPER_NOT_UNSIGNED_CANDIDATE"] };
  const manifest = value.version === "phiat-execution-trust-v1" ? value : value.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["UNSIGNED_MANIFEST_MISSING"] };
  }
  return { ok: true, manifest: manifest as TrustManifest };
}

export function normalizeTrustManifestSemanticSets(manifest: TrustManifest): TrustManifest {
  const normalized = structuredClone(manifest) as TrustManifest;
  normalized.records = normalized.records
    .map((record) => ({
      ...record,
      approvedSelectors: [...record.approvedSelectors].sort(lexCompare),
      allowedCallTypes: [...record.allowedCallTypes].sort(lexCompare),
      parentConstraints: [...record.parentConstraints].sort((a, b) =>
        lexCompare(parentConstraintKey(a), parentConstraintKey(b)),
      ),
      callerConstraints: [...record.callerConstraints].sort((a, b) =>
        lexCompare(callerConstraintKey(a), callerConstraintKey(b)),
      ),
      tokenConstraints: record.tokenConstraints
        ? { ...record.tokenConstraints, assets: [...record.tokenConstraints.assets].sort(lexCompare) }
        : null,
      delegatecallContext: record.delegatecallContext
        ? {
            ...record.delegatecallContext,
            allowedSelectors: [...record.delegatecallContext.allowedSelectors].sort(lexCompare),
          }
        : null,
      residualRisks: [...record.residualRisks].sort(lexCompare),
    }))
    .sort((a, b) => lexCompare(recordSortKey(a), recordSortKey(b)));
  normalized.allowedEdges = [...normalized.allowedEdges].sort((a, b) => lexCompare(edgeKey(a), edgeKey(b)));
  normalized.prohibitedOperations = [...normalized.prohibitedOperations].sort((a, b) =>
    lexCompare(prohibitedOperationSortKey(a), prohibitedOperationSortKey(b)),
  ) as TrustManifest["prohibitedOperations"];
  normalized.manifestId = manifestIdFor(normalized);
  return normalized;
}

export function prepareCanonicalTrustManifest(input: unknown): {
  ok: true;
  manifest: TrustManifest;
  manifestFingerprint: string;
  canonicalManifestJson: string;
  signatureFrame: Buffer;
} | {
  ok: false;
  errors: string[];
} {
  const extracted = extractUnsignedTrustManifest(input);
  if (!extracted.ok) return extracted;
  let manifest: TrustManifest;
  try {
    manifest = normalizeTrustManifestSemanticSets(extracted.manifest);
  } catch {
    return { ok: false, errors: ["MANIFEST_NORMALIZATION_FAILED"] };
  }
  const errors = trustManifestSchemaErrors(manifest);
  if (errors.length > 0) return { ok: false, errors };
  try {
    const canonicalManifestJson = canonicalizeJson(manifest);
    return {
      ok: true,
      manifest,
      manifestFingerprint: manifestFingerprint(manifest),
      canonicalManifestJson,
      signatureFrame: signatureFrameForManifest(manifest),
    };
  } catch {
    return { ok: false, errors: ["MANIFEST_CANONICALIZATION_FAILED"] };
  }
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
    .sort((a, b) => lexCompare(recordSortKey(a), recordSortKey(b)));
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
  const manifestId = manifestIdFor(manifestWithoutId);
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
    canonicalization: TRUST_MANIFEST_CANONICALIZATION,
    canonicalizationProfile: canonicalizationProfile(),
    signaturePayload: {
      domainSeparator: TRUST_MANIFEST_DOMAIN_SEPARATOR,
      manifestFingerprint: fp,
      signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
      signatureFrame: signatureFrameSpecification(manifest),
    },
    reviewReport: renderTrustManifestReview(manifest, residualRisks),
  };
}

export function verifySignedTrustManifest(
  signedManifestInput: unknown,
  args: {
    pinnedPublicKeys?: Record<string, string>;
    keyRegistry?: PhiatTrustOperatorPublicKeyRegistryEntry[];
    revocations?: PhiatTrustRevocationRegistry;
    expectedOperatorPublicKeyId?: string;
    nowMs?: number;
    currentBlock?: string | null;
    currentChainId?: number;
  },
): VerifiedTrustManifest {
  const validationErrors: string[] = [];
  const parsed = parseSignedManifest(signedManifestInput);
  if (!parsed.ok) {
    return invalidVerification([parsed.error], {
      schemaStatus: parsed.error.startsWith("STRICT_JSON_") ? "FAILED" : "FAILED",
      canonicalizationStatus: parsed.error.startsWith("STRICT_JSON_") ? "FAILED" : "NOT_EVALUATED",
    });
  }
  const signedManifest = parsed.value;
  const manifest = signedManifest.manifest;
  const shapeErrors = signedManifestWrapperErrors(signedManifest).concat(manifestShapeErrors(manifest));
  const invalidRecordCount = Array.isArray(manifest.records)
    ? manifest.records.filter((record) => recordErrors(record).length > 0).length
    : 0;
  if (shapeErrors.length > 0) {
    return invalidVerification(shapeErrors, {
      manifest,
      signatureAlgorithm: signedManifest.signatureAlgorithm,
      operatorPublicKeyId: signedManifest.operatorPublicKeyId,
      signature: signedManifest.signature,
      schemaStatus: "FAILED",
      invalidRecordCount,
    });
  }

  let canonicalFingerprint: string | null = null;
  try {
    canonicalFingerprint = manifestFingerprint(manifest);
  } catch {
    validationErrors.push("CANONICALIZATION_FAILED");
  }
  let expectedManifestId: string | null = null;
  try {
    expectedManifestId = manifestIdFor(manifest);
  } catch {
    validationErrors.push("MANIFEST_ID_CANONICALIZATION_FAILED");
  }
  if (canonicalFingerprint === null) {
    return invalidVerification(validationErrors, {
      manifest,
      signatureAlgorithm: signedManifest.signatureAlgorithm,
      operatorPublicKeyId: signedManifest.operatorPublicKeyId,
      signature: signedManifest.signature,
      schemaStatus: "PASSED",
      canonicalizationStatus: "FAILED",
      invalidRecordCount,
    });
  }
  if (signedManifest.manifestFingerprint !== canonicalFingerprint) {
    validationErrors.push("MANIFEST_FINGERPRINT_MISMATCH");
  }
  if (expectedManifestId !== manifest.manifestId) {
    validationErrors.push("MANIFEST_ID_MISMATCH");
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

  const keyEvaluation = evaluateOperatorKeyRegistry({
    manifest,
    operatorPublicKeyId: signedManifest.operatorPublicKeyId,
    pinnedPublicKeys: args.pinnedPublicKeys ?? {},
    keyRegistry: args.keyRegistry,
    nowMs: args.nowMs ?? Date.now(),
  });
  validationErrors.push(...keyEvaluation.errors);
  const signatureEvaluation = keyEvaluation.key && !validationErrors.includes("UNSUPPORTED_SIGNATURE_ALGORITHM")
    ? verifyEd25519Signature(keyEvaluation.key, signedManifest.signature, signedManifestPayload(manifest))
    : { signatureValid: false, errors: ["SIGNATURE_INVALID"] };
  const signatureValid = signatureEvaluation.signatureValid;
  validationErrors.push(...signatureEvaluation.errors);

  const expiration = expirationStatus(manifest, args.nowMs ?? Date.now(), args.currentBlock ?? null);
  validationErrors.push(...expiration.errors);
  const consistencyErrors = manifestConsistencyErrors(manifest);
  if (args.currentChainId !== undefined && args.currentChainId !== manifest.chainId) {
    consistencyErrors.push("CURRENT_CHAIN_ID_MISMATCH");
  }
  validationErrors.push(...consistencyErrors);
  if (invalidRecordCount > 0) validationErrors.push("INVALID_RECORDS");
  const revocation = revocationStatus(canonicalFingerprint, signedManifest.operatorPublicKeyId, args.revocations);
  validationErrors.push(...revocation.errors);
  const chainRouterManagerConsistent = consistencyErrors.length === 0;
  const schemaStatus: TrustManifestVerifierStatus = "PASSED";
  const canonicalizationStatus: TrustManifestVerifierStatus =
    validationErrors.some((error) =>
      [
        "CANONICALIZATION_FAILED",
        "MANIFEST_ID_CANONICALIZATION_FAILED",
        "MANIFEST_FINGERPRINT_MISMATCH",
        "MANIFEST_ID_MISMATCH",
      ].includes(error),
    )
      ? "FAILED"
      : "PASSED";
  const cryptographicStatus: TrustManifestVerifierStatus =
    signatureValid &&
    signedManifest.signatureAlgorithm === TRUST_MANIFEST_SIGNATURE_ALGORITHM &&
    canonicalizationStatus === "PASSED"
      ? "PASSED"
      : "FAILED";
  const temporalStatus: TrustManifestVerifierStatus = expiration.status;
  const chainStateStatus: TrustManifestVerifierStatus = chainRouterManagerConsistent ? "PASSED" : "STATE_MISMATCH";
  const invalidAuthority =
    schemaStatus !== "PASSED" ||
    canonicalizationStatus !== "PASSED" ||
    cryptographicStatus !== "PASSED" ||
    keyEvaluation.status !== "PASSED" ||
    revocation.status === "REVOKED" ||
    temporalStatus === "FAILED" ||
    invalidRecordCount > 0 ||
    validationErrors.some((error) => !consistencyErrors.includes(error) && !expiration.errors.includes(error));
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
    canonicalizationProfile: canonicalizationProfile(),
    cryptographicStatus,
    schemaStatus,
    canonicalizationStatus,
    keyStatus: keyEvaluation.status,
    temporalStatus,
    revocationStatus: revocation.status,
    chainStateStatus,
    graphAuthorityStatus: "NOT_EVALUATED",
    temporalAuthority: expiration.temporalAuthority,
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
      !sameAddress(liveChainState.swapManager.storageAddress, manifest.swapManager.address)) ||
    (liveChainState.swapManager.managerChangeEventBlock ?? null) !==
      (manifest.swapManager.managerChangeEventBlock ?? null)) {
    failureCodes.push("SWAP_MANAGER_CHANGED");
  }
  const expiration = expirationStatus(
    manifest,
    liveChainState.currentTime ? Date.parse(liveChainState.currentTime) : Date.now(),
    liveChainState.currentBlock ?? null,
  );
  if (expiration.expired) failureCodes.push("MANIFEST_EXPIRED");
  if (expiration.errors.length > 0) {
    failureCodes.push("MANIFEST_EXPIRED");
    validationErrors.push(...expiration.errors);
  }

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
    if (!call.to) continue;
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
    if (
      record.tokenConstraints?.tickSpacing !== undefined &&
      poolState &&
      poolState.tickSpacing !== record.tokenConstraints.tickSpacing
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
      operatorPublicKeyId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
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
      expectedOperatorPublicKeyId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    },
    handler: async (args, cfg) => {
      const currentBlock = await readCurrentBlockForManifestVerifier(cfg);
      return ok(
        verifySignedTrustManifest(args.signedManifest, {
          pinnedPublicKeys: cfg.phiatTrustOperatorPublicKeys ?? {},
          keyRegistry: cfg.phiatTrustOperatorKeyRegistry,
          revocations: cfg.phiatTrustRevocations,
          expectedOperatorPublicKeyId: args.expectedOperatorPublicKeyId as string | undefined,
          currentBlock,
          currentChainId: PULSECHAIN_CHAIN_ID,
        }),
      );
    },
  });
}

async function readCurrentBlockForManifestVerifier(config: AppConfig): Promise<string | null> {
  const blocks: string[] = [];
  for (const rpcUrl of config.rpcUrls.slice(0, 2)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(config.httpTimeoutMs, 5_000));
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_blockNumber",
          params: [],
        }),
        signal: controller.signal,
      });
      const json = await response.json() as { result?: unknown };
      if (typeof json.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(json.result)) return null;
      blocks.push(BigInt(json.result).toString());
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (blocks.length === 0) return null;
  return new Set(blocks).size === 1 ? blocks[0]! : null;
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
  })).sort((a, b) => lexCompare(parentConstraintKey(a), parentConstraintKey(b)));
  const callerConstraints = record.callerConstraints.map((constraint) => ({
    caller: constraint.caller ? constraint.caller.toLowerCase() : null,
    selector: constraint.selector ? constraint.selector.toLowerCase() : null,
    callType: constraint.callType.toUpperCase(),
  })).sort((a, b) => lexCompare(callerConstraintKey(a), callerConstraintKey(b)));
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
  return edges.sort((a, b) => lexCompare(edgeKey(a), edgeKey(b)));
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
  const parsed = typeof input === "string" ? strictJsonParse(input) : { ok: true as const, value: input };
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const parsedInput = parsed.value;
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

function signedManifestWrapperErrors(signedManifest: SignedTrustManifest): string[] {
  const errors: string[] = [];
  objectUnknownKeyErrors(signedManifest, [
    "manifest",
    "manifestFingerprint",
    "signatureAlgorithm",
    "operatorPublicKeyId",
    "signature",
  ], "SIGNED_MANIFEST").forEach((error) => errors.push(error));
  if (!HASH_RE.test(signedManifest.manifestFingerprint)) errors.push("MANIFEST_FINGERPRINT_INVALID");
  if (!HASH_RE.test(signedManifest.operatorPublicKeyId)) errors.push("OPERATOR_PUBLIC_KEY_ID_INVALID");
  if (typeof signedManifest.signature !== "string") errors.push("SIGNATURE_INVALID_TYPE");
  return errors;
}

function strictJsonParse(input: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const parser = new StrictJsonParser(input);
    return { ok: true, value: parser.parse() };
  } catch (error) {
    return {
      ok: false,
      error: `STRICT_JSON_${error instanceof Error ? error.message : "INVALID"}`,
    };
  }
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly input: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.input.length) throw new Error("TRAILING_DATA");
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const char = this.input[this.offset];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === "\"") return this.parseString();
    if (char === "t") return this.parseLiteral("true", true);
    if (char === "f") return this.parseLiteral("false", false);
    if (char === "n") return this.parseLiteral("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.parseNumber();
    throw new Error("INVALID_VALUE");
  }

  private parseObject(): Record<string, unknown> {
    this.offset += 1;
    const out: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.input[this.offset] === "}") {
      this.offset += 1;
      return out;
    }
    while (true) {
      this.skipWhitespace();
      if (this.input[this.offset] !== "\"") throw new Error("OBJECT_KEY_EXPECTED");
      const key = this.parseString();
      if (keys.has(key)) throw new Error("DUPLICATE_KEY");
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.offset] !== ":") throw new Error("COLON_EXPECTED");
      this.offset += 1;
      out[key] = this.parseValue();
      this.skipWhitespace();
      if (this.input[this.offset] === "}") {
        this.offset += 1;
        return out;
      }
      if (this.input[this.offset] !== ",") throw new Error("COMMA_EXPECTED");
      this.offset += 1;
    }
  }

  private parseArray(): unknown[] {
    this.offset += 1;
    const out: unknown[] = [];
    this.skipWhitespace();
    if (this.input[this.offset] === "]") {
      this.offset += 1;
      return out;
    }
    while (true) {
      out.push(this.parseValue());
      this.skipWhitespace();
      if (this.input[this.offset] === "]") {
        this.offset += 1;
        return out;
      }
      if (this.input[this.offset] !== ",") throw new Error("ARRAY_COMMA_EXPECTED");
      this.offset += 1;
    }
  }

  private parseString(): string {
    this.offset += 1;
    let out = "";
    while (this.offset < this.input.length) {
      const code = this.input.charCodeAt(this.offset);
      const char = this.input[this.offset];
      if (char === "\"") {
        this.offset += 1;
        return out;
      }
      if (code < 0x20) throw new Error("UNESCAPED_CONTROL_CHARACTER");
      if (code >= 0xd800 && code <= 0xdfff) throw new Error("MALFORMED_UNICODE");
      if (char !== "\\") {
        out += char;
        this.offset += 1;
        continue;
      }
      this.offset += 1;
      const escaped = this.input[this.offset];
      if (escaped === undefined) throw new Error("BAD_ESCAPE");
      if (escaped === "\"" || escaped === "\\" || escaped === "/") {
        out += escaped;
        this.offset += 1;
      } else if (escaped === "b") {
        out += "\b";
        this.offset += 1;
      } else if (escaped === "f") {
        out += "\f";
        this.offset += 1;
      } else if (escaped === "n") {
        out += "\n";
        this.offset += 1;
      } else if (escaped === "r") {
        out += "\r";
        this.offset += 1;
      } else if (escaped === "t") {
        out += "\t";
        this.offset += 1;
      } else if (escaped === "u") {
        out += this.parseUnicodeEscape();
      } else {
        throw new Error("BAD_ESCAPE");
      }
    }
    throw new Error("UNTERMINATED_STRING");
  }

  private parseUnicodeEscape(): string {
    this.offset += 1;
    const hex = this.input.slice(this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("BAD_UNICODE_ESCAPE");
    this.offset += 4;
    const code = Number.parseInt(hex, 16);
    if (code >= 0xdc00 && code <= 0xdfff) throw new Error("MALFORMED_UNICODE");
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.input[this.offset] !== "\\" || this.input[this.offset + 1] !== "u") {
        throw new Error("MALFORMED_UNICODE");
      }
      this.offset += 2;
      const lowHex = this.input.slice(this.offset, this.offset + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) throw new Error("BAD_UNICODE_ESCAPE");
      this.offset += 4;
      const low = Number.parseInt(lowHex, 16);
      if (low < 0xdc00 || low > 0xdfff) throw new Error("MALFORMED_UNICODE");
      return String.fromCharCode(code, low);
    }
    return String.fromCharCode(code);
  }

  private parseNumber(): number {
    const start = this.offset;
    if (this.input[this.offset] === "-") {
      this.offset += 1;
      throw new Error("UNSUPPORTED_NUMBER_FORM");
    }
    if (this.input[this.offset] === "0") {
      this.offset += 1;
      if (this.input[this.offset] !== undefined && /[0-9]/.test(this.input[this.offset]!)) {
        throw new Error("UNSUPPORTED_NUMBER_FORM");
      }
    } else {
      if (!/[1-9]/.test(this.input[this.offset] ?? "")) throw new Error("BAD_NUMBER");
      while (/[0-9]/.test(this.input[this.offset] ?? "")) this.offset += 1;
    }
    if (this.input[this.offset] === "." || this.input[this.offset] === "e" || this.input[this.offset] === "E") {
      throw new Error("UNSUPPORTED_NUMBER_FORM");
    }
    const token = this.input.slice(start, this.offset);
    const value = Number(token);
    if (!Number.isSafeInteger(value)) throw new Error("UNSAFE_INTEGER");
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (this.input.slice(this.offset, this.offset + literal.length) !== literal) {
      throw new Error("BAD_LITERAL");
    }
    this.offset += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.input[this.offset] ?? "")) this.offset += 1;
  }
}

function verifyEd25519Signature(
  publicKey: KeyObject,
  signatureBase64: string,
  payload: Buffer,
): { signatureValid: boolean; errors: string[] } {
  const signature = strictBase64ToBuffer(signatureBase64);
  if (!signature) return { signatureValid: false, errors: ["SIGNATURE_BASE64_INVALID"] };
  if (signature.length !== ED25519_SIGNATURE_LENGTH_BYTES) {
    return { signatureValid: false, errors: ["SIGNATURE_LENGTH_INVALID"] };
  }
  try {
    const signatureValid = verifySignature(null, payload, publicKey, signature);
    return { signatureValid, errors: signatureValid ? [] : ["SIGNATURE_INVALID"] };
  } catch {
    return { signatureValid: false, errors: ["SIGNATURE_INVALID"] };
  }
}

function validateEd25519PublicKey(publicKeySpkiDerBase64: string): {
  key: KeyObject | null;
  canonicalSpkiDer: Buffer | null;
  errors: string[];
} {
  const errors: string[] = [];
  const bytes = strictBase64ToBuffer(publicKeySpkiDerBase64);
  if (!bytes) return { key: null, canonicalSpkiDer: null, errors: ["PUBLIC_KEY_BASE64_INVALID"] };
  try {
    const key = createPublicKey({
      key: bytes,
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") errors.push("PUBLIC_KEY_NOT_ED25519");
    const canonical = Buffer.from(key.export({ format: "der", type: "spki" }));
    if (!canonical.equals(bytes)) errors.push("PUBLIC_KEY_DER_NOT_CANONICAL");
    return { key: errors.length === 0 ? key : null, canonicalSpkiDer: canonical, errors };
  } catch {
    return { key: null, canonicalSpkiDer: null, errors: ["PUBLIC_KEY_DER_INVALID"] };
  }
}

function strictBase64ToBuffer(value: string): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function evaluateOperatorKeyRegistry(args: {
  manifest: TrustManifest;
  operatorPublicKeyId: string;
  pinnedPublicKeys: Record<string, string>;
  keyRegistry?: PhiatTrustOperatorPublicKeyRegistryEntry[];
  nowMs: number;
}): { key: KeyObject | null; status: TrustManifestVerifierStatus; errors: string[] } {
  const errors: string[] = [];
  const registry = operatorKeyRegistryEntries(args.pinnedPublicKeys, args.keyRegistry);
  const configuredIds = new Set<string>();
  const derivedIds = new Set<string>();
  let selected: PhiatTrustOperatorPublicKeyRegistryEntry | null = null;
  for (const entry of registry) {
    if (configuredIds.has(entry.keyId)) errors.push("OPERATOR_PUBLIC_KEY_ID_DUPLICATE");
    configuredIds.add(entry.keyId);
    const keyValidation = validateEd25519PublicKey(entry.spkiDerBase64);
    errors.push(...keyValidation.errors.map((error) => `REGISTRY_${entry.keyId}_${error}`));
    if (keyValidation.canonicalSpkiDer) {
      const derivedId = keccak256(bytesToHex(keyValidation.canonicalSpkiDer));
      if (derivedIds.has(derivedId)) errors.push("OPERATOR_PUBLIC_KEY_DER_DUPLICATE");
      derivedIds.add(derivedId);
      if (derivedId !== entry.keyId) errors.push("OPERATOR_PUBLIC_KEY_ID_DERIVED_MISMATCH");
    }
    if (entry.keyId === args.operatorPublicKeyId) selected = entry;
  }
  if (!selected) return { key: null, status: "UNKNOWN_KEY", errors: [...errors, "OPERATOR_PUBLIC_KEY_UNKNOWN"] };
  if (selected.algorithm !== TRUST_MANIFEST_SIGNATURE_ALGORITHM) {
    errors.push("OPERATOR_PUBLIC_KEY_ALGORITHM_INVALID");
  }
  const selectedKeyValidation = validateEd25519PublicKey(selected.spkiDerBase64);
  errors.push(...selectedKeyValidation.errors);
  if (selectedKeyValidation.canonicalSpkiDer) {
    const derivedId = keccak256(bytesToHex(selectedKeyValidation.canonicalSpkiDer));
    if (derivedId !== selected.keyId || derivedId !== args.operatorPublicKeyId) {
      errors.push("OPERATOR_PUBLIC_KEY_ID_DERIVED_MISMATCH");
    }
  }
  if (selected.status === "REVOKED") {
    errors.push("OPERATOR_PUBLIC_KEY_REVOKED");
    return { key: selectedKeyValidation.key, status: "REVOKED", errors };
  }
  if (selected.status === "DISABLED") {
    errors.push("OPERATOR_PUBLIC_KEY_DISABLED");
    return { key: selectedKeyValidation.key, status: "DISABLED", errors };
  }
  if (selected.status !== "ACTIVE") errors.push("OPERATOR_PUBLIC_KEY_STATUS_INVALID");
  const now = args.nowMs;
  if (selected.validFrom) {
    const validFrom = Date.parse(selected.validFrom);
    if (!Number.isFinite(validFrom)) errors.push("OPERATOR_PUBLIC_KEY_VALID_FROM_INVALID");
    else if (now < validFrom) errors.push("OPERATOR_PUBLIC_KEY_NOT_YET_VALID");
  }
  if (selected.validUntil) {
    const validUntil = Date.parse(selected.validUntil);
    if (!Number.isFinite(validUntil)) errors.push("OPERATOR_PUBLIC_KEY_VALID_UNTIL_INVALID");
    else if (now > validUntil) errors.push("OPERATOR_PUBLIC_KEY_EXPIRED");
  }
  if (
    selected.allowedManifestVersions &&
    !selected.allowedManifestVersions.includes(args.manifest.version)
  ) {
    errors.push("OPERATOR_PUBLIC_KEY_VERSION_NOT_ALLOWED");
  }
  if (
    selected.allowedChainIds &&
    !selected.allowedChainIds.includes(args.manifest.chainId)
  ) {
    errors.push("OPERATOR_PUBLIC_KEY_CHAIN_NOT_ALLOWED");
  }
  return {
    key: selectedKeyValidation.key,
    status: errors.length === 0 ? "PASSED" : "FAILED",
    errors,
  };
}

function operatorKeyRegistryEntries(
  pinnedPublicKeys: Record<string, string>,
  keyRegistry?: PhiatTrustOperatorPublicKeyRegistryEntry[],
): PhiatTrustOperatorPublicKeyRegistryEntry[] {
  const legacyEntries = Object.entries(pinnedPublicKeys).map(([keyId, spkiDerBase64]) => ({
    keyId,
    algorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    spkiDerBase64,
    status: "ACTIVE" as const,
  }));
  return [...legacyEntries, ...(keyRegistry ?? [])];
}

function revocationStatus(
  manifestFingerprintValue: string,
  keyId: string,
  revocations: PhiatTrustRevocationRegistry | undefined,
): { status: TrustManifestVerifierStatus; errors: string[] } {
  if (!revocations) return { status: "UNCONFIGURED", errors: [] };
  const errors: string[] = [];
  if (
    revocations.manifests?.some((entry) =>
      lower(entry.manifestFingerprint) === lower(manifestFingerprintValue),
    )
  ) {
    errors.push("MANIFEST_REVOKED");
  }
  if (revocations.keys?.some((entry) => lower(entry.keyId) === lower(keyId))) {
    errors.push("OPERATOR_PUBLIC_KEY_REVOKED_BY_REVOCATION_REGISTRY");
  }
  return { status: errors.length > 0 ? "REVOKED" : "PASSED", errors };
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
  status: "PASSED" | "EXPIRED" | "FAILED";
  temporalAuthority: TrustManifestTemporalAuthority;
} {
  const errors: string[] = [];
  if (!manifest.expiresAt && !manifest.expiresAtBlock) errors.push("EXPIRATION_REQUIRED");
  let expired = false;
  let blockRemaining: string | null = null;
  let millisecondsRemaining: number | null = null;
  if (manifest.approvedAt) {
    const approvedAtMs = Date.parse(manifest.approvedAt);
    if (!Number.isFinite(approvedAtMs)) errors.push("APPROVED_AT_INVALID");
    else if (approvedAtMs > nowMs + APPROVED_AT_FUTURE_TOLERANCE_MS) {
      errors.push("APPROVED_AT_IN_FUTURE");
    }
  }
  if (manifest.expiresAt) {
    const expiresMs = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresMs)) errors.push("EXPIRES_AT_INVALID");
    else {
      millisecondsRemaining = expiresMs - nowMs;
      if (millisecondsRemaining < 0) expired = true;
      if (manifest.approvedAt) {
        const approvedAtMs = Date.parse(manifest.approvedAt);
        if (Number.isFinite(approvedAtMs)) {
          if (expiresMs <= approvedAtMs) errors.push("EXPIRES_AT_NOT_AFTER_APPROVED_AT");
          if (expiresMs - approvedAtMs > TRUST_MANIFEST_MAX_VALIDITY_MS) {
            errors.push("EXPIRATION_WINDOW_TOO_LONG");
          }
        }
      }
    }
  }
  if (manifest.approvedAtBlock) {
    if (!DECIMAL_STRING_RE.test(manifest.approvedAtBlock)) errors.push("APPROVED_AT_BLOCK_INVALID");
    else if (!currentBlock) errors.push("CURRENT_BLOCK_REQUIRED_FOR_APPROVAL_BLOCK");
    else {
      try {
        if (BigInt(manifest.approvedAtBlock) > BigInt(currentBlock)) errors.push("APPROVED_AT_BLOCK_IN_FUTURE");
      } catch {
        errors.push("APPROVED_AT_BLOCK_INVALID");
      }
    }
  }
  if (manifest.expiresAtBlock) {
    if (!DECIMAL_STRING_RE.test(manifest.expiresAtBlock)) errors.push("EXPIRES_AT_BLOCK_INVALID");
    else if (!currentBlock) errors.push("CURRENT_BLOCK_REQUIRED_FOR_BLOCK_EXPIRATION");
    else {
      try {
        const remaining = BigInt(manifest.expiresAtBlock) - BigInt(currentBlock);
        blockRemaining = remaining.toString();
        if (remaining < 0n) expired = true;
      } catch {
        errors.push("EXPIRES_AT_BLOCK_INVALID");
      }
    }
    if (manifest.approvedAtBlock && DECIMAL_STRING_RE.test(manifest.approvedAtBlock)) {
      try {
        const window = BigInt(manifest.expiresAtBlock) - BigInt(manifest.approvedAtBlock);
        if (window <= 0n) errors.push("EXPIRES_AT_BLOCK_NOT_AFTER_APPROVED_AT_BLOCK");
        if (window > TRUST_MANIFEST_MAX_VALIDITY_BLOCKS) errors.push("EXPIRATION_BLOCK_WINDOW_TOO_LONG");
      } catch {
        errors.push("EXPIRES_AT_BLOCK_INVALID");
      }
    }
  }
  const status = errors.length > 0 ? "FAILED" : expired ? "EXPIRED" : "PASSED";
  return {
    expired,
    blockRemaining,
    millisecondsRemaining,
    errors,
    status,
    temporalAuthority: {
      currentTime: new Date(nowMs).toISOString(),
      currentBlock,
      expiresAt: manifest.expiresAt,
      expiresAtBlock: manifest.expiresAtBlock,
      timeRemainingMs: millisecondsRemaining,
      blocksRemaining: blockRemaining,
      status,
    },
  };
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
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["MANIFEST_NOT_OBJECT"];
  errors.push(...objectUnknownKeyErrors(value, [
    "version",
    "manifestId",
    "chainId",
    "historicalTransaction",
    "historicalBlock",
    "graphFingerprint",
    "bundleFingerprint",
    "router",
    "swapManager",
    "records",
    "allowedEdges",
    "prohibitedOperations",
    "approvalPolicy",
    "approvedAt",
    "approvedAtBlock",
    "expiresAt",
    "expiresAtBlock",
    "operatorPublicKeyId",
  ], "MANIFEST"));
  if (value.version !== "phiat-execution-trust-v1") errors.push("VERSION_INVALID");
  if (typeof value.manifestId !== "string" || !HASH_RE.test(value.manifestId)) errors.push("MANIFEST_ID_INVALID");
  if (typeof value.chainId !== "number" || !Number.isSafeInteger(value.chainId) || value.chainId < 0) {
    errors.push("CHAIN_ID_INVALID");
  }
  if (typeof value.historicalTransaction !== "string" || !HASH_RE.test(value.historicalTransaction)) {
    errors.push("HISTORICAL_TRANSACTION_INVALID");
  }
  if (typeof value.historicalBlock !== "string" || !DECIMAL_STRING_RE.test(value.historicalBlock)) {
    errors.push("HISTORICAL_BLOCK_INVALID");
  }
  if (typeof value.graphFingerprint !== "string" || !HASH_RE.test(value.graphFingerprint)) {
    errors.push("GRAPH_FINGERPRINT_INVALID");
  }
  if (typeof value.bundleFingerprint !== "string" || !HASH_RE.test(value.bundleFingerprint)) {
    errors.push("BUNDLE_FINGERPRINT_INVALID");
  }
  if (!value.router || typeof value.router.address !== "string" || typeof value.router.runtimeCodeHash !== "string") {
    errors.push("ROUTER_CONSTRAINT_MISSING");
  } else {
    errors.push(...objectUnknownKeyErrors(value.router, ["address", "runtimeCodeHash"], "ROUTER"));
    if (!ADDRESS_RE.test(value.router.address)) errors.push("ROUTER_ADDRESS_INVALID");
    if (!HASH_RE.test(value.router.runtimeCodeHash)) errors.push("ROUTER_CODE_HASH_INVALID");
  }
  if (
    !value.swapManager ||
    typeof value.swapManager.address !== "string" ||
    typeof value.swapManager.runtimeCodeHash !== "string"
  ) {
    errors.push("SWAP_MANAGER_CONSTRAINT_MISSING");
  } else {
    errors.push(...objectUnknownKeyErrors(value.swapManager, [
      "address",
      "runtimeCodeHash",
      "storageSlot",
      "storageOffsetBytes",
      "storageWidthBytes",
      "managerChangeEventBlock",
    ], "SWAP_MANAGER"));
    if (!ADDRESS_RE.test(value.swapManager.address)) errors.push("SWAP_MANAGER_ADDRESS_INVALID");
    if (!HASH_RE.test(value.swapManager.runtimeCodeHash)) errors.push("SWAP_MANAGER_CODE_HASH_INVALID");
    if (typeof value.swapManager.storageSlot !== "string" || !HASH_RE.test(value.swapManager.storageSlot)) {
      errors.push("SWAP_MANAGER_STORAGE_SLOT_INVALID");
    }
    if (
      typeof value.swapManager.storageOffsetBytes !== "number" ||
      !Number.isSafeInteger(value.swapManager.storageOffsetBytes) ||
      value.swapManager.storageOffsetBytes < 0 ||
      value.swapManager.storageOffsetBytes > 31
    ) {
      errors.push("SWAP_MANAGER_STORAGE_OFFSET_INVALID");
    }
    if (
      typeof value.swapManager.storageWidthBytes !== "number" ||
      !Number.isSafeInteger(value.swapManager.storageWidthBytes) ||
      value.swapManager.storageWidthBytes <= 0 ||
      value.swapManager.storageWidthBytes > 32
    ) {
      errors.push("SWAP_MANAGER_STORAGE_WIDTH_INVALID");
    }
    if (
      value.swapManager.managerChangeEventBlock !== null &&
      (typeof value.swapManager.managerChangeEventBlock !== "string" ||
        !DECIMAL_STRING_RE.test(value.swapManager.managerChangeEventBlock))
    ) {
      errors.push("SWAP_MANAGER_EVENT_BLOCK_INVALID");
    }
  }
  if (!Array.isArray(value.records)) errors.push("RECORDS_MISSING");
  else {
    errors.push(...arrayOrderAndDuplicateErrors("RECORDS", value.records, recordSortKey));
    for (const record of value.records) errors.push(...recordErrors(record));
  }
  if (!Array.isArray(value.allowedEdges)) errors.push("ALLOWED_EDGES_MISSING");
  else {
    errors.push(...arrayOrderAndDuplicateErrors("ALLOWED_EDGES", value.allowedEdges, edgeKey));
    for (const edge of value.allowedEdges) errors.push(...edgeErrors(edge));
  }
  if (!Array.isArray(value.prohibitedOperations)) errors.push("PROHIBITED_OPERATIONS_MISSING");
  else if (value.prohibitedOperations.join("|") !== "CREATE|CREATE2|SELFDESTRUCT|CALLCODE") {
    errors.push("PROHIBITED_OPERATIONS_INVALID");
  }
  if (!value.approvalPolicy || typeof value.approvalPolicy !== "object") errors.push("APPROVAL_POLICY_MISSING");
  else {
    errors.push(...objectUnknownKeyErrors(value.approvalPolicy, [
      "unexpectedTarget",
      "unexpectedSelector",
      "unexpectedEdge",
      "codeHashChange",
      "managerChange",
      "routerChange",
      "expiredManifest",
    ], "APPROVAL_POLICY"));
    if (Object.values(value.approvalPolicy).some((policy) => policy !== "REJECT")) {
      errors.push("APPROVAL_POLICY_INVALID");
    }
  }
  if (value.approvedAt !== null && (typeof value.approvedAt !== "string" || !Number.isFinite(Date.parse(value.approvedAt)))) {
    errors.push("APPROVED_AT_INVALID");
  }
  if (value.approvedAtBlock !== null && (typeof value.approvedAtBlock !== "string" || !DECIMAL_STRING_RE.test(value.approvedAtBlock))) {
    errors.push("APPROVED_AT_BLOCK_INVALID");
  }
  if (value.expiresAt !== null && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) {
    errors.push("EXPIRES_AT_INVALID");
  }
  if (value.expiresAtBlock !== null && (typeof value.expiresAtBlock !== "string" || !DECIMAL_STRING_RE.test(value.expiresAtBlock))) {
    errors.push("EXPIRES_AT_BLOCK_INVALID");
  }
  if (typeof value.operatorPublicKeyId !== "string" || !HASH_RE.test(value.operatorPublicKeyId)) {
    errors.push("MANIFEST_OPERATOR_KEY_ID_INVALID");
  }
  return errors;
}

function recordErrors(record: TrustManifestRecord): string[] {
  const errors: string[] = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["BAD_RECORD"];
  errors.push(...objectUnknownKeyErrors(record, [
    "address",
    "role",
    "runtimeCodeHash",
    "implementationAddress",
    "implementationCodeHash",
    "approvedSelectors",
    "allowedCallTypes",
    "parentConstraints",
    "callerConstraints",
    "factoryConstraints",
    "tokenConstraints",
    "managerHashConstraint",
    "routerHashConstraint",
    "delegatecallContext",
    "firstApprovedBlock",
    "expiresAtBlock",
    "residualRisks",
  ], "RECORD"));
  if (!ADDRESS_RE.test(record.address)) errors.push("BAD_ADDRESS");
  if (record.runtimeCodeHash && !HASH_RE.test(record.runtimeCodeHash)) errors.push("BAD_CODE_HASH");
  if (record.implementationAddress && !ADDRESS_RE.test(record.implementationAddress)) errors.push("BAD_IMPLEMENTATION_ADDRESS");
  if (record.implementationCodeHash && !HASH_RE.test(record.implementationCodeHash)) errors.push("BAD_IMPLEMENTATION_CODE_HASH");
  if (record.managerHashConstraint && !HASH_RE.test(record.managerHashConstraint)) errors.push("BAD_MANAGER_HASH_CONSTRAINT");
  if (record.routerHashConstraint && !HASH_RE.test(record.routerHashConstraint)) errors.push("BAD_ROUTER_HASH_CONSTRAINT");
  if (!DECIMAL_STRING_RE.test(record.firstApprovedBlock)) errors.push("BAD_FIRST_APPROVED_BLOCK");
  if (record.expiresAtBlock !== null && !DECIMAL_STRING_RE.test(record.expiresAtBlock)) {
    errors.push("BAD_RECORD_EXPIRES_AT_BLOCK");
  }
  if (!Array.isArray(record.approvedSelectors)) {
    errors.push("BAD_SELECTOR_LIST");
    return errors;
  }
  if (!Array.isArray(record.allowedCallTypes)) errors.push("BAD_CALL_TYPE_LIST");
  if (!Array.isArray(record.parentConstraints)) errors.push("BAD_PARENT_CONSTRAINTS");
  if (!Array.isArray(record.callerConstraints)) errors.push("BAD_CALLER_CONSTRAINTS");
  if (!Array.isArray(record.residualRisks)) errors.push("BAD_RESIDUAL_RISKS");
  if (errors.length > 0) return errors;
  errors.push(...arrayOrderAndDuplicateErrors("APPROVED_SELECTORS", record.approvedSelectors, (value) => value));
  errors.push(...arrayOrderAndDuplicateErrors("ALLOWED_CALL_TYPES", record.allowedCallTypes, (value) => value));
  errors.push(...arrayOrderAndDuplicateErrors("PARENT_CONSTRAINTS", record.parentConstraints, parentConstraintKey));
  errors.push(...arrayOrderAndDuplicateErrors("CALLER_CONSTRAINTS", record.callerConstraints, callerConstraintKey));
  errors.push(...arrayOrderAndDuplicateErrors("RESIDUAL_RISKS", record.residualRisks, (value) => value));
  for (const parent of record.parentConstraints) errors.push(...parentConstraintErrors(parent));
  for (const caller of record.callerConstraints) errors.push(...callerConstraintErrors(caller));
  if (record.approvedSelectors.some((selector) => !SELECTOR_RE.test(selector))) {
    errors.push("BAD_SELECTOR");
  }
  if (record.allowedCallTypes.some((callType) => !allowedCallType(callType))) errors.push("BAD_CALL_TYPE");
  if (record.factoryConstraints) errors.push(...factoryConstraintErrors(record.factoryConstraints));
  if (record.tokenConstraints) errors.push(...tokenConstraintErrors(record.tokenConstraints));
  if (record.delegatecallContext) errors.push(...delegatecallContextErrors(record.delegatecallContext));
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

function objectUnknownKeyErrors(value: object, allowedKeys: string[], prefix: string): string[] {
  const allowed = new Set(allowedKeys);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${prefix}_UNKNOWN_FIELD_${key}`);
}

function arrayOrderAndDuplicateErrors<T>(
  prefix: string,
  values: T[],
  keyFn: (value: T) => string,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) errors.push(`${prefix}_DUPLICATE`);
    seen.add(key);
    if (previous !== null && lexCompare(previous, key) > 0) errors.push(`${prefix}_NOT_SORTED`);
    previous = key;
  }
  return uniqueStrings(errors);
}

function recordSortKey(record: TrustManifestRecord): string {
  return [
    record.role,
    lower(record.address) ?? "",
    lower(record.runtimeCodeHash) ?? "null",
  ].join("|");
}

function parentConstraintKey(constraint: TrustManifestParentConstraint): string {
  return [
    constraint.parentRole ?? "null",
    lower(constraint.parentAddress) ?? "null",
  ].join("|");
}

function callerConstraintKey(constraint: TrustManifestCallerConstraint): string {
  return [
    lower(constraint.caller) ?? "null",
    constraint.callType?.toUpperCase?.() ?? "",
    lower(constraint.selector) ?? "null",
  ].join("|");
}

function parentConstraintErrors(constraint: TrustManifestParentConstraint): string[] {
  const errors: string[] = [];
  if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) return ["BAD_PARENT_CONSTRAINT"];
  errors.push(...objectUnknownKeyErrors(constraint, ["parentAddress", "parentRole"], "PARENT_CONSTRAINT"));
  if (constraint.parentAddress !== null && !ADDRESS_RE.test(constraint.parentAddress)) errors.push("BAD_PARENT_ADDRESS");
  return errors;
}

function callerConstraintErrors(constraint: TrustManifestCallerConstraint): string[] {
  const errors: string[] = [];
  if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) return ["BAD_CALLER_CONSTRAINT"];
  errors.push(...objectUnknownKeyErrors(constraint, ["caller", "selector", "callType"], "CALLER_CONSTRAINT"));
  if (constraint.caller !== null && !ADDRESS_RE.test(constraint.caller)) errors.push("BAD_CALLER_ADDRESS");
  if (constraint.selector !== null && !SELECTOR_RE.test(constraint.selector)) errors.push("BAD_CALLER_SELECTOR");
  if (!allowedCallType(constraint.callType)) errors.push("BAD_CALLER_CALL_TYPE");
  return errors;
}

function factoryConstraintErrors(constraint: TrustManifestFactoryConstraint): string[] {
  const errors: string[] = [];
  errors.push(...objectUnknownKeyErrors(constraint, [
    "factoryAddress",
    "factoryCodeHash",
    "protocol",
    "poolAddress",
    "fee",
    "tickSpacing",
  ], "FACTORY_CONSTRAINT"));
  if (constraint.factoryAddress !== null && !ADDRESS_RE.test(constraint.factoryAddress)) errors.push("BAD_FACTORY_ADDRESS");
  if (constraint.factoryCodeHash !== null && !HASH_RE.test(constraint.factoryCodeHash)) errors.push("BAD_FACTORY_CODE_HASH");
  if (constraint.poolAddress !== undefined && constraint.poolAddress !== null && !ADDRESS_RE.test(constraint.poolAddress)) {
    errors.push("BAD_FACTORY_POOL_ADDRESS");
  }
  if (constraint.fee !== undefined && constraint.fee !== null && !boundedInteger(constraint.fee)) errors.push("BAD_FACTORY_FEE");
  if (constraint.tickSpacing !== undefined && constraint.tickSpacing !== null && !boundedInteger(constraint.tickSpacing)) {
    errors.push("BAD_FACTORY_TICK_SPACING");
  }
  return errors;
}

function tokenConstraintErrors(constraint: TrustManifestTokenConstraint): string[] {
  const errors: string[] = [];
  errors.push(...objectUnknownKeyErrors(constraint, [
    "token0",
    "token1",
    "assets",
    "fee",
    "tickSpacing",
  ], "TOKEN_CONSTRAINT"));
  if (constraint.token0 !== null && !ADDRESS_RE.test(constraint.token0)) errors.push("BAD_TOKEN0");
  if (constraint.token1 !== null && !ADDRESS_RE.test(constraint.token1)) errors.push("BAD_TOKEN1");
  if (!Array.isArray(constraint.assets)) errors.push("BAD_TOKEN_ASSETS");
  else {
    errors.push(...arrayOrderAndDuplicateErrors("TOKEN_ASSETS", constraint.assets, (value) => value));
    if (constraint.assets.some((asset) => !ADDRESS_RE.test(asset))) errors.push("BAD_TOKEN_ASSET");
  }
  if (constraint.fee !== undefined && constraint.fee !== null && !boundedInteger(constraint.fee)) errors.push("BAD_TOKEN_FEE");
  if (constraint.tickSpacing !== undefined && constraint.tickSpacing !== null && !boundedInteger(constraint.tickSpacing)) {
    errors.push("BAD_TOKEN_TICK_SPACING");
  }
  return errors;
}

function delegatecallContextErrors(context: TrustManifestDelegatecallContext): string[] {
  const errors: string[] = [];
  errors.push(...objectUnknownKeyErrors(context, [
    "parentAddress",
    "callerAddress",
    "allowedSelectors",
  ], "DELEGATECALL_CONTEXT"));
  if (!ADDRESS_RE.test(context.parentAddress)) errors.push("BAD_DELEGATECALL_PARENT");
  if (!ADDRESS_RE.test(context.callerAddress)) errors.push("BAD_DELEGATECALL_CALLER");
  if (!Array.isArray(context.allowedSelectors)) errors.push("BAD_DELEGATECALL_SELECTORS");
  else {
    errors.push(...arrayOrderAndDuplicateErrors("DELEGATECALL_SELECTORS", context.allowedSelectors, (value) => value));
    if (context.allowedSelectors.some((selector) => !SELECTOR_RE.test(selector))) errors.push("BAD_DELEGATECALL_SELECTOR");
  }
  return errors;
}

function edgeErrors(edge: TrustManifestEdge): string[] {
  const errors: string[] = [];
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) return ["BAD_EDGE"];
  errors.push(...objectUnknownKeyErrors(edge, [
    "fromRole",
    "fromAddress",
    "toRole",
    "toAddress",
    "callType",
    "selector",
  ], "EDGE"));
  if (edge.fromAddress !== null && !ADDRESS_RE.test(edge.fromAddress)) errors.push("BAD_EDGE_FROM_ADDRESS");
  if (!ADDRESS_RE.test(edge.toAddress)) errors.push("BAD_EDGE_TO_ADDRESS");
  if (!allowedCallType(edge.callType)) errors.push("BAD_EDGE_CALL_TYPE");
  if (edge.selector !== null && !SELECTOR_RE.test(edge.selector)) errors.push("BAD_EDGE_SELECTOR");
  return errors;
}

function allowedCallType(value: string): boolean {
  return ["CALL", "DELEGATECALL", "STATICCALL"].includes(value);
}

function prohibitedOperationSortKey(value: string): string {
  const index = ["CREATE", "CREATE2", "SELFDESTRUCT", "CALLCODE"].indexOf(value);
  return index === -1 ? `9:${value}` : `${index}:${value}`;
}

function boundedInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalidVerification(
  validationErrors: string[],
  options: {
    manifest?: TrustManifest | null;
    signatureAlgorithm?: string | null;
    operatorPublicKeyId?: string | null;
    signature?: string | null;
    schemaStatus?: TrustManifestVerifierStatus;
    canonicalizationStatus?: TrustManifestVerifierStatus;
    invalidRecordCount?: number;
  } = {},
): VerifiedTrustManifest {
  return {
    manifest: options.manifest ?? null,
    manifestFingerprint: null,
    signatureAlgorithm: options.signatureAlgorithm ?? null,
    operatorPublicKeyId: options.operatorPublicKeyId ?? null,
    signature: options.signature ?? null,
    signatureValid: false,
    expired: false,
    blockRemaining: null,
    millisecondsRemaining: null,
    chainRouterManagerConsistent: false,
    approvedRecordCount: 0,
    invalidRecordCount: options.invalidRecordCount ?? 0,
    validationErrors,
    canonicalizationProfile: canonicalizationProfile(),
    cryptographicStatus: "FAILED",
    schemaStatus: options.schemaStatus ?? "FAILED",
    canonicalizationStatus: options.canonicalizationStatus ?? "NOT_EVALUATED",
    keyStatus: "NOT_EVALUATED",
    temporalStatus: "NOT_EVALUATED",
    revocationStatus: "NOT_EVALUATED",
    chainStateStatus: "NOT_EVALUATED",
    graphAuthorityStatus: "NOT_EVALUATED",
    temporalAuthority: null,
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
  return (
    sameNullableAddress(constraint.factoryAddress, poolState.factoryAddress) &&
    (constraint.factoryCodeHash === null ||
      poolState.factoryCodeHash === undefined ||
      lower(constraint.factoryCodeHash) === lower(poolState.factoryCodeHash)) &&
    (constraint.fee === undefined || constraint.fee === null || poolState.fee === constraint.fee) &&
    (constraint.tickSpacing === undefined ||
      constraint.tickSpacing === null ||
      poolState.tickSpacing === constraint.tickSpacing)
  );
}

function tokenConstraintMatches(
  constraint: TrustManifestTokenConstraint,
  poolState: LivePoolStateForManifest | undefined,
): boolean {
  if (!poolState) return false;
  return (
    sameNullableAddress(constraint.token0, poolState.token0) &&
    sameNullableAddress(constraint.token1, poolState.token1) &&
    (constraint.fee === undefined || constraint.fee === null || poolState.fee === constraint.fee) &&
    (constraint.tickSpacing === undefined ||
      constraint.tickSpacing === null ||
      poolState.tickSpacing === constraint.tickSpacing)
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
    lower(edge.fromAddress) ?? "null",
    edge.toRole,
    lower(edge.toAddress) ?? "",
    edge.callType?.toUpperCase?.() ?? "",
    lower(edge.selector) ?? "none",
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

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function lexCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}
