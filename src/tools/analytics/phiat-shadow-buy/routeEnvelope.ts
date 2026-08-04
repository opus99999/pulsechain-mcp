import type { Hex } from "viem";
import { fingerprint } from "./inputNormalization.js";

export const CURRENT_PITEAS_SWAP_MANAGER_RUNTIME_CODE_HASH =
  "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb" as const;

export const PITEAS_ROUTE_DECODER_VERSION = "piteas-swap-manager-relative-starts-v1" as const;

const PERMIT_SELECTORS = new Set([
  "0xd505accf", // ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  "0x8fcbaf0c", // Permit2 permit(address,PermitSingle,bytes)
]);

interface RouteDecoderRegistryEntry {
  managerRuntimeCodeHash: string;
  decoderVersion: typeof PITEAS_ROUTE_DECODER_VERSION;
  supportedEnvelopeVersion: string;
  evidenceFingerprint: string;
}

export const PITEAS_ROUTE_DECODER_REGISTRY: RouteDecoderRegistryEntry[] = [
  {
    managerRuntimeCodeHash: CURRENT_PITEAS_SWAP_MANAGER_RUNTIME_CODE_HASH,
    decoderVersion: PITEAS_ROUTE_DECODER_VERSION,
    supportedEnvelopeVersion:
      "header(address,uint256,uint256,offset=0x80)+relative-payload-start-table",
    evidenceFingerprint: fingerprint({
      managerRuntimeCodeHash: CURRENT_PITEAS_SWAP_MANAGER_RUNTIME_CODE_HASH,
      decoderVersion: PITEAS_ROUTE_DECODER_VERSION,
      observedFixtureMethodParametersFingerprint:
        "0x7add3bb03757e6a3eedaced5390ad230820bd41cf3ae6c2c4da0a01956c10745",
      observedFixtureRouteBytes: 2112,
      observedFixturePayloadCount: 8,
      observedFixturePayloadStarts: [256, 480, 672, 896, 1088, 1312, 1536, 1760],
      source:
        "Current live Piteas route fixture plus active SwapManager runtime hash; BlockScout v2 metadata did not return verified manager source fields.",
    }),
  },
];

export type RouteEnvelopeDecodeStatus =
  | "PASSED"
  | "FAILED"
  | "UNSUPPORTED_VERSION"
  | "MALFORMED"
  | "PARTIAL";

export interface RouteEnvelopePayloadSegment {
  index: number;
  startByte: number;
  endByte: number;
  lengthBytes: number;
  fingerprint: string;
}

export interface RouteEnvelopeDecode {
  status: RouteEnvelopeDecodeStatus;
  destinationToken: string | null;
  expectedOutputRaw: string | null;
  deadline: string | null;
  swapPayloadCount: number;
  swapPayloadFingerprints: string[];
  embeddedAddresses: string[];
  permitDataPresent: boolean;
  validationErrors: string[];
  authoritativeFields: Record<string, unknown>;
  diagnosticFields: Record<string, unknown>;
  unresolvedFields: string[];
  consumedBytes: number;
  totalBytes: number;
  trailingBytes: number;
  decoderVersion: string;
  managerHashBinding: {
    status: "MATCHED" | "MISMATCH" | "NOT_EVALUATED";
    managerRuntimeCodeHash: string | null;
    requiredManagerRuntimeCodeHash: string;
    evidenceFingerprint: string;
  };
  supportedEnvelopeVersion: string | null;
  payloadSegments: RouteEnvelopePayloadSegment[];
}

export function decodePiteasRouteEnvelope(
  routeData: Hex | string | null,
  options: { managerRuntimeCodeHash?: string | null } = {},
): RouteEnvelopeDecode {
  const managerRuntimeCodeHash = options.managerRuntimeCodeHash?.toLowerCase() ?? null;
  const registryEntry = managerRuntimeCodeHash
    ? PITEAS_ROUTE_DECODER_REGISTRY.find(
        (entry) => entry.managerRuntimeCodeHash === managerRuntimeCodeHash,
      ) ?? null
    : PITEAS_ROUTE_DECODER_REGISTRY[0]!;
  const managerHashBinding = {
    status: managerRuntimeCodeHash
      ? registryEntry
        ? "MATCHED"
        : "MISMATCH"
      : "NOT_EVALUATED",
    managerRuntimeCodeHash,
    requiredManagerRuntimeCodeHash:
      registryEntry?.managerRuntimeCodeHash ?? PITEAS_ROUTE_DECODER_REGISTRY[0]!.managerRuntimeCodeHash,
    evidenceFingerprint:
      registryEntry?.evidenceFingerprint ?? PITEAS_ROUTE_DECODER_REGISTRY[0]!.evidenceFingerprint,
  } as const;

  if (typeof routeData !== "string" || !/^0x[0-9a-fA-F]*$/.test(routeData)) {
    return emptyDecode("MALFORMED", ["Piteas route data is not hex"], managerHashBinding);
  }
  const totalBytes = Math.max(0, (routeData.length - 2) / 2);
  if (managerRuntimeCodeHash && !registryEntry) {
    return emptyDecode(
      "UNSUPPORTED_VERSION",
      [`No Piteas route decoder is registered for SwapManager runtime hash ${managerRuntimeCodeHash}`],
      managerHashBinding,
      totalBytes,
    );
  }
  const hex = routeData.slice(2);
  if (totalBytes < 5 * 32 || totalBytes % 32 !== 0) {
    return emptyDecode(
      "MALFORMED",
      ["Piteas route data is not a 32-byte aligned manager envelope"],
      managerHashBinding,
      totalBytes,
    );
  }

  const errors: string[] = [];
  const destinationToken = addressFromWord(word(hex, 0));
  const expectedOutputRaw = bigintWord(hex, 1);
  const deadline = bigintWord(hex, 2);
  const payloadTableOffset = safeNumberWord(hex, 3);
  if (destinationToken === null) errors.push("Piteas route destination token word is invalid");
  if (payloadTableOffset === null || payloadTableOffset !== 128) {
    errors.push("Piteas route payload table offset is not supported");
  }
  const countWord = payloadTableOffset === null ? null : payloadTableOffset / 32;
  const swapPayloadCount = countWord === null ? 0 : safeNumberWord(hex, countWord) ?? 0;
  if (!Number.isInteger(swapPayloadCount) || swapPayloadCount < 0) {
    errors.push("Piteas route payload count is invalid");
  }
  const offsetTableStartBytes = (payloadTableOffset ?? 128) + 32;
  const offsetTableEndBytes = offsetTableStartBytes + swapPayloadCount * 32;
  if (offsetTableEndBytes > totalBytes) {
    errors.push("Piteas route payload start table exceeds route data");
  }

  const starts: number[] = [];
  if (errors.length === 0) {
    const offsetTableStartWord = offsetTableStartBytes / 32;
    for (let i = 0; i < swapPayloadCount; i += 1) {
      const start = safeNumberWord(hex, offsetTableStartWord + i);
      if (start === null || start % 32 !== 0) {
        errors.push(`Piteas route payload ${i} start is malformed`);
        continue;
      }
      if (start < swapPayloadCount * 32) {
        errors.push(`Piteas route payload ${i} overlaps the payload start table`);
      }
      if (i > 0 && start <= starts[i - 1]!) {
        errors.push(`Piteas route payload ${i} start is not ascending`);
      }
      if (offsetTableStartBytes + start >= totalBytes) {
        errors.push(`Piteas route payload ${i} starts outside route data`);
      }
      starts.push(start);
    }
  }

  const payloads: string[] = [];
  const payloadSegments: RouteEnvelopePayloadSegment[] = [];
  if (errors.length === 0) {
    for (let i = 0; i < starts.length; i += 1) {
      const absoluteStart = offsetTableStartBytes + starts[i]!;
      const absoluteEnd = i + 1 < starts.length ? offsetTableStartBytes + starts[i + 1]! : totalBytes;
      if (absoluteEnd > totalBytes || absoluteStart >= absoluteEnd || (absoluteEnd - absoluteStart) % 32 !== 0) {
        errors.push(`Piteas route payload ${i} has malformed byte boundaries`);
        break;
      }
      const payload = `0x${hex.slice(absoluteStart * 2, absoluteEnd * 2)}`;
      payloads.push(payload);
      payloadSegments.push({
        index: i,
        startByte: absoluteStart,
        endByte: absoluteEnd,
        lengthBytes: absoluteEnd - absoluteStart,
        fingerprint: fingerprint(payload),
      });
    }
  }

  const consumedBytes = errors.length === 0 ? totalBytes : Math.min(totalBytes, offsetTableEndBytes);
  const trailingBytes = errors.length === 0 ? 0 : Math.max(0, totalBytes - consumedBytes);
  const embeddedAddresses = uniqueAddresses([
    destinationToken,
    ...payloads.flatMap(extractWordAlignedAddresses),
  ]);
  const status: RouteEnvelopeDecodeStatus =
    errors.length === 0
      ? "PASSED"
      : errors.some((error) => error.includes("not supported"))
        ? "UNSUPPORTED_VERSION"
        : trailingBytes > 0
          ? "PARTIAL"
          : "MALFORMED";

  return {
    status,
    destinationToken,
    expectedOutputRaw,
    deadline,
    swapPayloadCount: errors.length === 0 ? swapPayloadCount : 0,
    swapPayloadFingerprints: payloadSegments.map((segment) => segment.fingerprint),
    embeddedAddresses,
    permitDataPresent: payloads.some((payload) => containsPermitSelector(payload)),
    validationErrors: errors,
    authoritativeFields:
      status === "PASSED"
        ? {
            destinationToken,
            expectedOutputRaw,
            deadline,
            payloadCount: swapPayloadCount,
            payloadFingerprints: payloadSegments.map((segment) => segment.fingerprint),
          }
        : {},
    diagnosticFields: {
      payloadTableOffset,
      payloadStartBaseBytes: offsetTableStartBytes,
      payloadStarts: starts,
      payloadSegments,
      embeddedAddresses,
    },
    unresolvedFields: status === "PASSED" ? [] : ["routePayloads"],
    consumedBytes,
    totalBytes,
    trailingBytes,
    decoderVersion: registryEntry?.decoderVersion ?? "unsupported-manager-hash",
    managerHashBinding,
    supportedEnvelopeVersion: registryEntry?.supportedEnvelopeVersion ?? null,
    payloadSegments,
  };
}

function emptyDecode(
  status: RouteEnvelopeDecodeStatus,
  validationErrors: string[],
  managerHashBinding: RouteEnvelopeDecode["managerHashBinding"],
  totalBytes = 0,
): RouteEnvelopeDecode {
  return {
    status,
    destinationToken: null,
    expectedOutputRaw: null,
    deadline: null,
    swapPayloadCount: 0,
    swapPayloadFingerprints: [],
    embeddedAddresses: [],
    permitDataPresent: false,
    validationErrors,
    authoritativeFields: {},
    diagnosticFields: {},
    unresolvedFields: ["routeData"],
    consumedBytes: 0,
    totalBytes,
    trailingBytes: totalBytes,
    decoderVersion:
      managerHashBinding.status === "MISMATCH"
        ? "unsupported-manager-hash"
        : PITEAS_ROUTE_DECODER_VERSION,
    managerHashBinding,
    supportedEnvelopeVersion:
      managerHashBinding.status === "MISMATCH"
        ? null
        : PITEAS_ROUTE_DECODER_REGISTRY[0]!.supportedEnvelopeVersion,
    payloadSegments: [],
  };
}

function word(hexWithoutPrefix: string, index: number): string {
  return hexWithoutPrefix.slice(index * 64, (index + 1) * 64).padStart(64, "0");
}

function bigintWord(hexWithoutPrefix: string, index: number): string {
  return BigInt(`0x${word(hexWithoutPrefix, index)}`).toString();
}

function safeNumberWord(hexWithoutPrefix: string, index: number): number | null {
  try {
    const value = BigInt(`0x${word(hexWithoutPrefix, index)}`);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  } catch {
    return null;
  }
}

function addressFromWord(w: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(w)) return null;
  if (!/^0{24}/.test(w)) return null;
  const address = `0x${w.slice(24)}`;
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address : null;
}

function extractWordAlignedAddresses(payload: string): string[] {
  const hex = payload.slice(2);
  const out: string[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const address = addressFromWord(hex.slice(i, i + 64));
    if (address && !/^0x0{40}$/i.test(address)) out.push(address);
  }
  return out;
}

function uniqueAddresses(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const lowered = value.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    out.push(value);
  }
  return out;
}

function containsPermitSelector(payload: string): boolean {
  const lower = payload.toLowerCase();
  return [...PERMIT_SELECTORS].some((selector) => lower.includes(selector.slice(2)));
}
