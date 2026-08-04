import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, type Abi, type Hex } from "viem";
import { USDC_FROM_ETH_ADDRESS } from "../constants.js";
import { PITEAS_ROUTER } from "../data/piteas.js";

export const PITEAS_ROUTER_SWAP_CANONICAL_SIGNATURE =
  "swap((address,address,address,uint256,uint256),bytes)" as const;
export const PITEAS_ROUTER_SWAP_SELECTOR = "0x8218b58f" as const;
export const VERIFIED_PITEAS_ROUTER = PITEAS_ROUTER;
export const PHIAT_TOKEN_ADDRESS =
  "0x96e035ae0905efac8f733f133462f971cfa45db1" as const;
export const EUSDC_TOKEN_ADDRESS = USDC_FROM_ETH_ADDRESS;

export const piteasRouterSwapAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "detail",
        type: "tuple",
        components: [
          { name: "srcToken", type: "address" },
          { name: "destToken", type: "address" },
          { name: "destAccount", type: "address" },
          { name: "srcAmount", type: "uint256" },
          { name: "destMinAmount", type: "uint256" },
        ],
      },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "returnAmount", type: "uint256" }],
  },
] as const satisfies Abi;

export type PiteasRouteDataStatus = "OPAQUE_MANAGER_SPECIFIC";
export type PiteasTopLevelDecodeStatus =
  | "PASSED_CANONICAL"
  | "PASSED_CONTRACT_ACCEPTED_NONCANONICAL"
  | "MALFORMED"
  | "UNSUPPORTED"
  | "LIBRARY_DECODER_DISAGREEMENT";
export type PiteasViemCrossCheckStatus =
  | "passed"
  | "failed"
  | "not_run";
export type PiteasContractAcceptanceStatus =
  | "not_checked_by_decoder"
  | "accepted_in_fixture"
  | "rejected_in_fixture";

export interface PiteasDecodedTokenMovement {
  token: `0x${string}`;
  amountRaw: string;
  role: "swapExactIn";
  recipient: `0x${string}`;
  path: [`0x${string}`, `0x${string}`];
  minimumOutputRaw: string;
  outputToken: `0x${string}`;
}

export interface PiteasTopLevelSwapIntent {
  method: "PiteasRouter.swap";
  canonicalFunction: typeof PITEAS_ROUTER_SWAP_CANONICAL_SIGNATURE;
  selector: typeof PITEAS_ROUTER_SWAP_SELECTOR;
  routerAddress: `0x${string}`;
  sourceToken: `0x${string}`;
  sourceTokenLabel: string;
  destinationToken: `0x${string}`;
  destinationTokenLabel: string;
  destinationAccount: `0x${string}`;
  sourceAmountRaw: string;
  destinationMinimumAmountRaw: string;
  nativeValueWei: string;
  routeDataFingerprint: `0x${string}`;
  routeDataByteLength: number;
  routeDataStatus: PiteasRouteDataStatus;
  verifiedRecipient: `0x${string}`;
  tokenMovements: PiteasDecodedTokenMovement[];
  residualUncertainty: string[];
  warnings: string[];
  routeProtocols: string[];
  routeTargets: string[];
  routeDataRaw: Hex;
  calldataFingerprint: `0x${string}`;
  topLevelDecodeStatus: PiteasTopLevelDecodeStatus;
  consumedBytes: number;
  trailingBytes: number;
  viemCrossCheckStatus: PiteasViemCrossCheckStatus;
  contractAcceptanceStatus: PiteasContractAcceptanceStatus;
}

export type PiteasReviewIntent = Omit<PiteasTopLevelSwapIntent, "routeDataRaw">;

export type PiteasDecodeFailureKind =
  | "invalid_hex"
  | "wrong_selector"
  | "wrong_router"
  | "malformed_abi"
  | "empty_route_data"
  | "noncanonical_abi";

export type PiteasTopLevelSwapDecode =
  | {
      ok: true;
      matchedSelector: true;
      intent: PiteasTopLevelSwapIntent;
    }
  | {
      ok: false;
      matchedSelector: boolean;
      selector: string | null;
      kind: PiteasDecodeFailureKind;
      reason: string;
      calldataFingerprint: `0x${string}` | null;
      topLevelDecodeStatus: PiteasTopLevelDecodeStatus;
      viemCrossCheckStatus: PiteasViemCrossCheckStatus;
      contractAcceptanceStatus: PiteasContractAcceptanceStatus;
    };

export function sameAddress(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

export function labelPiteasTokenAddress(address: string): string {
  const lower = address.toLowerCase();
  if (lower === EUSDC_TOKEN_ADDRESS.toLowerCase()) {
    return `eUSDC (${EUSDC_TOKEN_ADDRESS})`;
  }
  if (lower === PHIAT_TOKEN_ADDRESS.toLowerCase()) {
    return `PHIAT (${PHIAT_TOKEN_ADDRESS})`;
  }
  return `unknown token (${address.toLowerCase()})`;
}

export function fingerprint(value: unknown): `0x${string}` {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function selectorOfCalldata(data: string | null | undefined): string | null {
  return typeof data === "string" && /^0x[a-fA-F0-9]{8}/.test(data)
    ? data.slice(0, 10).toLowerCase()
    : null;
}

export function normalizeNativeValueWei(valueWei?: bigint | string | null): string {
  if (valueWei === undefined || valueWei === null || valueWei === "") return "0";
  try {
    const parsed = typeof valueWei === "bigint" ? valueWei : BigInt(valueWei);
    return parsed < 0n ? "0" : parsed.toString();
  } catch {
    return "0";
  }
}

function calldataByteLength(data: string): number {
  return Math.max(0, (data.length - 2) / 2);
}

function bodyWord(calldata: string, index: number): string {
  const start = 10 + index * 64;
  return calldata.slice(start, start + 64);
}

function hasCanonicalAddressPadding(word: string): boolean {
  return /^0{24}[0-9a-fA-F]{40}$/.test(word);
}

function uintWord(word: string): bigint {
  return BigInt(`0x${word || "0"}`);
}

function paddedByteLength(length: bigint): bigint {
  return ((length + 31n) / 32n) * 32n;
}

function failure(params: {
  matchedSelector: boolean;
  selector: string | null;
  kind: PiteasDecodeFailureKind;
  reason: string;
  calldataFingerprint: `0x${string}` | null;
  topLevelDecodeStatus: PiteasTopLevelDecodeStatus;
  viemCrossCheckStatus?: PiteasViemCrossCheckStatus;
}): PiteasTopLevelSwapDecode {
  return {
    ok: false,
    matchedSelector: params.matchedSelector,
    selector: params.selector,
    kind: params.kind,
    reason: params.reason,
    calldataFingerprint: params.calldataFingerprint,
    topLevelDecodeStatus: params.topLevelDecodeStatus,
    viemCrossCheckStatus: params.viemCrossCheckStatus ?? "not_run",
    contractAcceptanceStatus: "not_checked_by_decoder",
  };
}

export function decodePiteasRouterSwapCalldata(params: {
  to?: string | null;
  data: string;
  valueWei?: bigint | string | null;
  expectedRouter?: string;
}): PiteasTopLevelSwapDecode {
  const calldata = params.data;
  const selector = selectorOfCalldata(calldata);
  const calldataFingerprint = fingerprint(calldata);
  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(calldata)) {
    return failure({
      matchedSelector: selector === PITEAS_ROUTER_SWAP_SELECTOR,
      selector,
      kind: "invalid_hex",
      reason: "calldata is not even-length hex",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
    });
  }
  if (selector !== PITEAS_ROUTER_SWAP_SELECTOR) {
    return failure({
      matchedSelector: false,
      selector,
      kind: "wrong_selector",
      reason: "calldata selector is not the verified PiteasRouter.swap selector",
      calldataFingerprint,
      topLevelDecodeStatus: "UNSUPPORTED",
    });
  }

  const expectedRouter = (params.expectedRouter ?? VERIFIED_PITEAS_ROUTER).toLowerCase();
  const to = params.to?.toLowerCase();
  if (to && to !== expectedRouter) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "wrong_router",
      reason: "PiteasRouter.swap selector sent to a destination other than the verified Piteas router",
      calldataFingerprint,
      topLevelDecodeStatus: "UNSUPPORTED",
    });
  }
  if (calldataByteLength(calldata) < 4 + 6 * 32) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap calldata is shorter than the required six-word head",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  for (const index of [0, 1, 2]) {
    if (!hasCanonicalAddressPadding(bodyWord(calldata, index))) {
      return failure({
        matchedSelector: true,
        selector,
        kind: "malformed_abi",
        reason: `PiteasRouter.swap address word ${index} has nonzero high-order padding`,
        calldataFingerprint,
        topLevelDecodeStatus: "MALFORMED",
        viemCrossCheckStatus: "failed",
      });
    }
  }
  const totalBytes = BigInt(calldataByteLength(calldata));
  const bodyBytes = totalBytes - 4n;
  const requiredHeadBytes = 6n * 32n;
  const dynamicOffset = uintWord(bodyWord(calldata, 5));
  if (dynamicOffset % 32n !== 0n) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap dynamic bytes offset is not 32-byte aligned",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  if (dynamicOffset < requiredHeadBytes) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap dynamic bytes offset points inside the required head",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  if (dynamicOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap dynamic bytes offset exceeds Number.MAX_SAFE_INTEGER",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  if (dynamicOffset + 32n > bodyBytes) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap dynamic bytes length word is outside calldata",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  const dynamicOffsetNumber = Number(dynamicOffset);
  const routeDataLength = uintWord(
    calldata.slice(10 + dynamicOffsetNumber * 2, 10 + dynamicOffsetNumber * 2 + 64),
  );
  if (routeDataLength === 0n) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "empty_route_data",
      reason: "PiteasRouter.swap route data must be non-empty",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
    });
  }
  const routeStart = dynamicOffset + 32n;
  const routeEnd = routeStart + routeDataLength;
  if (routeEnd > bodyBytes) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap declared route data length exceeds available calldata",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  const paddedRouteEnd = routeStart + paddedByteLength(routeDataLength);
  if (paddedRouteEnd > bodyBytes) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason: "PiteasRouter.swap padded route data end exceeds calldata",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
  if (paddedRouteEnd < bodyBytes) {
    const trailingStart = 10 + Number(paddedRouteEnd) * 2;
    const trailing = calldata.slice(trailingStart);
    if (!/^0*$/.test(trailing)) {
      return failure({
        matchedSelector: true,
        selector,
        kind: "noncanonical_abi",
        reason: "PiteasRouter.swap calldata has nonzero trailing bytes",
        calldataFingerprint,
        topLevelDecodeStatus: "LIBRARY_DECODER_DISAGREEMENT",
        viemCrossCheckStatus: "failed",
      });
    }
  }

  try {
    const decoded = decodeFunctionData({
      abi: piteasRouterSwapAbi,
      data: calldata as Hex,
    });
    const [detail, routeData] = decoded.args;
    const reencoded = encodeFunctionData({
      abi: piteasRouterSwapAbi,
      functionName: "swap",
      args: decoded.args,
    });
    if (reencoded.toLowerCase() !== calldata.toLowerCase()) {
      return failure({
        matchedSelector: true,
        selector,
        kind: "noncanonical_abi",
        reason:
          "PiteasRouter.swap calldata decoded with viem but differs from canonical re-encoding",
        calldataFingerprint,
        topLevelDecodeStatus: "LIBRARY_DECODER_DISAGREEMENT",
        viemCrossCheckStatus: "failed",
      });
    }
    const sourceToken = detail.srcToken.toLowerCase() as `0x${string}`;
    const destinationToken = detail.destToken.toLowerCase() as `0x${string}`;
    const destinationAccount = detail.destAccount.toLowerCase() as `0x${string}`;
    const sourceAmountRaw = detail.srcAmount.toString();
    const destinationMinimumAmountRaw = detail.destMinAmount.toString();
    const nativeValueWei = normalizeNativeValueWei(params.valueWei);
    const routeDataFingerprint = fingerprint(routeData);
    const routeDataByteLength = calldataByteLength(routeData);
    if (routeDataByteLength === 0) {
      return failure({
        matchedSelector: true,
        selector,
        kind: "empty_route_data",
        reason: "PiteasRouter.swap route data must be non-empty",
        calldataFingerprint,
        topLevelDecodeStatus: "MALFORMED",
        viemCrossCheckStatus: "passed",
      });
    }
    const consumedBytes = calldataByteLength(reencoded);

    return {
      ok: true,
      matchedSelector: true,
      intent: {
        method: "PiteasRouter.swap",
        canonicalFunction: PITEAS_ROUTER_SWAP_CANONICAL_SIGNATURE,
        selector: PITEAS_ROUTER_SWAP_SELECTOR,
        routerAddress: (params.expectedRouter ?? VERIFIED_PITEAS_ROUTER).toLowerCase() as `0x${string}`,
        sourceToken,
        sourceTokenLabel: labelPiteasTokenAddress(sourceToken),
        destinationToken,
        destinationTokenLabel: labelPiteasTokenAddress(destinationToken),
        destinationAccount,
        sourceAmountRaw,
        destinationMinimumAmountRaw,
        nativeValueWei,
        routeDataFingerprint,
        routeDataByteLength,
        routeDataStatus: "OPAQUE_MANAGER_SPECIFIC",
        verifiedRecipient: destinationAccount,
        tokenMovements: [
          {
            token: sourceToken,
            amountRaw: sourceAmountRaw,
            role: "swapExactIn",
            recipient: destinationAccount,
            path: [sourceToken, destinationToken],
            minimumOutputRaw: destinationMinimumAmountRaw,
            outputToken: destinationToken,
          },
        ],
        residualUncertainty: [
          "Route data is manager-specific and not fully decoded by the top-level router ABI",
          "Quote and calldata may become stale quickly",
          "Successful current simulation is mandatory before execution",
          "Piteas router/manager state may change",
          "No stale proposal may be reused",
        ],
        warnings: [
          "Route data is manager-specific",
          "Quote and calldata may become stale quickly",
          "Successful current simulation is mandatory",
          "Piteas router/manager state may change",
          "No stale proposal may be reused",
        ],
        routeProtocols: [],
        routeTargets: [],
        routeDataRaw: routeData,
        calldataFingerprint,
        topLevelDecodeStatus: "PASSED_CANONICAL",
        consumedBytes,
        trailingBytes: 0,
        viemCrossCheckStatus: "passed",
        contractAcceptanceStatus: "not_checked_by_decoder",
      },
    };
  } catch (err) {
    return failure({
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason:
        err instanceof Error
          ? err.message
          : "PiteasRouter.swap calldata failed ABI decode",
      calldataFingerprint,
      topLevelDecodeStatus: "MALFORMED",
      viemCrossCheckStatus: "failed",
    });
  }
}

export function toPublicPiteasReviewIntent(
  intent: PiteasTopLevelSwapIntent,
): PiteasReviewIntent {
  const { routeDataRaw: _routeDataRaw, ...publicIntent } = intent;
  return publicIntent;
}
