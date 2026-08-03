import { createPublicKey, verify as verifyDetached } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  canonicalizationProfile,
  parseTrustManifestJsonText,
  prepareCanonicalTrustManifest,
  publicKeyIdFromSpkiDer,
  signatureFrameSpecification,
  TRUST_MANIFEST_CANONICALIZATION,
  TRUST_MANIFEST_SIGNATURE_ALGORITHM,
  verifySignedTrustManifest,
  type SignedTrustManifest,
  type TrustManifest,
  type VerifiedTrustManifest,
} from "./executionTrustManifest.js";

export interface OfflineSigningMaterials {
  manifest: TrustManifest;
  canonicalManifestJson: string;
  signingFrame: Buffer;
  manifestFingerprint: string;
  operatorReviewMarkdown: string;
  signingMetadataJson: string;
}

export interface OfflineSignedWrapperResult {
  wrapper: SignedTrustManifest;
  verification: VerifiedTrustManifest;
}

export interface PublicKeyRegistryInfo {
  keyId: string;
  algorithm: typeof TRUST_MANIFEST_SIGNATURE_ALGORITHM;
  spkiDerBase64: string;
  status: "ACTIVE";
  allowedManifestVersions: readonly ["phiat-execution-trust-v1"];
  allowedChainIds: readonly [369];
  registryEntry: {
    keyId: string;
    algorithm: typeof TRUST_MANIFEST_SIGNATURE_ALGORITHM;
    spkiDerBase64: string;
    status: "ACTIVE";
    allowedManifestVersions: readonly ["phiat-execution-trust-v1"];
    allowedChainIds: readonly [369];
  };
}

export function exportOfflineSigningMaterials(inputText: string): OfflineSigningMaterials {
  const prepared = prepareManifestFromText(inputText);
  const frameSpec = signatureFrameSpecification(prepared.manifest);
  if (frameSpec.testVector !== prepared.signatureFrame.toString("hex")) {
    throw new Error("SIGNATURE_FRAME_TEST_VECTOR_MISMATCH");
  }
  const metadata = {
    canonicalization: TRUST_MANIFEST_CANONICALIZATION,
    canonicalizationProfile: canonicalizationProfile(),
    signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    signatureFrame: frameSpec,
    manifestFingerprint: prepared.manifestFingerprint,
    operatorPublicKeyId: prepared.manifest.operatorPublicKeyId,
    files: {
      canonicalManifest: "canonical-manifest.json",
      signingFrame: "signing-frame.bin",
      manifestFingerprint: "manifest-fingerprint.txt",
      operatorReview: "operator-review.md",
    },
  };
  return {
    manifest: prepared.manifest,
    canonicalManifestJson: prepared.canonicalManifestJson,
    signingFrame: prepared.signatureFrame,
    manifestFingerprint: prepared.manifestFingerprint,
    operatorReviewMarkdown: renderOfflineAuthorityReview(prepared.manifest, prepared.manifestFingerprint),
    signingMetadataJson: `${JSON.stringify(metadata, null, 2)}\n`,
  };
}

export function assembleOfflineSignedWrapper(args: {
  manifestText: string;
  providedFrame: Uint8Array;
  signatureBytes: Uint8Array;
  publicSpkiDer: Uint8Array;
  nowMs?: number;
  currentBlock?: string | null;
}): OfflineSignedWrapperResult {
  const prepared = prepareManifestFromText(args.manifestText);
  const providedFrame = Buffer.from(args.providedFrame);
  if (!providedFrame.equals(prepared.signatureFrame)) throw new Error("SIGNING_FRAME_MISMATCH");
  const signature = Buffer.from(args.signatureBytes);
  if (signature.length !== 64) throw new Error("SIGNATURE_LENGTH_INVALID");

  const publicKey = publicEd25519KeyFromSpkiDer(args.publicSpkiDer);
  const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const operatorPublicKeyId = publicKeyIdFromSpkiDer(publicDer);
  if (operatorPublicKeyId !== prepared.manifest.operatorPublicKeyId) {
    throw new Error("OPERATOR_PUBLIC_KEY_ID_MISMATCH");
  }
  const signatureValid = verifyDetached(null, prepared.signatureFrame, publicKey, signature);
  if (!signatureValid) throw new Error("SIGNATURE_INVALID");

  const spkiDerBase64 = publicDer.toString("base64");
  const wrapper: SignedTrustManifest = {
    manifest: prepared.manifest,
    manifestFingerprint: prepared.manifestFingerprint,
    signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    operatorPublicKeyId,
    signature: signature.toString("base64"),
  };
  const verification = verifySignedTrustManifest(wrapper, {
    pinnedPublicKeys: { [operatorPublicKeyId]: spkiDerBase64 },
    nowMs: args.nowMs,
    currentBlock: args.currentBlock ?? null,
  });
  if (
    !verification.signatureValid ||
    verification.cryptographicStatus !== "PASSED" ||
    verification.schemaStatus !== "PASSED" ||
    verification.canonicalizationStatus !== "PASSED" ||
    verification.keyStatus !== "PASSED" ||
    verification.temporalStatus === "FAILED" ||
    verification.executionAuthority !== "VALID"
  ) {
    throw new Error(`SIGNED_WRAPPER_VERIFICATION_FAILED:${verification.validationErrors.join(",")}`);
  }
  return { wrapper, verification };
}

export function inspectOfflineTrustManifest(args: {
  inputText: string;
  publicSpkiDer?: Uint8Array;
  nowMs?: number;
  currentBlock?: string | null;
}): {
  kind: "UNSIGNED" | "SIGNED";
  report: string;
  verification: VerifiedTrustManifest | null;
} {
  const parsed = parseStrictInputText(args.inputText) as Record<string, unknown>;
  const isSigned = parsed.signature !== undefined;
  if (!isSigned) {
    const prepared = prepareManifestFromText(args.inputText);
    return {
      kind: "UNSIGNED",
      verification: null,
      report: [
        `kind=UNSIGNED`,
        `manifestId=${prepared.manifest.manifestId}`,
        `manifestFingerprint=${prepared.manifestFingerprint}`,
        `operatorPublicKeyId=${prepared.manifest.operatorPublicKeyId}`,
        `signatureRequired=true`,
        `executionAuthority=INVALID`,
        `automaticExecutionEligible=false`,
      ].join("\n"),
    };
  }
  const publicDer = args.publicSpkiDer ? Buffer.from(args.publicSpkiDer) : null;
  const keyId = publicDer ? publicKeyIdFromSpkiDer(publicDer) : "public-key-required";
  const verification = verifySignedTrustManifest(parsed, {
    pinnedPublicKeys: publicDer ? { [keyId]: publicDer.toString("base64") } : {},
    nowMs: args.nowMs,
    currentBlock: args.currentBlock ?? null,
  });
  return {
    kind: "SIGNED",
    verification,
    report: [
      `kind=SIGNED`,
      `manifestFingerprint=${verification.manifestFingerprint ?? "unknown"}`,
      `cryptographicStatus=${verification.cryptographicStatus}`,
      `schemaStatus=${verification.schemaStatus}`,
      `canonicalizationStatus=${verification.canonicalizationStatus}`,
      `keyStatus=${verification.keyStatus}`,
      `temporalStatus=${verification.temporalStatus}`,
      `revocationStatus=${verification.revocationStatus}`,
      `chainStateStatus=${verification.chainStateStatus}`,
      `graphAuthorityStatus=${verification.graphAuthorityStatus}`,
      `executionAuthority=${verification.executionAuthority}`,
      `automaticExecutionEligible=false`,
      `validationErrors=${verification.validationErrors.join(",") || "none"}`,
    ].join("\n"),
  };
}

export function publicKeyRegistryInfoFromSpkiDer(publicSpkiDer: Uint8Array): PublicKeyRegistryInfo {
  const publicKey = publicEd25519KeyFromSpkiDer(publicSpkiDer);
  const canonicalDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const keyId = publicKeyIdFromSpkiDer(canonicalDer);
  const spkiDerBase64 = canonicalDer.toString("base64");
  const registryEntry = {
    keyId,
    algorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
    spkiDerBase64,
    status: "ACTIVE" as const,
    allowedManifestVersions: ["phiat-execution-trust-v1"] as const,
    allowedChainIds: [369] as const,
  };
  return { ...registryEntry, registryEntry };
}

export function manifestRevocationEntry(manifestFingerprint: string, reason: string, revokedAt: string): {
  manifestFingerprint: string;
  revokedAt: string;
  reason: string;
} {
  if (!/^0x[a-f0-9]{64}$/.test(manifestFingerprint)) throw new Error("MANIFEST_FINGERPRINT_INVALID");
  return { manifestFingerprint, revokedAt, reason };
}

export function keyRevocationEntry(keyId: string, reason: string, revokedAt: string): {
  keyId: string;
  revokedAt: string;
  reason: string;
} {
  if (!/^0x[a-f0-9]{64}$/.test(keyId)) throw new Error("OPERATOR_PUBLIC_KEY_ID_INVALID");
  return { keyId, revokedAt, reason };
}

function prepareManifestFromText(inputText: string): {
  manifest: TrustManifest;
  manifestFingerprint: string;
  canonicalManifestJson: string;
  signatureFrame: Buffer;
} {
  const parsed = parseStrictInputText(inputText);
  const prepared = prepareCanonicalTrustManifest(parsed);
  if (!prepared.ok) throw new Error(`MANIFEST_INVALID:${prepared.errors.join(",")}`);
  return prepared;
}

function parseStrictInputText(inputText: string): unknown {
  const parsed = parseTrustManifestJsonText(inputText);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function publicEd25519KeyFromSpkiDer(publicSpkiDer: Uint8Array): KeyObject {
  const inputDer = Buffer.from(publicSpkiDer);
  const key = createPublicKey({ key: inputDer, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("PUBLIC_KEY_NOT_ED25519");
  const canonicalDer = Buffer.from(key.export({ format: "der", type: "spki" }));
  if (!canonicalDer.equals(inputDer)) throw new Error("PUBLIC_KEY_DER_NOT_CANONICAL");
  return key;
}

function renderOfflineAuthorityReview(manifest: TrustManifest, manifestFingerprintValue: string): string {
  const lines = [
    "# PHIAT Execution Trust Manifest Review",
    "",
    `- Chain ID: ${manifest.chainId}`,
    `- Manifest version: ${manifest.version}`,
    `- Manifest ID: ${manifest.manifestId}`,
    `- Manifest fingerprint: ${manifestFingerprintValue}`,
    `- Historical transaction: ${manifest.historicalTransaction}`,
    `- Historical block: ${manifest.historicalBlock}`,
    `- Graph fingerprint: ${manifest.graphFingerprint}`,
    `- Bundle fingerprint: ${manifest.bundleFingerprint}`,
    `- Router: ${manifest.router.address}`,
    `- Router runtime hash: ${manifest.router.runtimeCodeHash}`,
    `- SwapManager: ${manifest.swapManager.address}`,
    `- SwapManager runtime hash: ${manifest.swapManager.runtimeCodeHash}`,
    `- SwapManager storage slot: ${manifest.swapManager.storageSlot}`,
    `- SwapManager storage offset bytes: ${manifest.swapManager.storageOffsetBytes}`,
    `- SwapManager storage width bytes: ${manifest.swapManager.storageWidthBytes}`,
    `- SwapManager change event block: ${manifest.swapManager.managerChangeEventBlock ?? "none"}`,
    `- Approved at: ${manifest.approvedAt ?? "none"}`,
    `- Approved at block: ${manifest.approvedAtBlock ?? "none"}`,
    `- Expires at: ${manifest.expiresAt ?? "none"}`,
    `- Expires at block: ${manifest.expiresAtBlock ?? "none"}`,
    `- Expected operator public-key ID: ${manifest.operatorPublicKeyId}`,
    "",
    "## Records",
  ];
  for (const record of manifest.records) {
    lines.push(
      "",
      `### ${record.address}`,
      `- Role: ${record.role}`,
      `- Runtime code hash: ${record.runtimeCodeHash ?? "none"}`,
      `- Implementation address: ${record.implementationAddress ?? "none"}`,
      `- Implementation code hash: ${record.implementationCodeHash ?? "none"}`,
      `- Approved selectors: ${record.approvedSelectors.join(", ") || "none"}`,
      `- Allowed call types: ${record.allowedCallTypes.join(", ") || "none"}`,
      `- Parent constraints: ${JSON.stringify(record.parentConstraints)}`,
      `- Caller constraints: ${JSON.stringify(record.callerConstraints)}`,
      `- Factory constraints: ${record.factoryConstraints ? JSON.stringify(record.factoryConstraints) : "none"}`,
      `- Token constraints: ${record.tokenConstraints ? JSON.stringify(record.tokenConstraints) : "none"}`,
      `- Delegatecall context: ${record.delegatecallContext ? JSON.stringify(record.delegatecallContext) : "none"}`,
      `- Manager hash constraint: ${record.managerHashConstraint ?? "none"}`,
      `- Router hash constraint: ${record.routerHashConstraint ?? "none"}`,
      `- First approved block: ${record.firstApprovedBlock}`,
      `- Record expires at block: ${record.expiresAtBlock ?? "none"}`,
      `- Residual risks: ${record.residualRisks.join("; ") || "none"}`,
    );
  }
  lines.push("", "## Allowed Graph Edges");
  for (const edge of manifest.allowedEdges) {
    lines.push(
      `- ${edge.fromRole ?? "unknown"}:${edge.fromAddress ?? "null"} -> ${edge.toRole}:${edge.toAddress} ${edge.callType} ${edge.selector ?? "none"}`,
    );
  }
  lines.push("", "## Prohibited Operations", manifest.prohibitedOperations.map((value) => `- ${value}`).join("\n"));
  return `${lines.join("\n")}\n`;
}
