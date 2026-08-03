import { keccak256, type Hex } from "viem";
import type { AppConfig } from "../../../types.js";
import { PULSECHAIN_CHAIN_ID } from "../../../constants.js";
import { PITEAS_ROUTER } from "./constants.js";
import type { ApprovedRouterTrustRecord, PolicyCheck, RouterIntegrity, ShadowBuyReason } from "./types.js";
import { passCheck, requireCheck, warnCheck } from "./policyEvaluation.js";
import { errorMessage, fingerprint, sameAddress } from "./inputNormalization.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

export function validateRouterIntegrity(
  checks: Record<string, PolicyCheck>,
  reasons: ShadowBuyReason[],
  router: RouterIntegrity,
): void {
  requireCheck(
    checks,
    reasons,
    "router_allowlist",
    router.routerMatchesAllowlist,
    "Prepared router is not on the PHIAT shadow-buy allowlist",
    router as unknown as Record<string, unknown>,
    { code: "ROUTER_NOT_ALLOWLISTED", stage: "router_integrity" },
  );
  requireCheck(
    checks,
    reasons,
    "router_bytecode_present",
    router.bytecodePresent === true,
    "Piteas router bytecode is empty or unavailable",
    router as unknown as Record<string, unknown>,
    { code: "ROUTER_BYTECODE_UNAVAILABLE", stage: "router_integrity" },
  );
  requireCheck(
    checks,
    reasons,
    "router_code_hash_agreement",
    router.codeHashAgreement !== "disagrees" &&
      (router.proxyDetection?.rpcAgreement ?? "unavailable") !== "disagrees",
    "Router code hash or proxy implementation disagrees across RPC endpoints",
    router as unknown as Record<string, unknown>,
    { code: "ROUTER_CODE_HASH_DISAGREEMENT", stage: "router_integrity" },
  );
  if (router.routerCodeHashApproved === true) {
    passCheck(checks, "router_code_hash_approved", {
      routerBytecodeHash: router.routerBytecodeHash,
      trustRecordFingerprint: router.trustRecordFingerprint,
    });
  } else {
    warnCheck(
      checks,
      "router_code_hash_approved",
      "Router code hash is not operator-approved for unattended execution",
      {
        routerBytecodeHash: router.routerBytecodeHash,
        operatorApprovalRequired: router.operatorApprovalRequired,
        trustRecordFingerprint: router.trustRecordFingerprint,
      },
    );
  }
}

export async function readRouterIntegrity(
  config: AppConfig,
  router: string,
  approvedHashes: string[],
  approvedTrustRecords: ApprovedRouterTrustRecord[] = [],
): Promise<RouterIntegrity> {
  const urls = config.rpcUrls.length > 0 ? config.rpcUrls : [config.rpcUrl];
  const rpcCodeHashes: RouterIntegrity["rpcCodeHashes"] = [];
  for (const rpcUrl of urls) {
    try {
      rpcCodeHashes.push(await fetchRpcRouterSnapshot(rpcUrl, router, config.httpTimeoutMs));
    } catch (err) {
      rpcCodeHashes.push({
        rpcUrl,
        ok: false,
        codeHash: null,
        bytecode: null,
        bytecodeLength: null,
        blockNumber: null,
        proxyDetected: null,
        proxyType: "unavailable",
        implementationAddress: null,
        implementationCodeHash: null,
        implementationBytecode: null,
        implementationBytecodeLength: null,
        error: errorMessage(err),
      });
    }
  }

  const successful = rpcCodeHashes.filter((row) => row.ok && row.codeHash !== null);
  const routerBytecodeHash = successful[0]?.codeHash ?? null;
  const bytecodePresent = successful.length > 0 ? true : rpcCodeHashes.some((row) => row.ok) ? false : null;
  const codeHashAgreement = rpcCodeHashAgreement(rpcCodeHashes);
  const proxyDetection = buildProxyDetection(rpcCodeHashes);
  const routerCodeHashApproved =
    routerBytecodeHash === null
      ? null
      : isApprovedRouterHash({
          router,
          routerBytecodeHash,
          proxyDetection,
          approvedHashes,
          approvedTrustRecords,
        });
  const trustRecordFingerprint = fingerprint({
    router: router.toLowerCase(),
    routerBytecodeHash,
    proxyDetection,
    approvedHashes: approvedHashes.map((hash) => hash.toLowerCase()).sort(),
    approvedTrustRecords,
  });
  const warnings =
    routerCodeHashApproved === true
      ? []
      : ["Router code hash is not operator-approved for unattended execution."];

  return {
    router,
    expectedRouter: PITEAS_ROUTER,
    routerMatchesAllowlist: sameAddress(router, PITEAS_ROUTER),
    bytecodePresent,
    routerBytecodeHash,
    approvedRouterCodeHashes: approvedHashes,
    approvedRouterTrustRecords: approvedTrustRecords,
    routerCodeHashApproved,
    operatorApprovalRequired: routerCodeHashApproved !== true,
    trustRecordFingerprint,
    rpcCodeHashes,
    codeHashAgreement,
    proxyDetection,
    warnings,
  };
}

async function fetchRpcRouterSnapshot(
  rpcUrl: string,
  router: string,
  timeoutMs: number,
): Promise<RouterIntegrity["rpcCodeHashes"][number]> {
  const blockHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", [], timeoutMs);
  const blockNumber = BigInt(blockHex).toString();
  const code = await rpcCall<string>(rpcUrl, "eth_getCode", [router, blockHex], timeoutMs);
  const bytecodeLength = code === "0x" ? 0 : (code.length - 2) / 2;
  const codeHash = code === "0x" ? null : keccak256(code as Hex);
  const eip1967Implementation = await readEip1967Implementation(rpcUrl, router, blockHex, timeoutMs);
  const eip1167Implementation =
    eip1967Implementation === null ? implementationFromMinimalProxy(code) : null;
  const implementationAddress = eip1967Implementation ?? eip1167Implementation;
  const proxyType =
    eip1967Implementation !== null
      ? "eip1967"
      : eip1167Implementation !== null
        ? "eip1167"
        : "none";
  let implementationCodeHash: string | null = null;
  let implementationBytecode: string | null = null;
  let implementationBytecodeLength: number | null = null;
  if (implementationAddress) {
    implementationBytecode = await rpcCall<string>(
      rpcUrl,
      "eth_getCode",
      [implementationAddress, blockHex],
      timeoutMs,
    );
    implementationBytecodeLength =
      implementationBytecode === "0x" ? 0 : (implementationBytecode.length - 2) / 2;
    implementationCodeHash =
      implementationBytecode === "0x" ? null : keccak256(implementationBytecode as Hex);
  }
  return {
    rpcUrl,
    ok: true,
    codeHash,
    bytecode: code,
    bytecodeLength,
    blockNumber,
    proxyDetected: implementationAddress !== null,
    proxyType,
    implementationAddress,
    implementationCodeHash,
    implementationBytecode,
    implementationBytecodeLength,
    error: null,
  };
}

async function readEip1967Implementation(
  rpcUrl: string,
  router: string,
  blockHex: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const storage = await rpcCall<string>(
      rpcUrl,
      "eth_getStorageAt",
      [router, EIP1967_IMPLEMENTATION_SLOT, blockHex],
      timeoutMs,
    );
    if (!/^0x[0-9a-fA-F]{64}$/.test(storage)) return null;
    const address = `0x${storage.slice(-40)}`;
    return /^0x0{40}$/i.test(address) ? null : address;
  } catch {
    return null;
  }
}

function implementationFromMinimalProxy(bytecode: string): string | null {
  const lower = bytecode.toLowerCase();
  if (!lower.startsWith(EIP1167_PREFIX) || !lower.endsWith(EIP1167_SUFFIX)) return null;
  const start = EIP1167_PREFIX.length;
  return `0x${lower.slice(start, start + 40)}`;
}

function buildProxyDetection(
  rows: RouterIntegrity["rpcCodeHashes"],
): RouterIntegrity["proxyDetection"] {
  const detected = rows.filter((row) => row.ok && row.proxyDetected === true);
  const available = rows.filter((row) => row.ok);
  const implementationAddresses = detected.map((row) => row.implementationAddress);
  const implementationCodeHashes = detected.map((row) => row.implementationCodeHash);
  const proxyTypes = detected.map((row) => row.proxyType).filter((value): value is "eip1967" | "eip1167" =>
    value === "eip1967" || value === "eip1167",
  );
  const proxyDetected =
    available.length === 0 ? null : detected.length > 0;
  const rpcAgreement = proxyAgreement({
    detectedCount: detected.length,
    availableCount: available.length,
    implementationAddresses,
    implementationCodeHashes,
    proxyTypes,
  });
  return {
    proxyDetected,
    proxyType:
      proxyDetected === true
        ? uniqueLower(proxyTypes).length === 1
          ? proxyTypes[0]!
          : "unavailable"
        : available.length > 0
          ? "none"
          : "unavailable",
    implementationAddress: firstNonNull(implementationAddresses),
    implementationCodeHash: firstNonNull(implementationCodeHashes),
    implementationBytecode: firstNonNull(detected.map((row) => row.implementationBytecode)),
    implementationBytecodeLength: firstNonNull(detected.map((row) => row.implementationBytecodeLength)),
    rpcAgreement,
    blockNumbers: rows.map((row) => row.blockNumber).filter((value): value is string => Boolean(value)),
  };
}

function isApprovedRouterHash(args: {
  router: string;
  routerBytecodeHash: string;
  proxyDetection: RouterIntegrity["proxyDetection"];
  approvedHashes: string[];
  approvedTrustRecords: ApprovedRouterTrustRecord[];
}): boolean {
  const routerHash = args.routerBytecodeHash.toLowerCase();
  if (args.approvedHashes.some((hash) => hash.toLowerCase() === routerHash)) return true;
  return args.approvedTrustRecords.some((record) => {
    if (record.router && !sameAddress(record.router, args.router)) return false;
    if (record.chainId !== undefined && record.chainId !== PULSECHAIN_CHAIN_ID) return false;
    if (record.codeHash.toLowerCase() !== routerHash) return false;
    if (
      record.implementationAddress !== undefined &&
      !sameNullableAddress(record.implementationAddress, args.proxyDetection.implementationAddress)
    ) {
      return false;
    }
    if (
      record.implementationCodeHash !== undefined &&
      !sameNullableString(record.implementationCodeHash, args.proxyDetection.implementationCodeHash)
    ) {
      return false;
    }
    return true;
  });
}

function agreement(values: Array<string | null | undefined>): RouterIntegrity["codeHashAgreement"] {
  const present = values.filter((value): value is string => Boolean(value));
  if (present.length === 0) return "unavailable";
  if (present.length === 1) return "single_rpc";
  return new Set(present.map((value) => value.toLowerCase())).size === 1
    ? "agrees"
    : "disagrees";
}

function rpcCodeHashAgreement(rows: RouterIntegrity["rpcCodeHashes"]): RouterIntegrity["codeHashAgreement"] {
  const okHashes = rows.filter((row) => row.ok).map((row) => row.codeHash);
  if (okHashes.length === 0) return "unavailable";
  const present = okHashes.filter((value): value is string => Boolean(value));
  if (present.length === 0) return "unavailable";
  if (present.length !== okHashes.length) return "disagrees";
  return agreement(present);
}

function proxyAgreement(args: {
  detectedCount: number;
  availableCount: number;
  implementationAddresses: Array<string | null | undefined>;
  implementationCodeHashes: Array<string | null | undefined>;
  proxyTypes: string[];
}): RouterIntegrity["codeHashAgreement"] {
  if (args.detectedCount === 0) return "unavailable";
  if (args.detectedCount !== args.availableCount) return "disagrees";
  const fieldAgreements = [
    agreement(args.implementationAddresses),
    agreement(args.implementationCodeHashes),
    agreement(args.proxyTypes),
  ];
  if (fieldAgreements.includes("disagrees")) return "disagrees";
  if (fieldAgreements.includes("single_rpc")) return "single_rpc";
  if (fieldAgreements.every((value) => value === "agrees" || value === "unavailable")) {
    return "agrees";
  }
  return "unavailable";
}

function firstNonNull<T>(values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function uniqueLower(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function sameNullableAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return sameAddress(a, b);
}

function sameNullableString(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return typeof b === "string" && a.toLowerCase() === b.toLowerCase();
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
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (body.error) throw new Error(body.error.message ?? `${method} RPC error`);
    if (body.result === undefined) throw new Error(`${method} result missing`);
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}
