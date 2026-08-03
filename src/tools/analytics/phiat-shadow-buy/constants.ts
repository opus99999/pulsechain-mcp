import { USDC_FROM_ETH_ADDRESS } from "../../../constants.js";
import { PITEAS_ROUTER as PITEAS_ROUTER_ADDRESS } from "../../../data/index.js";

export { erc20ApproveAbi } from "../../chain/abis.js";
export const PITEAS_ROUTER = PITEAS_ROUTER_ADDRESS;
export const PITEAS_CONTRACTS_REPOSITORY =
  "https://github.com/piteasio/piteas-contracts" as const;
export const PITEAS_CONTRACTS_SOURCE_COMMIT =
  "a1dbdf373f2ad2617e8f78dabb250cb341d1c24b" as const;
export const PITEAS_ROUTER_SOURCE_HASH =
  "0xe42c5aea0b42f69c68ac93c070be643606d85c7ad8a78815d59b02001139ed48" as const;
export const PITEAS_PIT_ERC20_SOURCE_HASH =
  "0x75497d1cac771608aaa5fe9575a50a7452bdcfcfb982704d9cad98c51033e305" as const;
export const PITEAS_SWAP_MANAGER_INTERFACE_SOURCE_HASH =
  "0xdda8c3b86a6116f5832b9c21f73a4c10ee09fb167c937e65df86979be1ddd79b" as const;
export const PITEAS_ROUTER_COMPILER_VERSION = "v0.8.18+commit.87f61d96" as const;
export const PITEAS_ROUTER_OPTIMIZER_ENABLED = false;
export const PITEAS_ROUTER_OPTIMIZER_RUNS = null;
export const PITEAS_ROUTER_EVM_VERSION = "default" as const;
export const PITEAS_ROUTER_VERIFIED_ABI_FINGERPRINT =
  "0xef1647fc4243f8b82509fd173aea291de2787ea38303faab8769be1984ecc5e4" as const;
export const PITEAS_ROUTER_VERIFIED_SOURCE_FINGERPRINT =
  "0xbefbefcf4178fc63b1ed8a6e2277f5891f94421915d947cb3be9b92aa7796afa" as const;
export const PITEAS_SWAP_CANONICAL_SIGNATURE =
  "swap((address,address,address,uint256,uint256),bytes)" as const;
export const PITEAS_SWAP_SELECTOR = "0x8218b58f" as const;
export const PITEAS_SWAP_MANAGER_CANONICAL_SIGNATURE = "swap(bytes)" as const;
export const PITEAS_SWAP_MANAGER_SELECTOR = "0x627dd56a" as const;
export const PITEAS_CHANGED_SWAP_MANAGER_TOPIC =
  "0x9749619bcf6d1b4c60f22db410005b9501d48c42a749c4564585466fff64f34d" as const;
export const PITEAS_SWAP_MANAGER_STORAGE_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
export const PITEAS_SWAP_MANAGER_STORAGE_OFFSET_BYTES = 0;
export const PITEAS_SWAP_MANAGER_STORAGE_WIDTH_BYTES = 20;
export const PITEAS_OFFICIAL_DOCUMENTED_SWAP_MANAGER =
  "0xeFc4a83375Ae500D01C27dc01a31AD26C6EB25d8" as const;
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb" as const;
export const ERC20_TRANSFER_FROM_SELECTOR = "0x23b872dd" as const;
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as const;
export const ERC20_BALANCE_OF_SELECTOR = "0x70a08231" as const;
export const ERC20_ALLOWANCE_SELECTOR = "0xdd62ed3e" as const;

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
export const DEFAULT_MAX_QUOTE_AGE_MS = 30_000;
export const DEFAULT_MAX_BATCH_DURATION_MS = 90_000;
export const MAX_BATCH_DURATION_MS = 120_000;
export const MARKET_CONTEXT_TIMEOUT_MS = 20_000;
export const REFERENCE_BEFORE_TIMEOUT_MS = 30_000;
export const CANDIDATE_TIMEOUT_MS = 20_000;
export const REFERENCE_AFTER_TIMEOUT_MS = 20_000;
export const PITEAS_PER_REQUEST_TIMEOUT_MS = CANDIDATE_TIMEOUT_MS;
export const POST_CANDIDATE_VALIDATION_RESERVE_MS = 8_000;
export const REFERENCE_AFTER_RESERVE_MS = 20_000;
export const MINIMUM_VIABLE_PITEAS_REQUEST_TIMEOUT_MS = 8_000;
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
] as const;
