import { decodeFunctionData, formatUnits, type Hex } from "viem";
import {
  erc20ApproveAbi,
  EUSDC_DECIMALS,
  MAX_UINT256,
  PHIAT_DECIMALS,
  PITEAS_SWAP_CANONICAL_SIGNATURE,
  PITEAS_SWAP_SELECTOR,
  piteasRouterSwapAbi,
} from "./constants.js";
import type { DecodedIntent } from "./types.js";
import { fingerprint, selectorOf } from "./inputNormalization.js";

const PERMIT_SELECTORS = new Set([
  "0xd505accf", // ERC-2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  "0x8fcbaf0c", // Permit2 permit(address,PermitSingle,bytes)
]);

export function decodeShadowBuyCalldata(
  calldata: string,
  options: { nativeValueWei?: string | null } = {},
): DecodedIntent {
  const selector = selectorOf(calldata);
  const nativeValueWei = options.nativeValueWei ?? "0";
  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(calldata)) {
    return undecodable(selector, "calldata is not even-length hex", nativeValueWei, calldata);
  }
  const approval = tryDecodeApproval(calldata, selector, nativeValueWei);
  if (approval) return approval;
  if (selector !== PITEAS_SWAP_SELECTOR) {
    return undecodable(
      selector,
      "calldata selector is not the verified Piteas router swap selector",
      nativeValueWei,
      calldata,
    );
  }

  try {
    const decoded = decodeFunctionData({
      abi: piteasRouterSwapAbi,
      data: calldata as Hex,
    });
    const [detail, routeData] = decoded.args;
    const route = decodePiteasRouteData(routeData);
    const validationErrors = [...route.validationErrors];

    return {
      decodable: true,
      canonicalFunction: PITEAS_SWAP_CANONICAL_SIGNATURE,
      method: decoded.functionName,
      selector,
      tokenIn: detail.srcToken,
      tokenOut: detail.destToken,
      amountInRaw: detail.srcAmount.toString(),
      amountInHuman: formatUnits(detail.srcAmount, EUSDC_DECIMALS),
      minimumOutputRaw: detail.destMinAmount.toString(),
      minimumAmountOutRaw: detail.destMinAmount.toString(),
      minimumAmountOutHuman: formatUnits(detail.destMinAmount, PHIAT_DECIMALS),
      recipient: detail.destAccount,
      deadline: route.deadline,
      nativeValueWei,
      permitDataPresent: route.permitDataPresent,
      routeDataFingerprint: fingerprint(routeData),
      routeDataRaw: routeData,
      calldataFingerprint: fingerprint(calldata),
      routeData: {
        decodable: route.decodable,
        destinationToken: route.destinationToken,
        expectedOutputRaw: route.expectedOutputRaw,
        deadline: route.deadline,
        swapPayloadCount: route.swapPayloadCount,
        swapPayloadFingerprints: route.swapPayloadFingerprints,
        embeddedAddresses: route.embeddedAddresses,
        validationErrors: route.validationErrors,
      },
      executionTargets: [],
      unresolvedExecutionTargets: [],
      validationErrors,
      decodedExpectedOutputRaw: route.expectedOutputRaw,
      routeExpectedOutputRaw: route.expectedOutputRaw,
      nestedTargets: [],
      unresolvedTargets: [],
      errors: validationErrors,
    };
  } catch (err) {
    return undecodable(
      selector,
      err instanceof Error ? err.message : "Piteas router swap calldata failed ABI decode",
      nativeValueWei,
      calldata,
    );
  }
}

function tryDecodeApproval(
  calldata: string,
  selector: string | null,
  nativeValueWei: string | null,
): DecodedIntent | null {
  try {
    const decoded = decodeFunctionData({
      abi: erc20ApproveAbi,
      data: calldata as Hex,
    });
    const [spender, amount] = decoded.args;
    return {
      decodable: true,
      canonicalFunction: "approve(address,uint256)",
      method: decoded.functionName,
      selector,
      tokenIn: null,
      tokenOut: null,
      amountInRaw: null,
      amountInHuman: null,
      minimumOutputRaw: null,
      minimumAmountOutRaw: null,
      minimumAmountOutHuman: null,
      recipient: null,
      deadline: null,
      nativeValueWei,
      permitDataPresent: false,
      routeDataFingerprint: null,
      routeDataRaw: null,
      calldataFingerprint: fingerprint(calldata),
      routeData: null,
      executionTargets: [],
      unresolvedExecutionTargets: ["approval_payload"],
      validationErrors: ["calldata decodes as ERC-20 approval, not a swap"],
      spender,
      approvalAmountRaw: amount.toString(),
      unlimitedApproval: amount === MAX_UINT256,
      decodedExpectedOutputRaw: null,
      routeExpectedOutputRaw: null,
      nestedTargets: [],
      unresolvedTargets: ["approval_payload"],
      errors: ["calldata decodes as ERC-20 approval, not a swap"],
    };
  } catch {
    return null;
  }
}

function undecodable(
  selector: string | null,
  reason: string,
  nativeValueWei: string | null,
  calldata?: string,
): DecodedIntent {
  const unresolved = selector ? [`selector:${selector}`] : ["calldata"];
  return {
    decodable: false,
    canonicalFunction: null,
    method: null,
    selector,
    tokenIn: null,
    tokenOut: null,
    amountInRaw: null,
    amountInHuman: null,
    minimumOutputRaw: null,
    minimumAmountOutRaw: null,
    minimumAmountOutHuman: null,
    recipient: null,
    deadline: null,
    nativeValueWei,
    permitDataPresent: false,
    routeDataFingerprint: null,
    routeDataRaw: null,
    calldataFingerprint: calldata ? fingerprint(calldata) : null,
    routeData: null,
    executionTargets: [],
    unresolvedExecutionTargets: unresolved,
    validationErrors: [reason],
    decodedExpectedOutputRaw: null,
    routeExpectedOutputRaw: null,
    nestedTargets: [],
    unresolvedTargets: unresolved,
    errors: [reason],
  };
}

function decodePiteasRouteData(routeData: Hex): {
  decodable: boolean;
  destinationToken: string | null;
  expectedOutputRaw: string | null;
  deadline: string | null;
  swapPayloadCount: number;
  swapPayloadFingerprints: string[];
  embeddedAddresses: string[];
  permitDataPresent: boolean;
  validationErrors: string[];
} {
  const errors: string[] = [];
  const hex = routeData.slice(2);
  if (hex.length < 5 * 64 || hex.length % 64 !== 0) {
    return {
      decodable: false,
      destinationToken: null,
      expectedOutputRaw: null,
      deadline: null,
      swapPayloadCount: 0,
      swapPayloadFingerprints: [],
      embeddedAddresses: [],
      permitDataPresent: false,
      validationErrors: ["Piteas route data is not 32-byte aligned"],
    };
  }
  const destinationToken = addressFromWord(word(hex, 0));
  const expectedOutputRaw = bigintWord(hex, 1);
  const deadline = bigintWord(hex, 2);
  const offset = Number(BigInt(`0x${word(hex, 3)}`));
  if (offset % 32 !== 0 || offset < 128 || offset >= hex.length / 2) {
    errors.push("Piteas route payload offset is invalid");
  }
  const offsetWord = offset / 32;
  const swapPayloadCount = errors.length === 0 ? Number(BigInt(`0x${word(hex, offsetWord)}`)) : 0;
  const tableStart = offsetWord + 1;
  const tableEnd = tableStart + swapPayloadCount;
  if (swapPayloadCount < 0 || tableEnd > hex.length / 64) {
    errors.push("Piteas route swap payload table exceeds route data");
  }
  const dataStartBytes = tableEnd * 32;
  const routeBytes = hex.length / 2;
  const ends: number[] = [];
  if (errors.length === 0) {
    for (let i = 0; i < swapPayloadCount; i += 1) {
      const end = Number(BigInt(`0x${word(hex, tableStart + i)}`));
      if (end <= 0 || end % 32 !== 0) {
        errors.push(`Piteas route swap payload ${i} has an invalid boundary`);
      }
      if (i > 0 && end <= ends[i - 1]!) {
        errors.push(`Piteas route swap payload ${i} boundary is not ascending`);
      }
      ends.push(end);
    }
  }
  const payloads: string[] = [];
  if (errors.length === 0) {
    let start = 0;
    for (const end of ends) {
      const absoluteStart = dataStartBytes + start;
      const absoluteEnd = dataStartBytes + end;
      if (absoluteEnd > routeBytes || absoluteStart >= absoluteEnd) {
        errors.push("Piteas route swap payload boundary exceeds route data");
        break;
      }
      payloads.push(`0x${hex.slice(absoluteStart * 2, absoluteEnd * 2)}`);
      start = end;
    }
  }
  const embeddedAddresses = uniqueAddresses([
    destinationToken,
    ...payloads.flatMap(extractWordAlignedAddresses),
  ]);
  return {
    decodable: errors.length === 0,
    destinationToken,
    expectedOutputRaw,
    deadline,
    swapPayloadCount: errors.length === 0 ? swapPayloadCount : 0,
    swapPayloadFingerprints: payloads.map((payload) => fingerprint(payload)),
    embeddedAddresses,
    permitDataPresent: payloads.some((payload) => containsPermitSelector(payload)),
    validationErrors: errors,
  };
}

function word(hexWithoutPrefix: string, index: number): string {
  return hexWithoutPrefix.slice(index * 64, (index + 1) * 64).padStart(64, "0");
}

function bigintWord(hexWithoutPrefix: string, index: number): string {
  return BigInt(`0x${word(hexWithoutPrefix, index)}`).toString();
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
