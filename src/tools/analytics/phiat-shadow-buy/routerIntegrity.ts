import { keccak256, type Hex } from "viem";
import type { AppConfig } from "../../../types.js";
import { PITEAS_ROUTER } from "./constants.js";
import type { PolicyCheck, RouterIntegrity } from "./types.js";
import { passCheck, requireCheck, warnCheck } from "./policyEvaluation.js";
import { errorMessage, sameAddress } from "./inputNormalization.js";

export function validateRouterIntegrity(
  checks: Record<string, PolicyCheck>,
  reasons: string[],
  router: RouterIntegrity,
): void {
  requireCheck(
    checks,
    reasons,
    "router_allowlist",
    router.routerMatchesAllowlist,
    "Prepared router is not on the PHIAT shadow-buy allowlist",
    router as unknown as Record<string, unknown>,
  );
  requireCheck(
    checks,
    reasons,
    "router_bytecode_present",
    router.bytecodePresent === true,
    "Piteas router bytecode is empty or unavailable",
    router as unknown as Record<string, unknown>,
  );
  requireCheck(
    checks,
    reasons,
    "router_code_hash_agreement",
    router.codeHashAgreement !== "disagrees",
    "Router code hash disagrees across RPC endpoints",
    router as unknown as Record<string, unknown>,
  );
  if (router.routerCodeHashApproved === true) {
    passCheck(checks, "router_code_hash_approved", {
      routerBytecodeHash: router.routerBytecodeHash,
    });
  } else {
    warnCheck(
      checks,
      "router_code_hash_approved",
      "Router code hash is not operator-approved for unattended execution",
      { routerBytecodeHash: router.routerBytecodeHash },
    );
  }
}

export async function readRouterIntegrity(
  config: AppConfig,
  router: string,
  approvedHashes: string[],
): Promise<RouterIntegrity> {
  const urls = (config.rpcUrls.length > 0 ? config.rpcUrls : [config.rpcUrl]).slice(0, 2);
  const rpcCodeHashes: RouterIntegrity["rpcCodeHashes"] = [];
  for (const rpcUrl of urls) {
    try {
      const code = await fetchRpcCode(rpcUrl, router, config.httpTimeoutMs);
      const bytecodeLength = code === "0x" ? 0 : (code.length - 2) / 2;
      const codeHash = code === "0x" ? null : keccak256(code as Hex);
      rpcCodeHashes.push({ rpcUrl, ok: true, codeHash, bytecodeLength, error: null });
    } catch (err) {
      rpcCodeHashes.push({
        rpcUrl,
        ok: false,
        codeHash: null,
        bytecodeLength: null,
        error: errorMessage(err),
      });
    }
  }
  const successful = rpcCodeHashes.filter((row) => row.ok && row.codeHash !== null);
  const uniqueHashes = new Set(successful.map((row) => row.codeHash));
  const routerBytecodeHash = successful[0]?.codeHash ?? null;
  const bytecodePresent = successful.length > 0 ? true : rpcCodeHashes.some((row) => row.ok) ? false : null;
  const codeHashAgreement =
    successful.length === 0
      ? "unavailable"
      : successful.length === 1
        ? "single_rpc"
        : uniqueHashes.size === 1
          ? "agrees"
          : "disagrees";
  const approved = routerBytecodeHash
    ? approvedHashes.map((h) => h.toLowerCase()).includes(routerBytecodeHash.toLowerCase())
    : null;
  return {
    router,
    expectedRouter: PITEAS_ROUTER,
    routerMatchesAllowlist: sameAddress(router, PITEAS_ROUTER),
    bytecodePresent,
    routerBytecodeHash,
    approvedRouterCodeHashes: approvedHashes,
    routerCodeHashApproved: approved,
    rpcCodeHashes,
    codeHashAgreement,
    warnings: approved === true ? [] : ["Router code hash is not operator-approved for unattended execution."],
  };
}

async function fetchRpcCode(
  rpcUrl: string,
  address: string,
  timeoutMs: number,
): Promise<string> {
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
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (typeof body.result !== "string") throw new Error("eth_getCode result missing");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}
