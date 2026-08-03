import { generateKeyPairSync, sign as testSign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PITEAS_ROUTER,
  canonicalizeJson,
  manifestFingerprint,
  manifestIdFor,
  publicKeyIdFromSpkiDer,
  signatureFrameForManifest,
  TRUST_MANIFEST_SIGNATURE_ALGORITHM,
  verifySignedTrustManifest,
  type TrustManifest,
  type TrustManifestEdge,
  type TrustManifestRecord,
} from "../src/tools/analytics/phiatShadowBuy.js";
import {
  assembleOfflineSignedWrapper,
  exportOfflineSigningMaterials,
  inspectOfflineTrustManifest,
  keyRevocationEntry,
  manifestRevocationEntry,
  publicKeyRegistryInfoFromSpkiDer,
} from "../src/tools/analytics/phiat-shadow-buy/offlineTrustSigner.js";
import { getRegisteredTools } from "../src/tools/define.js";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const HISTORICAL_TX = "0x1a0d519d0b1ae9e0f759d2a068fa720c3759d5f057b611f91c726ef8db570a56";
const HISTORICAL_BLOCK = "27195532";
const GRAPH_FINGERPRINT = "0xce502a0183e96397d87830058d9f5435561d3d83d5f862aa89a0fb697eb3e4a0";
const BUNDLE_FINGERPRINT = "0x31d3699d69625f370d73e9a04e62d636070d9b0019104efe77359202ab00a819";
const ROUTER_HASH = "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b";
const MANAGER = "0x58ab37d02696a481e2e5b5779967f3f4d237baa9";
const MANAGER_HASH = "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb";
const TARGET = "0x1111111111111111111111111111111111111111";
const TARGET_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function testKey() {
  const pair = generateKeyPairSync("ed25519");
  const publicSpkiDer = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = publicKeyIdFromSpkiDer(publicSpkiDer);
  return { ...pair, publicSpkiDer, keyId };
}

function record(): TrustManifestRecord {
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
    expiresAtBlock: null,
    residualRisks: [],
  };
}

function edge(): TrustManifestEdge {
  return {
    fromRole: "PITEAS_SWAP_MANAGER",
    fromAddress: MANAGER,
    toRole: "PROTOCOL_ROUTER",
    toAddress: TARGET,
    callType: "CALL",
    selector: "0xabcdef01",
  };
}

function manifest(operatorPublicKeyId: string): TrustManifest {
  const withoutId = {
    version: "phiat-execution-trust-v1" as const,
    manifestId: `0x${"00".repeat(32)}`,
    chainId: 369,
    historicalTransaction: HISTORICAL_TX,
    historicalBlock: HISTORICAL_BLOCK,
    graphFingerprint: GRAPH_FINGERPRINT,
    bundleFingerprint: BUNDLE_FINGERPRINT,
    router: { address: PITEAS_ROUTER.toLowerCase(), runtimeCodeHash: ROUTER_HASH },
    swapManager: {
      address: MANAGER,
      runtimeCodeHash: MANAGER_HASH,
      storageSlot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      storageOffsetBytes: 0,
      storageWidthBytes: 20,
      managerChangeEventBlock: null,
    },
    records: [record()],
    allowedEdges: [edge()],
    prohibitedOperations: ["CREATE", "CREATE2", "SELFDESTRUCT", "CALLCODE"] as const,
    approvalPolicy: {
      unexpectedTarget: "REJECT" as const,
      unexpectedSelector: "REJECT" as const,
      unexpectedEdge: "REJECT" as const,
      codeHashChange: "REJECT" as const,
      managerChange: "REJECT" as const,
      routerChange: "REJECT" as const,
      expiredManifest: "REJECT" as const,
    },
    approvedAt: "2026-08-03T00:00:00.000Z",
    approvedAtBlock: null,
    expiresAt: "2026-08-04T00:00:00.000Z",
    expiresAtBlock: null,
    operatorPublicKeyId,
  };
  return { ...withoutId, manifestId: manifestIdFor(withoutId) };
}

function manifestText(operatorPublicKeyId: string): string {
  return JSON.stringify({ manifest: manifest(operatorPublicKeyId) }, null, 2);
}

describe("offline PHIAT trust-manifest signing ceremony", () => {
  it("exports production canonical bytes, frame, fingerprint, metadata, and deterministic review", () => {
    const key = testKey();
    const first = exportOfflineSigningMaterials(manifestText(key.keyId));
    const second = exportOfflineSigningMaterials(manifestText(key.keyId));

    expect(first.canonicalManifestJson).toBe(canonicalizeJson(first.manifest));
    expect(Buffer.from(first.signingFrame).equals(signatureFrameForManifest(first.manifest))).toBe(true);
    expect(first.manifestFingerprint).toBe(manifestFingerprint(first.manifest));
    expect(first.operatorReviewMarkdown).toBe(second.operatorReviewMarkdown);
    expect(first.operatorReviewMarkdown).toContain("Chain ID: 369");
    expect(first.operatorReviewMarkdown).toContain("Approved selectors: 0xabcdef01");
    expect(first.operatorReviewMarkdown).toContain("Allowed Graph Edges");
    expect(JSON.parse(first.signingMetadataJson)).toMatchObject({
      signatureAlgorithm: TRUST_MANIFEST_SIGNATURE_ALGORITHM,
      manifestFingerprint: first.manifestFingerprint,
    });
  });

  it("rejects duplicate keys, trailing JSON, and unknown authority fields", () => {
    const key = testKey();
    expect(() => exportOfflineSigningMaterials(`{"manifest":{},"manifest":{}}`)).toThrow("STRICT_JSON_DUPLICATE_KEY");
    expect(() => exportOfflineSigningMaterials(`${manifestText(key.keyId)} {}`)).toThrow("STRICT_JSON_TRAILING_DATA");
    const altered = { manifest: { ...manifest(key.keyId), surpriseAuthority: true } };
    expect(() => exportOfflineSigningMaterials(JSON.stringify(altered))).toThrow("MANIFEST_UNKNOWN_FIELD_surpriseAuthority");
  });

  it("assembles a signed wrapper and verifies the round trip independently", () => {
    const key = testKey();
    const inputText = manifestText(key.keyId);
    const materials = exportOfflineSigningMaterials(inputText);
    const signature = testSign(null, materials.signingFrame, key.privateKey);
    const assembled = assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: materials.signingFrame,
      signatureBytes: signature,
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    });

    expect(assembled.verification.signatureValid).toBe(true);
    expect(assembled.verification.manifestAuthorizationStatus).toBe("VALID");
    expect(assembled.verification.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(assembled.verification.executionAuthority).toBe("NOT_EVALUATED");
    const independent = verifySignedTrustManifest(assembled.wrapper, {
      pinnedPublicKeys: { [key.keyId]: Buffer.from(key.publicSpkiDer).toString("base64") },
      nowMs: NOW,
      currentBlock: null,
    });
    expect(independent.manifestAuthorizationStatus).toBe("VALID");
    expect(independent.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(independent.executionAuthority).toBe("NOT_EVALUATED");
  });

  it("rejects modified frame, manifest, signature, key, key ID, and signature length changes", () => {
    const key = testKey();
    const otherKey = testKey();
    const inputText = manifestText(key.keyId);
    const materials = exportOfflineSigningMaterials(inputText);
    const signature = testSign(null, materials.signingFrame, key.privateKey);
    const changedFrame = Buffer.from(materials.signingFrame);
    changedFrame[0] ^= 1;
    expect(() => assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: changedFrame,
      signatureBytes: signature,
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("SIGNING_FRAME_MISMATCH");

    const changedManifest = JSON.stringify({ manifest: { ...manifest(key.keyId), chainId: 943 } });
    expect(() => assembleOfflineSignedWrapper({
      manifestText: changedManifest,
      providedFrame: materials.signingFrame,
      signatureBytes: signature,
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("SIGNING_FRAME_MISMATCH");

    const changedSignature = Buffer.from(signature);
    changedSignature[0] ^= 1;
    expect(() => assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: materials.signingFrame,
      signatureBytes: changedSignature,
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("SIGNATURE_INVALID");

    expect(() => assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: materials.signingFrame,
      signatureBytes: signature,
      publicSpkiDer: otherKey.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("OPERATOR_PUBLIC_KEY_ID_MISMATCH");

    expect(() => assembleOfflineSignedWrapper({
      manifestText: manifestText(otherKey.keyId),
      providedFrame: materials.signingFrame,
      signatureBytes: signature,
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("SIGNING_FRAME_MISMATCH");

    expect(() => assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: materials.signingFrame,
      signatureBytes: signature.subarray(0, 63),
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("SIGNATURE_LENGTH_INVALID");
    expect(() => assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: materials.signingFrame,
      signatureBytes: Buffer.concat([signature, Buffer.from([0])]),
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    })).toThrow("SIGNATURE_LENGTH_INVALID");
  });

  it("rejects non-Ed25519 public keys", () => {
    const key = testKey();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" });
    const materials = exportOfflineSigningMaterials(manifestText(key.keyId));
    const signature = testSign(null, materials.signingFrame, key.privateKey);
    expect(() => assembleOfflineSignedWrapper({
      manifestText: manifestText(key.keyId),
      providedFrame: materials.signingFrame,
      signatureBytes: signature,
      publicSpkiDer: rsa,
      nowMs: NOW,
    })).toThrow("PUBLIC_KEY_NOT_ED25519");
  });

  it("inspects unsigned and signed manifests without creating authority", () => {
    const key = testKey();
    const inputText = manifestText(key.keyId);
    const materials = exportOfflineSigningMaterials(inputText);
    const unsigned = inspectOfflineTrustManifest({ inputText, nowMs: NOW });
    expect(unsigned.kind).toBe("UNSIGNED");
    expect(unsigned.report).toContain("signatureRequired=true");
    expect(unsigned.report).toContain("manifestAuthorizationStatus=INVALID");
    expect(unsigned.report).toContain("liveExecutionAuthorityStatus=NOT_EVALUATED");
    expect(unsigned.report).toContain("executionAuthority=NOT_EVALUATED");

    const signed = assembleOfflineSignedWrapper({
      manifestText: inputText,
      providedFrame: materials.signingFrame,
      signatureBytes: testSign(null, materials.signingFrame, key.privateKey),
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    });
    const signedInspection = inspectOfflineTrustManifest({
      inputText: JSON.stringify(signed.wrapper),
      publicSpkiDer: key.publicSpkiDer,
      nowMs: NOW,
    });
    expect(signedInspection.kind).toBe("SIGNED");
    expect(signedInspection.report).toContain("cryptographicStatus=PASSED");
    expect(signedInspection.report).toContain("manifestAuthorizationStatus=VALID");
    expect(signedInspection.report).toContain("liveExecutionAuthorityStatus=NOT_EVALUATED");
    expect(signedInspection.report).toContain("executionAuthority=NOT_EVALUATED");
    expect(signedInspection.report).toContain("graphAuthorityStatus=NOT_EVALUATED");
    expect(signedInspection.report).toContain("automaticExecutionEligible=false");
  });

  it("derives public-key registry and revocation candidate entries without config writes", () => {
    const key = testKey();
    const info = publicKeyRegistryInfoFromSpkiDer(key.publicSpkiDer);
    expect(info.keyId).toBe(key.keyId);
    expect(info.spkiDerBase64).toBe(Buffer.from(key.publicSpkiDer).toString("base64"));
    expect(info.registryEntry).toMatchObject({
      keyId: key.keyId,
      algorithm: "Ed25519",
      status: "ACTIVE",
      allowedChainIds: [369],
    });
    expect(manifestRevocationEntry(`0x${"11".repeat(32)}`, "test", "2026-08-03T00:00:00.000Z")).toMatchObject({
      manifestFingerprint: `0x${"11".repeat(32)}`,
      reason: "test",
    });
    expect(keyRevocationEntry(key.keyId, "test", "2026-08-03T00:00:00.000Z")).toMatchObject({
      keyId: key.keyId,
      reason: "test",
    });
  });

  it("keeps scripts outside MCP registration and refuses overwrite by construction", () => {
    const names = new Set(getRegisteredTools().map((tool) => tool.name));
    expect(names.has("phiat-trust-export-frame")).toBe(false);
    expect(names.has("phiat-trust-assemble-signed-manifest")).toBe(false);
    expect(names.has("phiat-trust-inspect-manifest")).toBe(false);
    for (const script of [
      "scripts/phiat-trust-export-frame.mjs",
      "scripts/phiat-trust-assemble-signed-manifest.mjs",
    ]) {
      const text = readFileSync(script, "utf8");
      expect(text).toContain('flag: force ? "w" : "wx"');
    }
  });

  it("has no production secret-key handling or production signing path in ceremony code", () => {
    const files = [
      "scripts/phiat-trust-export-frame.mjs",
      "scripts/phiat-trust-assemble-signed-manifest.mjs",
      "scripts/phiat-trust-inspect-manifest.mjs",
      "scripts/phiat-trust-public-key-info.mjs",
      "scripts/phiat-trust-revocation-entry.mjs",
      "src/tools/analytics/phiat-shadow-buy/executionTrustManifest.ts",
      "src/tools/analytics/phiat-shadow-buy/offlineTrustSigner.ts",
    ];
    const forbidden = [
      /createPrivateKey/,
      /generateKeyPair/,
      /generateKeyPairSync/,
      /crypto\.sign/,
      /PRIVATE_KEY/,
      /MASTER_KEY/,
      /SEED_PHRASE/,
      /MNEMONIC/,
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) expect(text).not.toMatch(pattern);
      expect(text).not.toMatch(/privateKey/);
      expect(text).not.toMatch(/agent-wallet/i);
      expect(text).not.toMatch(/sendTransaction|sendRawTransaction|broadcast|execute_agent_tx|sign_and_send/);
    }
  });

  it("uses temporary test material without writing secret-key files", () => {
    const dir = mkdtempSync(join(tmpdir(), "phiat-offline-"));
    const key = testKey();
    const materials = exportOfflineSigningMaterials(manifestText(key.keyId));
    const sig = testSign(null, materials.signingFrame, key.privateKey);
    writeFileSync(join(dir, "canonical-manifest.json"), materials.canonicalManifestJson);
    writeFileSync(join(dir, "signing-frame.bin"), materials.signingFrame);
    writeFileSync(join(dir, "signature.bin"), sig);
    writeFileSync(join(dir, "operator-public.spki.der"), key.publicSpkiDer);
    const files = readdirSync(dir);
    expect(files).toEqual(expect.arrayContaining([
      "canonical-manifest.json",
      "signing-frame.bin",
      "signature.bin",
      "operator-public.spki.der",
    ]));
    expect(files.join("|")).not.toMatch(/private|seed|mnemonic|master/i);
  });
});
