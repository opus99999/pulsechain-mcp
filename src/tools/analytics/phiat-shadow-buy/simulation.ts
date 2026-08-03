import type { AppConfig } from "../../../types.js";
import type { PhiatShadowBuyDeps, SimulationCall } from "./types.js";
import { errorMessage } from "./inputNormalization.js";

export async function simulateTransaction(args: {
  config: AppConfig;
  deps: Pick<PhiatShadowBuyDeps, "ethCall" | "estimateGas">;
  to: string;
  from: string;
  data: string;
  value: string;
}): Promise<SimulationCall> {
  const result: SimulationCall = {
    ethCallOk: false,
    ethCallError: null,
    ethCallReturnData: null,
    estimateGasOk: false,
    estimateGasError: null,
    gasEstimate: null,
  };
  try {
    const call = await args.deps.ethCall(args.config, {
      to: args.to,
      from: args.from,
      data: args.data,
      value: args.value,
    });
    result.ethCallOk = true;
    result.ethCallReturnData = call.data;
  } catch (err) {
    result.ethCallError = errorMessage(err);
  }
  try {
    const gas = await args.deps.estimateGas(args.config, {
      to: args.to,
      from: args.from,
      data: args.data,
      value: args.value,
    });
    result.estimateGasOk = true;
    result.gasEstimate = gas.gasEstimate;
  } catch (err) {
    result.estimateGasError = errorMessage(err);
  }
  return result;
}
