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
import { decodePiteasRouteEnvelope } from "./routeEnvelope.js";

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
    const route = decodePiteasRouteEnvelope(routeData);
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
        decodable: route.status === "PASSED",
        status: route.status,
        destinationToken: route.destinationToken,
        expectedOutputRaw: route.expectedOutputRaw,
        deadline: route.deadline,
        swapPayloadCount: route.swapPayloadCount,
        swapPayloadFingerprints: route.swapPayloadFingerprints,
        embeddedAddresses: route.embeddedAddresses,
        validationErrors: route.validationErrors,
        authoritativeFields: route.authoritativeFields,
        diagnosticFields: route.diagnosticFields,
        unresolvedFields: route.unresolvedFields,
        consumedBytes: route.consumedBytes,
        totalBytes: route.totalBytes,
        trailingBytes: route.trailingBytes,
        decoderVersion: route.decoderVersion,
        managerHashBinding: route.managerHashBinding,
        supportedEnvelopeVersion: route.supportedEnvelopeVersion,
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
