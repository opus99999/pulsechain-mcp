/** Shared types for PulseChain MCP */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type ToolCategory =
  | "chain"
  | "analytics"
  | "wallet"
  | "health"
  | "system";

export type PulseNetwork = "mainnet" | "testnet";

export type PhiatTrustOperatorKeyStatus = "ACTIVE" | "REVOKED" | "DISABLED";

export interface PhiatTrustOperatorPublicKeyRegistryEntry {
  keyId: string;
  algorithm: "Ed25519";
  spkiDerBase64: string;
  status: PhiatTrustOperatorKeyStatus;
  validFrom?: string | null;
  validUntil?: string | null;
  allowedManifestVersions?: string[];
  allowedChainIds?: number[];
}

export interface PhiatTrustRevokedManifest {
  manifestFingerprint: string;
  revokedAt: string;
  reason: string;
}

export interface PhiatTrustRevokedKey {
  keyId: string;
  revokedAt: string;
  reason: string;
}

export interface PhiatTrustRevocationRegistry {
  manifests?: PhiatTrustRevokedManifest[];
  keys?: PhiatTrustRevokedKey[];
}

export interface AppConfig {
  /**
   * Ordered RPC endpoints (local → LAN → g4mm4 → public when user-configured).
   * At least one entry. Failover tries in this order.
   */
  rpcUrls: string[];
  /**
   * Primary RPC URL — always `rpcUrls[0]` for backward compatibility with
   * single-RPC callers and older health payloads.
   */
  rpcUrl: string;
  /** Active network: mainnet (369) or testnet (943) */
  network: PulseNetwork;
  explorerApi: string;
  pulseXSubgraphV1: string;
  pulseXSubgraphV2: string;
  agentWalletEnabled: boolean;
  agentWalletMasterKey: string | undefined;
  agentWalletDir: string;
  /**
   * When true, wallet write/sign paths refuse if AGENT_WALLET_DIR appears shared
   * with another live process (multiProcessRisk). Default false = warn only.
   */
  agentWalletMultiprocStrict: boolean;
  maxPlsPerTx: number;
  maxPlsDaily: number;
  /**
   * When set, start optional Streamable HTTP (dual-era createMcpHandler) on
   * this port for local testing only — `/mcp` + `/health`, not legacy SSE.
   */
  httpTransportPort: number | undefined;
  logLevel: LogLevel;
  httpTimeoutMs: number;
  /**
   * Optional non-secret directory for public eUSDC rotation market history.
   * When omitted, the rotation engine resolves a deterministic repository-local
   * path from its module location instead of the launching process cwd.
   */
  eusdcRotationHistoryDir?: string;
  /**
   * Public Ed25519 operator keys allowed to sign PHIAT execution trust manifests.
   * Values are base64-encoded SPKI public-key DER bytes. This must never contain
   * private keys or wallet secrets.
   */
  phiatTrustOperatorPublicKeys?: Record<string, string>;
  /**
   * Explicit public-key authorization registry for PHIAT execution trust
   * manifests. Public keys are not secrets; the registry still encodes
   * authorization state and must contain public SPKI material only.
   */
  phiatTrustOperatorKeyRegistry?: PhiatTrustOperatorPublicKeyRegistryEntry[];
  /**
   * Optional read-only operator revocation configuration. MCP tools only read
   * this state; they never create or write revocations.
   */
  phiatTrustRevocations?: PhiatTrustRevocationRegistry;
}

/**
 * Per-endpoint health vocabulary for tools/agents.
 * - healthy: recent success, not cooling down
 * - degraded: usable but elevated recent failures or high latency
 * - cool-down: temporary skip after failure (failover still can fall back later)
 * - unreachable: failed and never succeeded (or still cooling with no prior success)
 * - unknown: configured but not yet exercised by traffic or probes
 */
export type RpcHealthStatus =
  | "healthy"
  | "degraded"
  | "cool-down"
  | "unreachable"
  | "unknown";

/** Per-endpoint health snapshot for status tools/resources (no secrets). */
export interface RpcEndpointStatus {
  url: string;
  /** Structured status (preferred for agents) */
  status: RpcHealthStatus;
  /** Legacy boolean: true only when status === "healthy" */
  healthy: boolean;
  failures: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  cooldownUntil?: string;
  /** Last successful round-trip latency in ms (passive traffic or probe) */
  lastLatencyMs?: number;
  /** EWMA-ish average of recent success latencies (ms), when available */
  avgLatencyMs?: number;
  /** True if this URL is the currently selected active endpoint */
  isActive?: boolean;
}

export interface RpcStatusSnapshot {
  network: PulseNetwork;
  chainId: number;
  rpcUrls: string[];
  primaryRpcUrl: string;
  activeRpcUrl: string | null;
  endpoints: RpcEndpointStatus[];
  /** Counts by status for quick summary */
  summary: Record<RpcHealthStatus, number>;
  priorityNote: string;
  /** ISO timestamp when snapshot was taken */
  checkedAt: string;
}

/** JSON envelope returned by tools (serialized as text content). */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  warnings?: string[];
}

export interface AddressBalance {
  address: `0x${string}`;
  balanceWei: string;
  balancePls: string;
}

export interface TokenBalance {
  token: `0x${string}`;
  owner: `0x${string}`;
  balanceRaw: string;
  decimals: number;
  symbol?: string;
  name?: string;
  balanceFormatted?: string;
  /**
   * True when balanceOf succeeded. When false, `balanceRaw` is "0" as a safe
   * placeholder and is **not** a confirmed zero holding — see `balanceError`.
   */
  balanceOk?: boolean;
  /** Present when balanceOk is false (failed RPC/multicall read). */
  balanceError?: string;
}

export interface Erc20Metadata {
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
}

export type SubgraphVersion = "v1" | "v2";

export interface HealthStatus {
  server: string;
  version: string;
  chainId: number;
  network: PulseNetwork;
  rpcUrl: string;
  rpcUrls: string[];
  activeRpcUrl: string | null;
  explorerApi: string;
  pulseXSubgraphV1Configured: boolean;
  pulseXSubgraphV2Configured: boolean;
  agentWalletEnabled: boolean;
  httpTransportEnabled: boolean;
}
