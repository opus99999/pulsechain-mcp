import { decodeFunctionData, formatUnits, type Hex } from "viem";
import { erc20ApproveAbi, EUSDC_DECIMALS, MAX_UINT256, PHIAT_DECIMALS, shadowSwapAbi, uniswapLikeRouterAbi } from "./constants.js";
import type { DecodedIntent } from "./types.js";

export function decodeShadowBuyCalldata(calldata: string): DecodedIntent {
  const selector = /^0x[a-fA-F0-9]{8}/.test(calldata) ? calldata.slice(0, 10) : null;
  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(calldata)) {
    return undecodable(selector, "calldata is not even-length hex");
  }
  const approval = tryDecodeApproval(calldata, selector);
  if (approval) return approval;
  try {
    const decoded = decodeFunctionData({
      abi: shadowSwapAbi,
      data: calldata as Hex,
    });
    const [tokenIn, tokenOut, amountIn, amountOutMin, recipient, deadline] =
      decoded.args;
    return {
      decodable: true,
      method: decoded.functionName,
      selector,
      tokenIn,
      tokenOut,
      amountInRaw: amountIn.toString(),
      amountInHuman: formatUnits(amountIn, EUSDC_DECIMALS),
      minimumAmountOutRaw: amountOutMin.toString(),
      minimumAmountOutHuman: formatUnits(amountOutMin, PHIAT_DECIMALS),
      recipient,
      deadline: deadline.toString(),
      decodedExpectedOutputRaw: null,
      nestedTargets: [],
      unresolvedTargets: [],
      errors: [],
    };
  } catch {
    // Fall through.
  }
  try {
    const decoded = decodeFunctionData({
      abi: uniswapLikeRouterAbi,
      data: calldata as Hex,
    });
    const [amountIn, amountOutMin, path, recipient, deadline] = decoded.args;
    return {
      decodable: true,
      method: decoded.functionName,
      selector,
      tokenIn: path[0] ?? null,
      tokenOut: path[path.length - 1] ?? null,
      amountInRaw: amountIn.toString(),
      amountInHuman: formatUnits(amountIn, EUSDC_DECIMALS),
      minimumAmountOutRaw: amountOutMin.toString(),
      minimumAmountOutHuman: formatUnits(amountOutMin, PHIAT_DECIMALS),
      recipient,
      deadline: deadline.toString(),
      decodedExpectedOutputRaw: null,
      nestedTargets: [],
      unresolvedTargets: [],
      errors: [],
    };
  } catch {
    return undecodable(
      selector,
      "unknown selector or unresolved arbitrary execution target",
    );
  }
}

function tryDecodeApproval(calldata: string, selector: string | null): DecodedIntent | null {
  try {
    const decoded = decodeFunctionData({
      abi: erc20ApproveAbi,
      data: calldata as Hex,
    });
    const [spender, amount] = decoded.args;
    return {
      decodable: true,
      method: decoded.functionName,
      selector,
      tokenIn: null,
      tokenOut: null,
      amountInRaw: null,
      amountInHuman: null,
      minimumAmountOutRaw: null,
      minimumAmountOutHuman: null,
      recipient: null,
      deadline: null,
      spender,
      approvalAmountRaw: amount.toString(),
      unlimitedApproval: amount === MAX_UINT256,
      decodedExpectedOutputRaw: null,
      nestedTargets: [],
      unresolvedTargets: [],
      errors: ["calldata decodes as ERC-20 approval, not a swap"],
    };
  } catch {
    return null;
  }
}

function undecodable(selector: string | null, reason: string): DecodedIntent {
  return {
    decodable: false,
    method: null,
    selector,
    tokenIn: null,
    tokenOut: null,
    amountInRaw: null,
    amountInHuman: null,
    minimumAmountOutRaw: null,
    minimumAmountOutHuman: null,
    recipient: null,
    deadline: null,
    decodedExpectedOutputRaw: null,
    nestedTargets: [],
    unresolvedTargets: selector ? [`selector:${selector}`] : ["calldata"],
    errors: [reason],
  };
}
