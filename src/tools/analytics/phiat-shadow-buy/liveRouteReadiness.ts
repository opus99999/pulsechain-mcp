import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppConfig } from "../../../types.js";
import { ok } from "../../../utils/result.js";
import { registerTool } from "../../define.js";
import { phiatShadowBuyInputSchema } from "./schema.js";
import { buildPhiatShadowBuy } from "./tool.js";
import type { PhiatShadowBuyCertificate, PhiatShadowBuyDeps, PhiatShadowBuyInput } from "./types.js";

export type PhiatLiveRouteReadinessStatus =
  | "READY_FOR_OPERATOR_CONFIGURATION"
  | "READY_FOR_FUNDED_SHADOW_TEST"
  | "BLOCKED_BY_ROUTE_DECODER"
  | "BLOCKED_BY_MINIMUM_OUTPUT"
  | "BLOCKED_BY_TRACE_INFRASTRUCTURE"
  | "BLOCKED_BY_GRAPH_TRUST"
  | "BLOCKED_BY_UPSTREAM_QUOTE"
  | "NOT_READY";

export interface PhiatLiveRouteReadiness {
  quoteAcquisition: Record<string, unknown>;
  calldataDecode: Record<string, unknown>;
  minimumOutputBinding: Record<string, unknown>;
  managerEnvelopeDecode: Record<string, unknown>;
  traceBackend: Record<string, unknown>;
  actualStateTrace: Record<string, unknown>;
  diagnosticOverrideTrace: Record<string, unknown>;
  graphComparison: Record<string, unknown>;
  operatorTrustConfiguration: Record<string, unknown>;
  revocationConfiguration: Record<string, unknown>;
  fundedWalletRequired: Record<string, unknown>;
  readinessStatus: PhiatLiveRouteReadinessStatus;
  shadowCertificate: PhiatShadowBuyCertificate;
}

export async function buildPhiatLiveRouteReadiness(
  config: AppConfig,
  input: PhiatShadowBuyInput,
  deps?: PhiatShadowBuyDeps,
): Promise<PhiatLiveRouteReadiness> {
  const certificate = await buildPhiatShadowBuy(config, input, deps);
  const operatorTrustConfigured =
    Boolean(config.phiatTrustOperatorKeyRegistry?.length) ||
    Boolean(config.phiatTrustOperatorPublicKeys && Object.keys(config.phiatTrustOperatorPublicKeys).length > 0);
  const revocationConfigured = config.phiatTrustRevocations !== undefined;
  const routeStatus = certificate.routeData.routeEnvelopeDecode.status;
  const minimumStatus = certificate.minimumOutputValidation?.validationStatus ?? "FAILED";
  const traceStatus = certificate.executionTraceStatus;
  const graphStatus = certificate.executionGraphStatus;
  const stateInsufficient = traceStatus === "STATE_INSUFFICIENT" ||
    statePrerequisitesInsufficient(certificate.executionLayer.statePrerequisites);
  const readinessStatus = readinessStatusFor({
    quoteBatchStatus: certificate.quoteBatchStatus,
    routeStatus,
    minimumStatus,
    traceStatus,
    graphStatus,
    operatorTrustConfigured,
    revocationConfigured,
    stateInsufficient,
  });

  return {
    quoteAcquisition: {
      status: certificate.quoteBatchStatus,
      actualQuoteCallCount: certificate.actualQuoteCallCount,
      candidateQuoteFingerprint: certificate.candidateQuote?.responseFingerprint ?? null,
      routeSignature: certificate.candidateQuote?.routeSignature ?? null,
      candidateExpiry: certificate.candidateQuote?.expiresAt ?? null,
    },
    calldataDecode: {
      status: certificate.decodedIntent?.decodable === true ? "PASSED" : "FAILED",
      selector: certificate.decodedIntent?.selector ?? null,
      calldataFingerprint: certificate.decodedIntent?.calldataFingerprint ?? null,
      validationErrors: certificate.decodedIntent?.validationErrors ?? [],
    },
    minimumOutputBinding: {
      status: minimumStatus,
      relationship: certificate.minimumOutputValidation?.relationship ?? "SEMANTICS_UNRESOLVED",
      authoritativeQuoteField: certificate.minimumOutputValidation?.authoritativeQuoteField ?? null,
      diagnosticComputedMinimumRelationship:
        certificate.minimumOutputValidation?.diagnosticComputedMinimumRelationship ?? null,
      evidenceFingerprint: certificate.minimumOutputValidation?.evidenceFingerprint ?? null,
    },
    managerEnvelopeDecode: {
      status: routeStatus,
      decoderVersion: certificate.routeData.routeEnvelopeDecode.decoderVersion,
      managerHashBinding: certificate.routeData.routeEnvelopeDecode.managerHashBinding,
      consumedBytes: certificate.routeData.routeEnvelopeDecode.consumedBytes,
      totalBytes: certificate.routeData.routeEnvelopeDecode.totalBytes,
      trailingBytes: certificate.routeData.routeEnvelopeDecode.trailingBytes,
      authoritativeFields: certificate.routeData.routeEnvelopeDecode.authoritativeFields,
      unresolvedFields: certificate.routeData.routeEnvelopeDecode.unresolvedFields,
    },
    traceBackend: {
      status:
        certificate.traceBackend.supported
          ? certificate.executionTraceStatus === "PASSED"
            ? "PASSED"
            : certificate.executionTraceStatus
          : "UNAVAILABLE",
      rpc: certificate.traceBackend.rpc,
      method: certificate.traceBackend.method,
      blockNumber: certificate.traceBackend.blockNumber,
      stateOverridesUsed: certificate.traceBackend.stateOverridesUsed,
      failureReason: certificate.traceBackend.failureReason,
    },
    actualStateTrace: {
      status: certificate.executionTraceStatus,
      stateOverridesUsed: false,
      statePrerequisites: certificate.executionLayer.statePrerequisites,
    },
    diagnosticOverrideTrace: certificate.executionLayer.diagnosticOverrideTrace as unknown as Record<string, unknown>,
    graphComparison: {
      status:
        certificate.executionLayer.trustManifestComparison?.status ??
        (graphStatus === "RESOLVED" ? "NOT_EVALUATED" : "EXECUTION_GRAPH_UNRESOLVED"),
      executionGraphStatus: graphStatus,
      matchedEdges: [],
      unexpectedEdges: certificate.executionLayer.trustManifestComparison?.unexpectedEdges ?? [],
      missingExpectedEdges: [],
      unexpectedTargets: certificate.executionLayer.trustManifestComparison?.unexpectedTargets ?? [],
      unexpectedSelectors: certificate.executionLayer.trustManifestComparison?.unexpectedSelectors ?? [],
      trustBundleCompatible:
        certificate.executionLayer.trustManifestComparison?.status === "PASSED",
      automaticExecutionQualifying: false,
    },
    operatorTrustConfiguration: {
      status: operatorTrustConfigured ? "CONFIGURED" : "UNCONFIGURED",
      keyRegistryEntries: config.phiatTrustOperatorKeyRegistry?.length ?? 0,
      pinnedPublicKeyIds: Object.keys(config.phiatTrustOperatorPublicKeys ?? {}),
      realOperatorKeyConfigured: false,
    },
    revocationConfiguration: {
      status: revocationConfigured ? "CONFIGURED" : "UNCONFIGURED",
      configured: revocationConfigured,
      realRevocationRegistryConfigured: revocationConfigured,
    },
    fundedWalletRequired: {
      required: stateInsufficient,
      statePrerequisites: certificate.executionLayer.statePrerequisites,
    },
    readinessStatus,
    shadowCertificate: certificate,
  };
}

function readinessStatusFor(args: {
  quoteBatchStatus: PhiatShadowBuyCertificate["quoteBatchStatus"];
  routeStatus: string;
  minimumStatus: string;
  traceStatus: PhiatShadowBuyCertificate["executionTraceStatus"];
  graphStatus: PhiatShadowBuyCertificate["executionGraphStatus"];
  operatorTrustConfigured: boolean;
  revocationConfigured: boolean;
  stateInsufficient: boolean;
}): PhiatLiveRouteReadinessStatus {
  if (args.quoteBatchStatus !== "COMPLETE") return "BLOCKED_BY_UPSTREAM_QUOTE";
  if (args.routeStatus !== "PASSED") return "BLOCKED_BY_ROUTE_DECODER";
  if (args.minimumStatus !== "PASSED") return "BLOCKED_BY_MINIMUM_OUTPUT";
  if (args.traceStatus === "UNSUPPORTED") return "BLOCKED_BY_TRACE_INFRASTRUCTURE";
  if (!args.operatorTrustConfigured || !args.revocationConfigured) return "READY_FOR_OPERATOR_CONFIGURATION";
  if (args.stateInsufficient) return "READY_FOR_FUNDED_SHADOW_TEST";
  if (args.graphStatus !== "RESOLVED") return "BLOCKED_BY_GRAPH_TRUST";
  return "READY_FOR_FUNDED_SHADOW_TEST";
}

function statePrerequisitesInsufficient(
  prerequisites: PhiatShadowBuyCertificate["executionLayer"]["statePrerequisites"],
): boolean {
  const balanceRequired = bigintOrNull(prerequisites.inputBalanceRequiredRaw);
  const balanceAvailable = bigintOrNull(prerequisites.inputBalanceAvailableRaw);
  const allowanceRequired = bigintOrNull(prerequisites.allowanceRequiredRaw);
  const allowanceAvailable = bigintOrNull(prerequisites.allowanceAvailableRaw);
  return (
    (balanceRequired !== null && balanceAvailable !== null && balanceAvailable < balanceRequired) ||
    (allowanceRequired !== null && allowanceAvailable !== null && allowanceAvailable < allowanceRequired)
  );
}

function bigintOrNull(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function registerPhiatLiveRouteReadinessTool(
  server: McpServer,
  config: AppConfig,
  deps?: PhiatShadowBuyDeps,
): void {
  registerTool(server, config, {
    name: "phiat_live_route_readiness",
    description:
      "Read-only PHIAT live Piteas route readiness report. Runs the shadow-buy certificate path, summarizes quote, calldata, route-envelope, trace, graph, trust, revocation, and funding readiness. Never signs, submits, broadcasts, executes, writes, or accesses wallet secrets.",
    category: "analytics",
    inputSchema: phiatShadowBuyInputSchema,
    write: false,
    handler: async (args, cfg) =>
      ok(await buildPhiatLiveRouteReadiness(cfg, args as unknown as PhiatShadowBuyInput, deps)),
  });
}

export const phiatLiveRouteReadinessInputSchema = z.object(phiatShadowBuyInputSchema);
