import { USDC_FROM_ETH_ADDRESS } from "../../../constants.js";
import { PITEAS_ROUTER as PITEAS_ROUTER_ADDRESS } from "../../../data/index.js";

export { erc20ApproveAbi } from "../../chain/abis.js";
export const PITEAS_ROUTER = PITEAS_ROUTER_ADDRESS;

export const PHIAT_SHADOW_BUY_TOKEN_OUT =
  "0x96e035ae0905efac8f733f133462f971cfa45db1" as const;
export const PHIAT_SHADOW_BUY_TOKEN_IN = USDC_FROM_ETH_ADDRESS;
export const PHIAT_SHADOW_BUY_ALLOWED_ROUTERS = [PITEAS_ROUTER_ADDRESS] as const;

export const EUSDC_DECIMALS = 6;
export const PHIAT_DECIMALS = 18;
export const DEFAULT_REFERENCE_AMOUNT_HUMAN = "5";
export const DEFAULT_ANALYTICAL_THRESHOLD_PERCENT = 3;
export const DEFAULT_OPERATIONAL_THRESHOLD_PERCENT = 2.5;
export const DEFAULT_REFERENCE_DRIFT_PERCENT = 0.5;
export const DEFAULT_SLIPPAGE_PERCENT = 0.5;
export const DEFAULT_MAX_QUOTE_AGE_MS = 75_000;
export const DEFAULT_GAS_SAFETY_FACTOR = 1.25;
export const SHADOW_PITEAS_REQUEST_COUNT = 3;
export const MAX_UINT256 = (1n << 256n) - 1n;

export const shadowSwapAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const uniswapLikeRouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

export const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
