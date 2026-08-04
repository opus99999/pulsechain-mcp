import { createHash } from "node:crypto";
import { decodeFunctionData, type Abi, type Hex } from "viem";
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
}

export type PiteasReviewIntent = Omit<PiteasTopLevelSwapIntent, "routeDataRaw">;

export type PiteasDecodeFailureKind =
  | "invalid_hex"
  | "wrong_selector"
  | "wrong_router"
  | "malformed_abi";

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
    return {
      ok: false,
      matchedSelector: selector === PITEAS_ROUTER_SWAP_SELECTOR,
      selector,
      kind: "invalid_hex",
      reason: "calldata is not even-length hex",
      calldataFingerprint,
    };
  }
  if (selector !== PITEAS_ROUTER_SWAP_SELECTOR) {
    return {
      ok: false,
      matchedSelector: false,
      selector,
      kind: "wrong_selector",
      reason: "calldata selector is not the verified PiteasRouter.swap selector",
      calldataFingerprint,
    };
  }

  const expectedRouter = (params.expectedRouter ?? VERIFIED_PITEAS_ROUTER).toLowerCase();
  const to = params.to?.toLowerCase();
  if (to && to !== expectedRouter) {
    return {
      ok: false,
      matchedSelector: true,
      selector,
      kind: "wrong_router",
      reason: "PiteasRouter.swap selector sent to a destination other than the verified Piteas router",
      calldataFingerprint,
    };
  }

  try {
    const decoded = decodeFunctionData({
      abi: piteasRouterSwapAbi,
      data: calldata as Hex,
    });
    const [detail, routeData] = decoded.args;
    const sourceToken = detail.srcToken.toLowerCase() as `0x${string}`;
    const destinationToken = detail.destToken.toLowerCase() as `0x${string}`;
    const destinationAccount = detail.destAccount.toLowerCase() as `0x${string}`;
    const sourceAmountRaw = detail.srcAmount.toString();
    const destinationMinimumAmountRaw = detail.destMinAmount.toString();
    const nativeValueWei = normalizeNativeValueWei(params.valueWei);
    const routeDataFingerprint = fingerprint(routeData);
    const routeDataByteLength = Math.max(0, (routeData.length - 2) / 2);

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
      },
    };
  } catch (err) {
    return {
      ok: false,
      matchedSelector: true,
      selector,
      kind: "malformed_abi",
      reason:
        err instanceof Error
          ? err.message
          : "PiteasRouter.swap calldata failed ABI decode",
      calldataFingerprint,
    };
  }
}

export function toPublicPiteasReviewIntent(
  intent: PiteasTopLevelSwapIntent,
): PiteasReviewIntent {
  const { routeDataRaw: _routeDataRaw, ...publicIntent } = intent;
  return publicIntent;
}
