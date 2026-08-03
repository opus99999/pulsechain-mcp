import { formatEther } from "viem";
import type { AppConfig } from "../../../types.js";
import type { GasPolicy, PhiatShadowBuyDeps } from "./types.js";
import { parseHumanUnitsStrict, stringToBigInt } from "./inputNormalization.js";

export async function buildGasPolicy(args: {
  config: AppConfig;
  deps: Pick<PhiatShadowBuyDeps, "getFeeData">;
  gasEstimate: string | null;
  nativeBalanceWei: string | null;
  maximumGasPls: string | undefined;
  gasSafetyFactor: number;
}): Promise<Partial<GasPolicy>> {
  const gasUnits = stringToBigInt(args.gasEstimate);
  const nativeBalance = stringToBigInt(args.nativeBalanceWei);
  const gasSafetyFactorBps = Math.ceil(args.gasSafetyFactor * 10_000);
  const maximumGasWei =
    args.maximumGasPls !== undefined
      ? parseHumanUnitsStrict(args.maximumGasPls, 18)
      : null;
  if (gasUnits === null) {
    return {
      gasSafetyFactorBps: gasSafetyFactorBps.toString(),
      maximumGasWei: maximumGasWei?.toString() ?? null,
      withinMaximumGasPolicy: null,
      nativeBalanceCoversSafetyAdjustedGas: null,
    };
  }
  let gasPrice: bigint;
  try {
    const fees = await args.deps.getFeeData(args.config);
    gasPrice = BigInt(fees.gasPriceWei);
  } catch {
    return {
      gasSafetyFactorBps: gasSafetyFactorBps.toString(),
      gasUnits: gasUnits.toString(),
      maximumGasWei: maximumGasWei?.toString() ?? null,
      withinMaximumGasPolicy: null,
      nativeBalanceCoversSafetyAdjustedGas: null,
    };
  }
  const estimatedGasWei = gasUnits * gasPrice;
  const safetyAdjustedGasWei =
    (estimatedGasWei * BigInt(gasSafetyFactorBps) + 9_999n) / 10_000n;
  return {
    gasSafetyFactorBps: gasSafetyFactorBps.toString(),
    gasUnits: gasUnits.toString(),
    gasPriceWei: gasPrice.toString(),
    estimatedGasWei: estimatedGasWei.toString(),
    estimatedGasPls: formatEther(estimatedGasWei),
    safetyAdjustedGasWei: safetyAdjustedGasWei.toString(),
    safetyAdjustedGasPls: formatEther(safetyAdjustedGasWei),
    maximumGasWei: maximumGasWei?.toString() ?? null,
    withinMaximumGasPolicy:
      maximumGasWei === null ? null : safetyAdjustedGasWei <= maximumGasWei,
    nativeBalanceCoversSafetyAdjustedGas:
      nativeBalance === null ? null : nativeBalance >= safetyAdjustedGasWei,
  };
}
