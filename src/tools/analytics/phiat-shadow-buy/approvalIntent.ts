import { encodeFunctionData, formatUnits } from "viem";
import { assertAddress } from "../../../utils/safety.js";
import { erc20ApproveAbi, EUSDC_DECIMALS, PHIAT_SHADOW_BUY_TOKEN_IN } from "./constants.js";
import type { ApprovalIntent } from "./types.js";

export function buildApprovalIntent(spender: string, amountRaw: string): ApprovalIntent {
  const amount = BigInt(amountRaw);
  return {
    status: "APPROVAL_REQUIRED",
    token: PHIAT_SHADOW_BUY_TOKEN_IN,
    spender,
    amountRaw,
    amountHuman: formatUnits(amount, EUSDC_DECIMALS),
    calldata: encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [assertAddress(spender), amount],
    }),
    valueWei: "0",
    unlimitedApproval: false,
    transactionPrepared: true,
    transactionSigned: false,
    transactionSubmitted: false,
    transactionBroadcast: false,
    transactionExecuted: false,
    simulation: null,
    error: null,
  };
}
