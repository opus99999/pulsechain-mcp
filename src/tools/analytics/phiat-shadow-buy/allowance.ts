import type { AppConfig } from "../../../types.js";
import { getPublicClient } from "../../../data/index.js";
import { assertAddress } from "../../../utils/safety.js";
import { erc20AllowanceAbi, PHIAT_SHADOW_BUY_TOKEN_IN, EUSDC_DECIMALS } from "./constants.js";
import type { AllowanceEvidence, PhiatShadowBuyDeps } from "./types.js";
import { errorMessage, formatRawToken, stringToBigInt } from "./inputNormalization.js";

export async function readAllowance(args: {
  config: AppConfig;
  deps: Pick<PhiatShadowBuyDeps, "getAllowance">;
  owner: string;
  spender: string;
  requiredAmountRaw: string;
}): Promise<Partial<AllowanceEvidence>> {
  try {
    const allowanceRaw = await args.deps.getAllowance(
      args.config,
      args.owner,
      args.spender,
    );
    const allowance = stringToBigInt(allowanceRaw);
    const required = stringToBigInt(args.requiredAmountRaw);
    return {
      spender: args.spender,
      allowanceRaw,
      allowanceHuman: formatRawToken(allowanceRaw, EUSDC_DECIMALS),
      requiredAmountRaw: args.requiredAmountRaw,
      sufficient:
        allowance !== null && required !== null ? allowance >= required : null,
      error: allowance === null || required === null ? "Malformed allowance value" : null,
    };
  } catch (err) {
    return {
      spender: args.spender,
      requiredAmountRaw: args.requiredAmountRaw,
      sufficient: null,
      error: errorMessage(err),
    };
  }
}

export async function readEusdcAllowance(
  config: AppConfig,
  owner: string,
  spender: string,
): Promise<string> {
  const allowance = await getPublicClient(config).readContract({
    address: PHIAT_SHADOW_BUY_TOKEN_IN,
    abi: erc20AllowanceAbi,
    functionName: "allowance",
    args: [assertAddress(owner), assertAddress(spender)],
  });
  return (allowance as bigint).toString();
}
