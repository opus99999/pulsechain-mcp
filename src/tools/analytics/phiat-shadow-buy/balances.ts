import { formatEther } from "viem";
import type { AppConfig } from "../../../types.js";
import { getPublicClient } from "../../../data/index.js";
import { assertAddress } from "../../../utils/safety.js";
import { erc20BalanceAbi, PHIAT_SHADOW_BUY_TOKEN_IN, EUSDC_DECIMALS } from "./constants.js";
import type { BalanceEvidence, PhiatShadowBuyDeps } from "./types.js";
import { errorMessage, formatRawToken, stringToBigInt } from "./inputNormalization.js";

export async function readBalances(args: {
  config: AppConfig;
  deps: Pick<PhiatShadowBuyDeps, "getInputBalance" | "getNativeBalanceWei">;
  walletAddress: string;
  amountInRaw: string;
}): Promise<Partial<BalanceEvidence>> {
  const errors: string[] = [];
  let inputBalanceRaw: string | null = null;
  let nativeBalanceWei: string | null = null;
  try {
    inputBalanceRaw = await args.deps.getInputBalance(args.config, args.walletAddress);
  } catch (err) {
    errors.push(`eUSDC balance unavailable: ${errorMessage(err)}`);
  }
  try {
    nativeBalanceWei = await args.deps.getNativeBalanceWei(args.config, args.walletAddress);
  } catch (err) {
    errors.push(`PLS balance unavailable: ${errorMessage(err)}`);
  }
  const inputBalance = stringToBigInt(inputBalanceRaw);
  const nativeBalance = stringToBigInt(nativeBalanceWei);
  const required = stringToBigInt(args.amountInRaw);
  if (nativeBalanceWei !== null && nativeBalance === null) {
    errors.push("PLS balance unavailable: malformed balance value");
  }
  return {
    inputBalanceRaw,
    inputBalanceHuman: formatRawToken(inputBalanceRaw, EUSDC_DECIMALS),
    nativeBalanceWei,
    nativeBalancePls: nativeBalance === null ? null : formatEther(nativeBalance),
    inputBalanceSufficient:
      inputBalance !== null && required !== null ? inputBalance >= required : null,
    errors,
  };
}

export async function readEusdcBalance(config: AppConfig, owner: string): Promise<string> {
  const balance = await getPublicClient(config).readContract({
    address: PHIAT_SHADOW_BUY_TOKEN_IN,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [assertAddress(owner)],
  });
  return (balance as bigint).toString();
}

export async function readNativeBalance(config: AppConfig, owner: string): Promise<string> {
  const balance = await getPublicClient(config).getBalance({
    address: assertAddress(owner),
  });
  return balance.toString();
}
