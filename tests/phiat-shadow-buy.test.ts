import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, toFunctionSelector } from "viem";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppConfig } from "../src/types.js";
import {
  PITEAS_ROUTER,
  getPiteasRateLimitBudget,
  markPiteasRateLimitSlotAttempted,
  markPiteasRateLimitSlotCompleted,
  preparePiteasSwap,
  releaseUnusedPiteasRateLimitSlots,
  reservePiteasRateLimitSlots,
  resetPiteasRateLimitForTests,
  type PiteasPrepareResult,
  type PiteasQuoteData,
} from "../src/data/index.js";
import {
  buildPhiatShadowBuy,
  decodeShadowBuyCalldata,
  PHIAT_SHADOW_BUY_TOKEN_IN,
  PHIAT_SHADOW_BUY_TOKEN_OUT,
  PITEAS_SWAP_CANONICAL_SIGNATURE,
  PITEAS_SWAP_SELECTOR,
  PITEAS_SWAP_MANAGER_SELECTOR,
  PITEAS_CHANGED_SWAP_MANAGER_TOPIC,
  PITEAS_OFFICIAL_DOCUMENTED_SWAP_MANAGER,
  PITEAS_SWAP_MANAGER_STORAGE_OFFSET_BYTES,
  PITEAS_SWAP_MANAGER_STORAGE_SLOT,
  PITEAS_SWAP_MANAGER_STORAGE_WIDTH_BYTES,
  PITEAS_SWAP_MANAGER_CANONICAL_SIGNATURE,
  certifyPiteasExecutionLayer,
  decodeAddressFromStorageWord,
  discoverActiveSwapManager,
  deriveSwapManagerStorageLayout,
  evaluateMinimumOutputValidation,
  readSwapManagerIntegrity,
  registerPhiatShadowBuyTool,
  piteasRouterSwapAbi,
  routerSourceEvidence,
  type PhiatShadowBuyDeps,
  type ExecutionLayerCertification,
} from "../src/tools/analytics/phiatShadowBuy.js";
import { emptyExecutionLayer } from "../src/tools/analytics/phiat-shadow-buy/certificate.js";
import { readRouterIntegrity } from "../src/tools/analytics/phiat-shadow-buy/routerIntegrity.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const BAD_ROUTER = "0x4444444444444444444444444444444444444444";
const MANAGER = "0x5555555555555555555555555555555555555555";
const PROTOCOL = "0x6666666666666666666666666666666666666666";
const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const REF_RAW = "5000000";
const AMOUNT_50_RAW = "50000000";
const REF_OUTPUT_RAW = "100000000000000000000";
const CANDIDATE_OUTPUT_RAW = "980000000000000000000";
const CANDIDATE_MIN_RAW = "970000000000000000000";
const TEST_DEADLINE_SECONDS = BigInt(Math.floor((NOW + 60_000) / 1000));
const APPROVED_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNAPPROVED_HASH =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MANAGER_HASH =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PROTOCOL_HASH =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const baseConfig: AppConfig = {
  rpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
  rpcUrl: "https://rpc-a.example",
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://graph.example/v1",
  pulseXSubgraphV2: "https://graph.example/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets-test",
  agentWalletMultiprocStrict: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "error",
  httpTimeoutMs: 30_000,
};

beforeEach(() => {
  resetPiteasRateLimitForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (defaultQuoteMock as unknown as { count?: number }).count = 0;
});

function swapCalldata(overrides: {
  tokenIn?: string;
  tokenOut?: string;
  amountInRaw?: string;
  minOutputRaw?: string;
  outputRaw?: string;
  recipient?: string;
  deadline?: bigint;
  routePayloads?: `0x${string}`[];
  routeDestinationToken?: string;
} = {}): `0x${string}` {
  const tokenOut = overrides.tokenOut ?? PHIAT_SHADOW_BUY_TOKEN_OUT;
  return encodeFunctionData({
    abi: piteasRouterSwapAbi,
    functionName: "swap",
    args: [
      {
        srcToken: (overrides.tokenIn ?? PHIAT_SHADOW_BUY_TOKEN_IN) as `0x${string}`,
        destToken: tokenOut as `0x${string}`,
        destAccount: (overrides.recipient ?? WALLET) as `0x${string}`,
        srcAmount: BigInt(overrides.amountInRaw ?? AMOUNT_50_RAW),
        destMinAmount: BigInt(overrides.minOutputRaw ?? CANDIDATE_MIN_RAW),
      },
      piteasRouteData({
        destinationToken: overrides.routeDestinationToken ?? tokenOut,
        expectedOutputRaw: overrides.outputRaw ?? CANDIDATE_OUTPUT_RAW,
        deadline: overrides.deadline ?? TEST_DEADLINE_SECONDS,
        payloads: overrides.routePayloads ?? [],
      }),
    ],
  });
}

function piteasRouteData(args: {
  destinationToken?: string;
  expectedOutputRaw?: string;
  deadline?: bigint;
  payloads?: `0x${string}`[];
} = {}): `0x${string}` {
  const payloads = args.payloads ?? [];
  const cumulativeEnds: bigint[] = [];
  let runningBytes = 0n;
  for (const payload of payloads) {
    const bytes = BigInt((payload.length - 2) / 2);
    runningBytes += bytes;
    cumulativeEnds.push(runningBytes);
  }
  const words = [
    addressWord(args.destinationToken ?? PHIAT_SHADOW_BUY_TOKEN_OUT),
    uintWord(BigInt(args.expectedOutputRaw ?? CANDIDATE_OUTPUT_RAW)),
    uintWord(args.deadline ?? TEST_DEADLINE_SECONDS),
    uintWord(128n),
    uintWord(BigInt(payloads.length)),
    ...cumulativeEnds.map(uintWord),
  ];
  return `0x${words.join("")}${payloads.map((payload) => payload.slice(2)).join("")}` as `0x${string}`;
}

function routePayloadWithAddresses(...addresses: string[]): `0x${string}` {
  return `0x${addresses.map(addressWord).join("")}` as `0x${string}`;
}

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(address: string): string {
  return `${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function quoteData(overrides: Partial<PiteasQuoteData> & {
  label?: string;
  amountInRaw?: string;
  outputRaw?: string;
  minRaw?: string;
  recipient?: string;
} = {}): PiteasQuoteData {
  const amountIn = overrides.amountInRaw ?? overrides.amountIn ?? AMOUNT_50_RAW;
  const output = overrides.outputRaw ?? overrides.amountOut ?? CANDIDATE_OUTPUT_RAW;
  const min = overrides.minRaw ?? overrides.amountOutMin ?? CANDIDATE_MIN_RAW;
  const label = overrides.label ?? "candidate";
  return {
    srcToken: { address: PHIAT_SHADOW_BUY_TOKEN_IN, symbol: "eUSDC", decimals: 6, chainId: 369 },
    destToken: { address: PHIAT_SHADOW_BUY_TOKEN_OUT, symbol: "PHIAT", decimals: 18, chainId: 369 },
    amountIn,
    amountOut: output,
    amountOutMin: min,
    valueWei: "0",
    valuePls: "0",
    gasUseEstimate: 250_000,
    gasUseEstimateUSD: null,
    priceImpactPercent: null,
    blockNumber: label === "reference_after" ? "124" : "123",
    quoteTimestamp: new Date(NOW).toISOString(),
    quoteIdentifier: `quote-${label}`,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    cacheHeaders: null,
    responseFingerprint: `fingerprint-${label}`,
    endpoint: "https://sdk.piteas.io/quote",
    retryCount: 0,
    methodParameters: {
      calldata: swapCalldata({
        amountInRaw: amountIn,
        minOutputRaw: min,
        outputRaw: output,
        recipient: overrides.recipient ?? WALLET,
        tokenOut: overrides.destToken?.address,
      }),
      value: "0",
    },
    router: PITEAS_ROUTER,
    route: {
      protocols: ["PulseX"],
      pools: [POOL],
      tokenPath: [PHIAT_SHADOW_BUY_TOKEN_IN, PHIAT_SHADOW_BUY_TOKEN_OUT],
      router: PITEAS_ROUTER,
      signature: "pulsex:eusdc-phiat",
    },
    tokenInParam: PHIAT_SHADOW_BUY_TOKEN_IN,
    tokenOutParam: PHIAT_SHADOW_BUY_TOKEN_OUT,
    allowedSlippage: 0.5,
    account: WALLET,
    chainId: 369,
    quoteReady: true,
    note: "mock quote",
    decodeNote: "mock decode",
    ...overrides,
  };
}

function defaultQuoteMock(overrides: {
  referenceBefore?: Partial<PiteasQuoteData>;
  candidate?: Partial<PiteasQuoteData>;
  referenceAfter?: Partial<PiteasQuoteData>;
} = {}) {
  return vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
    const call = (defaultQuoteMock as unknown as { count?: number }).count ?? 0;
    (defaultQuoteMock as unknown as { count: number }).count = call + 1;
    if (call === 0) {
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: "reference_before",
          amountInRaw: req.amount,
          outputRaw: REF_OUTPUT_RAW,
          minRaw: "99000000000000000000",
          ...overrides.referenceBefore,
        }),
      };
    }
    if (call === 1) {
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: "candidate",
          amountInRaw: req.amount,
          ...overrides.candidate,
        }),
      };
    }
    return {
      ok: true,
      source: "piteas",
      advisory: true,
      data: quoteData({
        label: "reference_after",
        amountInRaw: req.amount,
        outputRaw: REF_OUTPUT_RAW,
        minRaw: "99000000000000000000",
        ...overrides.referenceAfter,
      }),
    };
  }) as never;
}

function piteasFailure(reason: string, status?: number) {
  return {
    ok: false,
    reason,
    ...(status === undefined ? {} : { status }),
  };
}

function routerIntegrity(overrides: Partial<ReturnType<typeof baseRouterIntegrity>> = {}) {
  return vi.fn(async () => ({ ...baseRouterIntegrity(), ...overrides })) as never;
}

function baseRouterIntegrity() {
  return {
    router: PITEAS_ROUTER,
    expectedRouter: PITEAS_ROUTER,
    routerMatchesAllowlist: true,
    bytecodePresent: true,
    routerBytecodeHash: APPROVED_HASH,
    approvedRouterCodeHashes: [APPROVED_HASH],
    approvedRouterTrustRecords: [],
    routerCodeHashApproved: true,
    operatorApprovalRequired: false,
    trustRecordFingerprint: "0xrouter-trust",
    rpcCodeHashes: [
      {
        rpcUrl: "https://rpc-a.example",
        ok: true,
        codeHash: APPROVED_HASH,
        bytecode: "0x1234",
        bytecodeLength: 100,
        blockNumber: "123",
        proxyDetected: false,
        implementationAddress: null,
        implementationCodeHash: null,
        implementationBytecode: null,
        implementationBytecodeLength: null,
        error: null,
      },
      {
        rpcUrl: "https://rpc-b.example",
        ok: true,
        codeHash: APPROVED_HASH,
        bytecode: "0x1234",
        bytecodeLength: 100,
        blockNumber: "123",
        proxyDetected: false,
        implementationAddress: null,
        implementationCodeHash: null,
        implementationBytecode: null,
        implementationBytecodeLength: null,
        error: null,
      },
    ],
    codeHashAgreement: "agrees" as const,
    proxyDetection: {
      proxyDetected: false,
      proxyType: "none" as const,
      implementationAddress: null,
      implementationCodeHash: null,
      implementationBytecode: null,
      implementationBytecodeLength: null,
      rpcAgreement: "unavailable" as const,
      blockNumbers: ["123", "123"],
    },
    warnings: [],
  };
}

function executionTrustRecord(
  address: string,
  role: ExecutionLayerCertification["approvedTargets"][number]["role"],
  runtimeCodeHash: string,
  approvedSelectors: string[] = [],
) {
  return {
    chainId: 369,
    address,
    role,
    runtimeCodeHash,
    implementationAddress: null,
    implementationCodeHash: null,
    sourceFingerprint: null,
    approvedSelectors,
    approvalEvidence: "mock operator approval for regression fixture",
    approvedAtBlock: "123",
    expiresAtBlockOrTime: null,
    operatorApproved: true,
  };
}

function packedManagerStorage(address: string): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as `0x${string}`;
}

function resolvedExecutionLayer(
  overrides: Partial<ExecutionLayerCertification> = {},
): ExecutionLayerCertification {
  const managerRecord = executionTrustRecord(MANAGER, "SwapManager", MANAGER_HASH, [
    PITEAS_SWAP_MANAGER_SELECTOR,
  ]);
  const protocolRecord = executionTrustRecord(PROTOCOL, "ProtocolRouter", PROTOCOL_HASH, [
    "0xabcdef01",
  ]);
  const base: ExecutionLayerCertification = {
    ...emptyExecutionLayer(),
    sourceEvidence: routerSourceEvidence(),
    managerIntegrityStatus: "PASSED",
    executionTraceStatus: "PASSED",
    executionGraphStatus: "RESOLVED",
    activeSwapManager: {
      address: MANAGER,
      blockNumber: "124",
      storageSlot: PITEAS_SWAP_MANAGER_STORAGE_SLOT,
      storageOffsetBytes: PITEAS_SWAP_MANAGER_STORAGE_OFFSET_BYTES,
      storageWidthBytes: PITEAS_SWAP_MANAGER_STORAGE_WIDTH_BYTES,
      swapManagerStorageLayout: deriveSwapManagerStorageLayout(),
      storageEvidenceByRpc: [
        {
          rpcUrl: "https://rpc-a.example",
          ok: true,
          blockNumber: "124",
          storageWord: packedManagerStorage(MANAGER),
          decodedAddress: MANAGER,
          zeroAddress: false,
          decodeError: null,
          error: null,
        },
        {
          rpcUrl: "https://rpc-b.example",
          ok: true,
          blockNumber: "124",
          storageWord: packedManagerStorage(MANAGER),
          decodedAddress: MANAGER,
          zeroAddress: false,
          decodeError: null,
          error: null,
        },
      ],
      latestChangeEvent: {
        address: MANAGER,
        blockNumber: "100",
        transactionHash: `0x${"12".repeat(32)}`,
        logIndex: "0",
        topic: PITEAS_CHANGED_SWAP_MANAGER_TOPIC,
      },
      storageAgreement: "agrees",
      storageEventAgreement: "agrees",
      officialDocumentationMatch: false,
      documentationStatus: "STALE",
      confidence: "high",
    },
    swapManagerIntegrity: {
      address: MANAGER,
      codeHashesByRpc: [
        {
          rpcUrl: "https://rpc-a.example",
          ok: true,
          blockNumber: "124",
          bytecode: "0x60016000",
          runtimeCodeHash: MANAGER_HASH,
          bytecodeLength: 4,
          error: null,
        },
        {
          rpcUrl: "https://rpc-b.example",
          ok: true,
          blockNumber: "124",
          bytecode: "0x60016000",
          runtimeCodeHash: MANAGER_HASH,
          bytecodeLength: 4,
          error: null,
        },
      ],
      codeHashAgreement: "agrees",
      proxyType: "none",
      proxyDetection: {
        proxyType: "NONE_DETECTED",
        implementationAddress: null,
        beaconAddress: null,
        evidence: {},
      },
      executionOpcodeObservations: {
        containsDelegatecallOpcode: false,
        containsCallcodeOpcode: false,
        containsCreateOpcode: false,
        containsCreate2Opcode: false,
        containsSelfdestructOpcode: false,
      },
      implementationAddress: null,
      implementationCodeHashesByRpc: [],
      sourceVerificationStatus: "verified",
      abiFingerprint: `0x${"ab".repeat(32)}`,
      sourceFingerprint: `0x${"bc".repeat(32)}`,
      operatorApprovalRequired: false,
      trustRecordFingerprint: "0xmanager-trust",
      trusted: true,
    },
    routerManagerBinding: {
      quoteBeforeBlock: "123",
      candidateQuoteBlock: "123",
      quoteAfterBlock: "124",
      certificationBlock: "124",
      simulationBlock: "124",
      managerChangedSinceQuote: false,
      routerCodeChangedSinceQuote: false,
      managerCodeChangedSinceQuote: false,
    },
    routeData: {
      rawFingerprint: `0x${"34".repeat(32)}`,
      length: 160,
      managerCodeHash: MANAGER_HASH,
      decoderVersion: "opaque-manager-bound-v1",
      decoderMatchesManagerHash: false,
      authoritativeFields: [],
      heuristicObservations: [],
    },
    traceBackend: {
      rpc: "https://rpc-a.example",
      method: "debug_traceCall",
      blockNumber: "124",
      stateOverridesUsed: false,
      supported: true,
      failureReason: null,
    },
    routerCallSequence: [
      {
        callType: "CALL",
        from: PITEAS_ROUTER,
        to: PHIAT_SHADOW_BUY_TOKEN_IN,
        selector: "0x23b872dd",
        value: "0",
        success: true,
        gasUsed: "10000",
        codeHash: APPROVED_HASH,
        classification: "source_token_transfer_from_wallet_to_swap_manager",
      },
      {
        callType: "CALL",
        from: PITEAS_ROUTER,
        to: MANAGER,
        selector: PITEAS_SWAP_MANAGER_SELECTOR,
        value: "0",
        success: true,
        gasUsed: "20000",
        codeHash: MANAGER_HASH,
        classification: "router_call_to_active_swap_manager",
      },
      {
        callType: "STATICCALL",
        from: PITEAS_ROUTER,
        to: PHIAT_SHADOW_BUY_TOKEN_OUT,
        selector: "0x70a08231",
        value: "0",
        success: true,
        gasUsed: "5000",
        codeHash: APPROVED_HASH,
        classification: "destination_token_balance_check",
      },
      {
        callType: "CALL",
        from: PITEAS_ROUTER,
        to: PHIAT_SHADOW_BUY_TOKEN_OUT,
        selector: "0xa9059cbb",
        value: "0",
        success: true,
        gasUsed: "7000",
        codeHash: APPROVED_HASH,
        classification: "destination_token_transfer_to_recipient",
      },
    ],
    executionGraph: [
      {
        depth: 2,
        callType: "CALL",
        from: MANAGER,
        to: PROTOCOL,
        selector: "0xabcdef01",
        value: "0",
        inputFingerprint: `0x${"56".repeat(32)}`,
        outputFingerprint: `0x${"78".repeat(32)}`,
        success: true,
        revertReason: null,
        codeHash: PROTOCOL_HASH,
        protocolClassification: "protocol_router",
        trustStatus: "trusted",
      },
    ],
    approvedTargets: [managerRecord, protocolRecord],
    unresolvedTargets: [],
    prohibitedOperations: [],
    internalApprovals: [],
    managerChangedSinceQuote: false,
    trustRecordFingerprint: "0xexecution-trust",
    automaticExecutionEligible: true,
    failureCodes: [],
    validationErrors: [],
    warnings: [],
  };
  return { ...base, ...overrides };
}

function executionLayer(overrides: Partial<ExecutionLayerCertification> = {}) {
  return vi.fn(async () => resolvedExecutionLayer(overrides)) as never;
}

const EMPTY_STORAGE_WORD = `0x${"0".repeat(64)}` as const;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const BEACON_IMPLEMENTATION_SELECTOR = "0x5c60da1b";
const DIRECT_MANAGER_CODE = "0x60016000" as const;
const DIRECT_PROTOCOL_CODE = "0x60026000" as const;
const DIRECT_ROUTER_CODE = "0x60036000" as const;
const DIRECT_TOKEN_IN_CODE = "0x60046000" as const;
const DIRECT_TOKEN_OUT_CODE = "0x60056000" as const;
const DIRECT_BEACON_CODE = "0x60066000" as const;

interface RpcFailure {
  __rpcFailure: string;
}

interface ExecutionRpcMockOptions {
  manager?: string;
  eventManager?: string | null;
  managerAtQuote?: string;
  managerCode?: `0x${string}`;
  managerCodeByRpc?: Record<string, `0x${string}`>;
  routerCode?: `0x${string}`;
  routerCodeAtQuote?: `0x${string}`;
  managerCodeAtQuote?: `0x${string}`;
  implementationAddress?: string | null;
  implementationCode?: `0x${string}`;
  beaconAddress?: string | null;
  protocolCode?: `0x${string}`;
  extraCodeByAddress?: Record<string, `0x${string}`>;
  traceRoot?: Record<string, unknown>;
  debugTraceError?: string | null;
  traceCallError?: string | null;
  explorerVerified?: boolean;
}

function rpcFailure(message: string): RpcFailure {
  return { __rpcFailure: message };
}

function isRpcFailure(value: unknown): value is RpcFailure {
  return Boolean(value && typeof value === "object" && "__rpcFailure" in value);
}

function storageAddress(address: string): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as `0x${string}`;
}

function eventTopicAddress(address: string): `0x${string}` {
  return storageAddress(address);
}

function erc20TransferFromData(from: string, to: string, amount: string): `0x${string}` {
  return `0x23b872dd${addressWord(from)}${addressWord(to)}${uintWord(BigInt(amount))}` as `0x${string}`;
}

function erc20TransferData(to: string, amount: string): `0x${string}` {
  return `0xa9059cbb${addressWord(to)}${uintWord(BigInt(amount))}` as `0x${string}`;
}

function erc20BalanceOfData(owner: string): `0x${string}` {
  return `0x70a08231${addressWord(owner)}` as `0x${string}`;
}

function erc20ApproveData(spender: string, amount: string): `0x${string}` {
  return `0x095ea7b3${addressWord(spender)}${uintWord(BigInt(amount))}` as `0x${string}`;
}

function successfulTrace(overrides: { managerInput?: `0x${string}`; managerCalls?: Record<string, unknown>[] } = {}) {
  return {
    type: "CALL",
    from: WALLET,
    to: PITEAS_ROUTER,
    input: swapCalldata(),
    value: "0x0",
    gasUsed: "0x10000",
    calls: [
      {
        type: "CALL",
        from: PITEAS_ROUTER,
        to: PHIAT_SHADOW_BUY_TOKEN_IN,
        input: erc20TransferFromData(WALLET, MANAGER, AMOUNT_50_RAW),
        value: "0x0",
        gasUsed: "0x5208",
      },
      {
        type: "CALL",
        from: PITEAS_ROUTER,
        to: MANAGER,
        input: overrides.managerInput ?? `${PITEAS_SWAP_MANAGER_SELECTOR}${"0".repeat(64)}`,
        value: "0x0",
        gasUsed: "0x9000",
        calls: overrides.managerCalls ?? [
          {
            type: "CALL",
            from: MANAGER,
            to: PROTOCOL,
            input: `0xabcdef01${"0".repeat(64)}`,
            output: "0x",
            value: "0x0",
            gasUsed: "0x1234",
          },
        ],
      },
      {
        type: "STATICCALL",
        from: PITEAS_ROUTER,
        to: PHIAT_SHADOW_BUY_TOKEN_OUT,
        input: erc20BalanceOfData(PITEAS_ROUTER),
        output: "0x",
        value: "0x0",
        gasUsed: "0x1000",
      },
      {
        type: "CALL",
        from: PITEAS_ROUTER,
        to: PHIAT_SHADOW_BUY_TOKEN_OUT,
        input: erc20TransferData(WALLET, CANDIDATE_MIN_RAW),
        output: "0x",
        value: "0x0",
        gasUsed: "0x2000",
      },
    ],
  };
}

function executionCertArgs(overrides: Partial<Parameters<typeof certifyPiteasExecutionLayer>[1]> = {}) {
  const managerHash = keccak256(DIRECT_MANAGER_CODE);
  const protocolHash = keccak256(DIRECT_PROTOCOL_CODE);
  return {
    walletAddress: WALLET,
    router: PITEAS_ROUTER,
    tokenIn: PHIAT_SHADOW_BUY_TOKEN_IN,
    tokenOut: PHIAT_SHADOW_BUY_TOKEN_OUT,
    recipient: WALLET,
    amountInRaw: AMOUNT_50_RAW,
    calldata: swapCalldata(),
    valueWei: "0",
    routeDataRaw: piteasRouteData({ payloads: [routePayloadWithAddresses(POOL)] }),
    referenceBeforeBlock: "123",
    candidateQuoteBlock: "123",
    referenceAfterBlock: "123",
    approvedTrustRecords: [
      executionTrustRecord(MANAGER, "SwapManager", managerHash, [PITEAS_SWAP_MANAGER_SELECTOR]),
      executionTrustRecord(PROTOCOL, "ProtocolRouter", protocolHash, ["0xabcdef01"]),
    ],
    ...overrides,
  };
}

function stubExecutionRpc(options: ExecutionRpcMockOptions = {}) {
  const manager = options.manager ?? MANAGER;
  const eventManager = options.eventManager === undefined ? manager : options.eventManager;
  const managerAtQuote = options.managerAtQuote ?? manager;
  const managerCode = options.managerCode ?? DIRECT_MANAGER_CODE;
  const routerCode = options.routerCode ?? DIRECT_ROUTER_CODE;
  const protocolCode = options.protocolCode ?? DIRECT_PROTOCOL_CODE;
  const implementationAddress = options.implementationAddress ?? null;
  const implementationCode = options.implementationCode ?? "0x60076000";
  const beaconAddress = options.beaconAddress ?? null;
  const explorerVerified = options.explorerVerified ?? true;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    if (init?.method !== "POST") {
      const result = urlText.includes("getabi")
        ? "[{\"type\":\"function\",\"name\":\"swap\",\"inputs\":[{\"type\":\"bytes\"}]}]"
        : [{ SourceCode: "contract MockSwapManager {}", ABI: "[]" }];
      return new Response(
        JSON.stringify({ status: explorerVerified ? "1" : "0", message: "OK", result }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const body = JSON.parse(String(init.body ?? "{}")) as {
      id?: number;
      method: string;
      params?: unknown[];
    };
    const result = rpcResultFor(urlText, body.method, body.params ?? []);
    if (isRpcFailure(result)) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, error: { message: result.__rpcFailure } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  function rpcResultFor(rpcUrl: string, method: string, params: unknown[]): unknown {
    if (method === "eth_blockNumber") return "0x7c";
    if (method === "eth_getLogs") {
      if (eventManager === null) return [];
      return [
        {
          address: PITEAS_ROUTER,
          topics: [PITEAS_CHANGED_SWAP_MANAGER_TOPIC, eventTopicAddress(eventManager)],
          blockNumber: "0x64",
          transactionHash: `0x${"98".repeat(32)}`,
          logIndex: "0x0",
        },
      ];
    }
    if (method === "eth_getStorageAt") {
      const [address, slot, block] = params.map(String);
      if (addressMatches(address, PITEAS_ROUTER) && slot.toLowerCase() === PITEAS_SWAP_MANAGER_STORAGE_SLOT) {
        return packedManagerStorage(block === "0x7b" ? managerAtQuote : manager);
      }
      if (slot.toLowerCase() === EIP1967_IMPLEMENTATION_SLOT) {
        return implementationAddress && !beaconAddress ? storageAddress(implementationAddress) : EMPTY_STORAGE_WORD;
      }
      if (slot.toLowerCase() === EIP1967_BEACON_SLOT) {
        return beaconAddress ? storageAddress(beaconAddress) : EMPTY_STORAGE_WORD;
      }
      return EMPTY_STORAGE_WORD;
    }
    if (method === "eth_call") {
      const call = params[0] as { to?: string; data?: string };
      if (beaconAddress && addressMatches(call.to, beaconAddress) && call.data === BEACON_IMPLEMENTATION_SELECTOR) {
        return implementationAddress ? storageAddress(implementationAddress) : EMPTY_STORAGE_WORD;
      }
      return "0x";
    }
    if (method === "eth_getCode") {
      const [address, block] = params.map(String);
      const extra = options.extraCodeByAddress?.[address.toLowerCase()];
      if (extra) return extra;
      if (addressMatches(address, manager)) {
        if (block === "0x7b" && options.managerCodeAtQuote) return options.managerCodeAtQuote;
        return options.managerCodeByRpc?.[rpcUrl] ?? managerCode;
      }
      if (addressMatches(address, PITEAS_ROUTER)) {
        if (block === "0x7b" && options.routerCodeAtQuote) return options.routerCodeAtQuote;
        return routerCode;
      }
      if (implementationAddress && addressMatches(address, implementationAddress)) return implementationCode;
      if (beaconAddress && addressMatches(address, beaconAddress)) return DIRECT_BEACON_CODE;
      if (addressMatches(address, PROTOCOL)) return protocolCode;
      if (addressMatches(address, PHIAT_SHADOW_BUY_TOKEN_IN)) return DIRECT_TOKEN_IN_CODE;
      if (addressMatches(address, PHIAT_SHADOW_BUY_TOKEN_OUT)) return DIRECT_TOKEN_OUT_CODE;
      return "0x";
    }
    if (method === "debug_traceCall") {
      return options.debugTraceError
        ? rpcFailure(options.debugTraceError)
        : (options.traceRoot ?? successfulTrace());
    }
    if (method === "trace_call") {
      return options.traceCallError ? rpcFailure(options.traceCallError) : [];
    }
    return rpcFailure(`Unexpected RPC method ${method}`);
  }

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function addressMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function deps(overrides: Partial<PhiatShadowBuyDeps> = {}): PhiatShadowBuyDeps {
  (defaultQuoteMock as unknown as { count: number }).count = 0;
  return {
    buildPhiatDashboard: vi.fn(async () => ({
      token: { address: PHIAT_SHADOW_BUY_TOKEN_OUT },
      market: { priceUsd: { value: "0.0001", source: "mock" } },
      liquidity: { totalLiquidityUsd: 5000 },
      dataQuality: { partialFailures: [] },
    })) as never,
    getPiteasQuote: defaultQuoteMock(),
    preparePiteasSwap: vi.fn((quote: PiteasQuoteData, options?: { account?: string }) =>
      preparePiteasSwap(quote, options),
    ) as never,
    ethCall: vi.fn(async () => ({ data: "0x" })) as never,
    estimateGas: vi.fn(async () => ({ gasEstimate: "250000" })) as never,
    getFeeData: vi.fn(async () => ({
      gasPriceWei: "1000000000",
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    })) as never,
    reservePiteasRateLimitSlots: vi.fn(() => ({
      ok: true,
      reserved: 3,
      limit: 8,
      windowMs: 60_000,
      used: 3,
      remaining: 5,
      resetAt: new Date(NOW + 60_000).toISOString(),
      resetInMs: 60_000,
    })) as never,
    markPiteasRateLimitSlotAttempted,
    markPiteasRateLimitSlotCompleted,
    releaseUnusedPiteasRateLimitSlots,
    getAllowance: vi.fn(async () => AMOUNT_50_RAW),
    getInputBalance: vi.fn(async () => AMOUNT_50_RAW),
    getNativeBalanceWei: vi.fn(async () => "1000000000000000000"),
    getRouterIntegrity: routerIntegrity(),
    certifyExecutionLayer: executionLayer(),
    nowMs: () => NOW,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    walletAddress: WALLET,
    amountInHuman: "50",
    maximumGasPls: "1",
    approvedRouterCodeHashes: [APPROVED_HASH],
    ...overrides,
  };
}

function reasonCodes(result: { reasons: Array<{ code: string }> }): string[] {
  return result.reasons.map((reason) => reason.code);
}

describe("phiat_shadow_buy exact-amount shadow certificate", () => {
  it("evaluates a requested 50 eUSDC purchase directly even if fixed dashboard depth would fail", async () => {
    const d = deps({
      buildPhiatDashboard: vi.fn(async () => ({
        token: { address: PHIAT_SHADOW_BUY_TOKEN_OUT },
        piteasDepth: {
          operationalRecommendationStatus: "unavailable",
          operationalRecommendedMaximumTrancheHuman: null,
        },
      })) as never,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.exactAmountEvidence.amountInHuman).toBe("50");
    expect(result.marketContext.includePiteasDepth).toBe(false);
  });

  it("makes exactly three Piteas quote calls and uses account only on the candidate quote", async () => {
    const d = deps();
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
    expect(result.actualQuoteCallCount).toBe(3);
    expect(result.exactAmountEvidence.piteasRequestCountAttempted).toBe(3);
    const calls = vi.mocked(d.getPiteasQuote).mock.calls;
    expect(calls[0]![1]).toMatchObject({ amount: REF_RAW });
    expect(calls[0]![1]).not.toHaveProperty("account");
    expect(calls[1]![1]).toMatchObject({ amount: AMOUNT_50_RAW, account: WALLET.toLowerCase() });
    expect(calls[2]![1]).toMatchObject({ amount: REF_RAW });
    expect(calls[2]![1]).not.toHaveProperty("account");
  });

  it("requests reference-after only after the candidate quote completes", async () => {
    const events: string[] = [];
    let referenceCount = 0;
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      if (req.account) {
        events.push("candidate-start");
        await Promise.resolve();
        events.push("candidate-end");
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({ label: "candidate", amountInRaw: req.amount }),
        };
      }
      referenceCount += 1;
      events.push(referenceCount === 1 ? "reference-before-start" : "reference-after-start");
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: referenceCount === 1 ? "reference_before" : "reference_after",
          amountInRaw: req.amount,
          outputRaw: REF_OUTPUT_RAW,
          minRaw: "99000000000000000000",
        }),
      };
    }) as never;
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), deps({ getPiteasQuote: quote }));

    expect(result.decision).toBe("WOULD_BUY");
    expect(events).toEqual([
      "reference-before-start",
      "candidate-start",
      "candidate-end",
      "reference-after-start",
    ]);
    expect(quote).toHaveBeenCalledTimes(3);
  });

  it("starts the quote batch and rate-limit reservation after slow market context", async () => {
    let currentMs = NOW;
    const reserve = vi.fn((_count: number, atMs: number) => ({
      ok: true,
      reserved: 3,
      limit: 8,
      windowMs: 60_000,
      used: 3,
      remaining: 5,
      resetAt: new Date(atMs + 60_000).toISOString(),
      resetInMs: 60_000,
    }));
    const d = deps({
      nowMs: () => currentMs,
      buildPhiatDashboard: vi.fn(async () => {
        currentMs += 15_000;
        return {
          token: { address: PHIAT_SHADOW_BUY_TOKEN_OUT },
          market: { priceUsd: { value: "0.0001", source: "mock" } },
          liquidity: { totalLiquidityUsd: 5000 },
          dataQuality: { partialFailures: [] },
        };
      }) as never,
      reservePiteasRateLimitSlots: reserve as never,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    const quoteCalls = vi.mocked(d.getPiteasQuote).mock.calls;

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.exactAmountEvidence.marketContextDurationMs).toBe(15_000);
    expect(result.exactAmountEvidence.quoteBatchStartedAt).toBe(
      new Date(NOW + 15_000).toISOString(),
    );
    expect(reserve).toHaveBeenCalledWith(3, NOW + 15_000);
    expect(quoteCalls[0]![2]).toMatchObject({ timeoutMs: 30_000 });
    expect(result.quoteFreshness?.candidateAgeBeforePreparationMs).toBe(0);
  });

  it("handles realistic sequential Piteas latency under the batch deadline", async () => {
    let currentMs = NOW;
    const latencies = [9_000, 12_000, 11_000];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      const outputRaw = req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW;
      const minRaw = req.account ? CANDIDATE_MIN_RAW : "99000000000000000000";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({ label, amountInRaw: req.amount, outputRaw, minRaw }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.quoteBatchStatus).toBe("COMPLETE");
    expect(result.exactAmountEvidence.quoteBatchDurationMs).toBe(32_000);
    expect(result.referenceBefore?.latencyMs).toBe(9_000);
    expect(result.candidateQuote?.latencyMs).toBe(12_000);
    expect(result.referenceAfter?.latencyMs).toBe(11_000);
    expect(result.quoteFreshness?.candidateAgeBeforePreparationMs).toBe(11_000);
    expect(result.quoteFreshness?.candidateAgeBeforePreparationMs).toBeLessThan(30_000);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
  });

  it("accepts the live timestamp case where reference-before ages past maximumQuoteAgeMs but candidate remains fresh", async () => {
    const batchStartedMs = Date.parse("2026-08-03T12:59:58.056Z");
    let currentMs = batchStartedMs;
    const latencies = [13_079, 14_147, 16_540];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteTimestamp: null,
          expiresAt: null,
        }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
      preparePiteasSwap: vi.fn((candidate: PiteasQuoteData) =>
        preparePiteasSwap(candidate, { account: WALLET }),
      ) as never,
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 30_000, maximumBatchDurationMs: 90_000 }),
      d,
    );
    const referenceBeforeAgeAtCompletion =
      Date.parse(String(result.exactAmountEvidence.quoteBatchCompletedAt)) -
      Date.parse(String(result.referenceBefore?.responseReceivedAt));

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.quoteBatchStatus).toBe("COMPLETE");
    expect(result.exactAmountEvidence.quoteBatchDurationMs).toBe(43_766);
    expect(referenceBeforeAgeAtCompletion).toBe(30_687);
    expect(result.quoteFreshness?.candidateQuoteAgeMs).toBe(16_540);
    expect(result.referenceBeforeValidityStatus).toBe("VALID");
    expect(result.referenceAfterValidityStatus).toBe("VALID");
    expect(result.candidateFreshness?.status).toBe("FRESH");
    expect(result.sandwichTemporalStatus).toBe("COHERENT");
    expect(result.referenceFreshness?.beforeStatus).toBe("VALID");
    expect(result.referenceFreshness?.afterStatus).toBe("VALID");
    expect(result.sandwichTemporalCoherence?.quoteBatchDurationMs).toBe(43_766);
    expect(result.preparedIntent).not.toBeNull();
    expect(result.decodedIntent).not.toBeNull();
    expect(result.routerIntegrityStatus).toBe("PASSED");
    expect(result.allowanceStatus).toBe("SUFFICIENT");
    expect(result.simulationStatus).toBe("PASSED");
    expect(d.preparePiteasSwap).toHaveBeenCalledTimes(1);
    expect(d.getRouterIntegrity).toHaveBeenCalledTimes(1);
    expect(d.getInputBalance).toHaveBeenCalledTimes(1);
    expect(d.getAllowance).toHaveBeenCalledTimes(1);
    expect(d.ethCall).toHaveBeenCalledTimes(1);
    expect(d.estimateGas).toHaveBeenCalledTimes(1);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(3);
  });

  it("rejects a reference quote that was explicitly expired when received", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceBefore: { expiresAt: new Date(NOW - 1).toISOString() },
      }),
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.referenceBeforeValidityStatus).toBe("INVALID");
    expect(result.referenceAfterValidityStatus).toBe("VALID");
    expect(reasonCodes(result)).toContain("REFERENCE_BEFORE_INVALID");
    expect(result.preparedIntent).toBeNull();
  });

  it("rejects a reference quote whose explicit timestamp was already stale when received", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceBefore: { quoteTimestamp: new Date(NOW - 91_000).toISOString() },
      }),
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumBatchDurationMs: 90_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.referenceBeforeValidityStatus).toBe("INVALID");
    expect(reasonCodes(result)).toContain("REFERENCE_BEFORE_INVALID");
    expect(result.preparedIntent).toBeNull();
  });

  it("rejects a candidate that is stale before unsigned preparation", async () => {
    let currentMs = NOW;
    const latencies = [0, 0, 21_000];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteTimestamp: null,
          expiresAt: null,
        }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 20_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.candidateFreshness?.status).toBe("STALE");
    expect(reasonCodes(result)).toContain("CANDIDATE_QUOTE_STALE");
    expect(result.preparedIntent).toBeNull();
  });

  it("rejects a slow but complete sandwich with SANDWICH_TOO_SLOW", async () => {
    let currentMs = NOW;
    const latencies = [30_000, 20_000, 41_000];
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      currentMs += latencies[call] ?? 0;
      const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteTimestamp: null,
          expiresAt: null,
        }),
      };
    }) as never;
    const d = deps({
      nowMs: () => currentMs,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumBatchDurationMs: 90_000, maximumQuoteAgeMs: 600_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("COMPLETE");
    expect(result.sandwichTemporalStatus).toBe("TOO_SLOW");
    expect(result.sandwichTemporalCoherence?.quoteBatchDurationMs).toBe(91_000);
    expect(reasonCodes(result)).toContain("SANDWICH_TOO_SLOW");
  });

  it("rejects unresolved reference cache evidence without using reference age", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceBefore: {
          quoteIdentifier: null,
          quoteTimestamp: null,
          expiresAt: null,
          blockNumber: null,
          responseFingerprint: "same-reference",
        },
        referenceAfter: {
          quoteIdentifier: null,
          quoteTimestamp: null,
          expiresAt: null,
          blockNumber: null,
          responseFingerprint: "same-reference",
        },
      }),
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.referenceFreshness?.possibleCacheDetected).toBe(true);
    expect(result.referenceFreshness?.confidence).toBe("low");
    expect(reasonCodes(result)).toContain("REFERENCE_CACHE_UNRESOLVED");
  });

  it("does not start a Piteas request below the minimum viable timeout", async () => {
    const timeouts: number[] = [];
    const quote = vi.fn(
      async (
        _cfg: AppConfig,
        req: { amount: string; account?: string },
        options?: { timeoutMs?: number },
      ) => {
        if (typeof options?.timeoutMs === "number") timeouts.push(options.timeoutMs);
        const call = quote.mock.calls.length - 1;
        const label = call === 0 ? "reference_before" : call === 1 ? "candidate" : "reference_after";
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({ label, amountInRaw: req.amount }),
        };
      },
    ) as never;
    const d = deps({ getPiteasQuote: quote });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 15_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("DEADLINE_INSUFFICIENT");
    expect(result.referenceAfter?.attempted).toBe(false);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(2);
    expect(timeouts.every((timeout) => timeout >= 8_000)).toBe(true);
  });

  it("binds the candidate quote as the exact quote used for preparation", async () => {
    const prepare = vi.fn((quote: PiteasQuoteData) => preparePiteasSwap(quote, { account: WALLET }));
    const d = deps({ preparePiteasSwap: prepare as never });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("WOULD_BUY");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0].amountIn).toBe(AMOUNT_50_RAW);
    expect(result.exactAmountEvidence.candidateQuoteFingerprint).toBe("fingerprint-candidate");
    expect(result.preparedIntent?.calldata).toBe(prepare.mock.results[0]!.value.ok ? prepare.mock.results[0]!.value.intent.data : null);
  });

  it("registers as a read-only MCP tool with the requested schema", async () => {
    const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    const metas = new Map<string, { inputSchema?: { shape?: Record<string, unknown> } }>();
    const server = {
      registerTool: (name: string, meta: unknown, cb: unknown) => {
        metas.set(name, meta as { inputSchema?: { shape?: Record<string, unknown> } });
        handlers.set(name, cb as (args?: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>);
      },
    };
    registerPhiatShadowBuyTool(server as never, baseConfig, deps());

    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("walletAddress");
    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("approvedRouterCodeHashes");
    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("signedExecutionTrustManifest");
    expect(metas.get("phiat_shadow_buy")?.inputSchema?.shape).toHaveProperty("maximumBatchDurationMs");
    expect(metas.has("resetPiteasRateLimitForTests")).toBe(false);
    const response = await handlers.get("phiat_shadow_buy")!(baseInput());
    const body = JSON.parse(response.content[0]!.text) as { ok: boolean; data: { decision: string } };
    expect(body.ok).toBe(true);
    expect(body.data.decision).toBe("WOULD_BUY");
  });

  it("uses the process-wide rolling limiter and reserves the three-slot batch atomically", async () => {
    const d = deps({ reservePiteasRateLimitSlots });
    await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    const third = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(third.decision).toBe("REJECT");
    expect(reasonCodes(third)).toContain("RATE_LIMIT_REQUOTE_REQUIRED");
    expect(third.rateLimitBudget?.ok).toBe(false);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(6);
  });

  it("rejects before reserving rate-limit slots when the batch deadline cannot fit required reserves", async () => {
    const reserve = vi.fn();
    const d = deps({ reservePiteasRateLimitSlots: reserve as never });

    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumBatchDurationMs: 47_999 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(result.quoteBatchStatus).toBe("DEADLINE_INSUFFICIENT");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_BATCH_DEADLINE");
    expect(result.exactAmountEvidence.piteasRequestCountAttempted).toBe(0);
    expect(result.rateLimitBudget).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
    expect(d.getPiteasQuote).not.toHaveBeenCalled();
  });

  it("reserves concurrent three-slot batches atomically and rejects the third before any quote", async () => {
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length;
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: req.account ? "candidate" : `reference-${call}`,
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteIdentifier: `quote-${call}`,
          responseFingerprint: `fingerprint-${call}`,
          blockNumber: String(123 + call),
        }),
      };
    }) as never;
    const d = deps({
      getPiteasQuote: quote,
      reservePiteasRateLimitSlots,
    });

    const results = await Promise.all([
      buildPhiatShadowBuy(baseConfig, baseInput(), d),
      buildPhiatShadowBuy(baseConfig, baseInput(), d),
      buildPhiatShadowBuy(baseConfig, baseInput(), d),
    ]);

    expect(results.filter((r) => r.decision === "WOULD_BUY")).toHaveLength(2);
    expect(results.filter((r) => reasonCodes(r).includes("RATE_LIMIT_REQUOTE_REQUIRED"))).toHaveLength(1);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(6);
    expect(getPiteasRateLimitBudget(NOW).remaining).toBe(2);
  });

  it("releases unused lease slots without allowing the rolling limit to be exceeded", async () => {
    const earlyFailureQuote = vi.fn(async () => piteasFailure("Piteas HTTP 500", 500)) as never;
    const earlyFailureDeps = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: earlyFailureQuote,
    });
    const failed = await buildPhiatShadowBuy(baseConfig, baseInput(), earlyFailureDeps);

    expect(failed.actualQuoteCallCount).toBe(1);
    expect(failed.exactAmountEvidence.releasedUnusedSlots).toBe(2);
    expect(getPiteasRateLimitBudget(NOW).used).toBe(1);

    const successQuote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = successQuote.mock.calls.length - 1;
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: req.account ? "candidate" : call % 3 === 0 ? "reference_before" : "reference_after",
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
          quoteIdentifier: `quote-${call}`,
          responseFingerprint: `fingerprint-${call}`,
          blockNumber: String(500 + call),
        }),
      };
    }) as never;
    const successDeps = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: successQuote,
    });

    const firstSuccess = await buildPhiatShadowBuy(baseConfig, baseInput(), successDeps);
    const secondSuccess = await buildPhiatShadowBuy(baseConfig, baseInput(), successDeps);
    const thirdSuccessAttempt = await buildPhiatShadowBuy(baseConfig, baseInput(), successDeps);

    expect(firstSuccess.decision).toBe("WOULD_BUY");
    expect(secondSuccess.decision).toBe("WOULD_BUY");
    expect(thirdSuccessAttempt.decision).toBe("REJECT");
    expect(reasonCodes(thirdSuccessAttempt)).toContain("RATE_LIMIT_REQUOTE_REQUIRED");
    expect(successQuote).toHaveBeenCalledTimes(6);
    expect(getPiteasRateLimitBudget(NOW).used).toBe(7);
    expect(getPiteasRateLimitBudget(NOW).remaining).toBe(1);
  });

  it("counts failed outbound quote attempts and restores capacity after the rolling window", async () => {
    const d = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: vi.fn(async () => ({ ok: false, reason: "piteas down" })) as never,
    });

    const failed = await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    expect(failed.decision).toBe("REJECT");
    expect(failed.decisionClass).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(failed.actualQuoteCallCount).toBe(1);
    expect(failed.exactAmountEvidence.reservedSlots).toBe(3);
    expect(failed.exactAmountEvidence.attemptedSlots).toBe(1);
    expect(failed.exactAmountEvidence.releasedUnusedSlots).toBe(2);
    expect(failed.exactAmountEvidence.consumedSlots).toBe(1);
    expect(d.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(getPiteasRateLimitBudget(NOW).remaining).toBe(7);
    expect(getPiteasRateLimitBudget(NOW + 60_001).remaining).toBe(8);
  });

  it("keeps incomplete quote-batch semantics unavailable instead of exceeded or failed-not-run", async () => {
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      if (call === 0) {
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({
            label: "reference_before",
            amountInRaw: req.amount,
            outputRaw: REF_OUTPUT_RAW,
            minRaw: "99000000000000000000",
          }),
        };
      }
      return { ok: false, reason: "candidate timeout" };
    }) as never;
    const d = deps({ getPiteasQuote: quote });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);
    const codes = reasonCodes(result);

    expect(result.decision).toBe("REJECT");
    expect(result.decisionClass).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(result.economicDecisionReached).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryDisposition).toBe("NEW_BATCH_WHEN_UPSTREAM_RECOVERS");
    expect(result.quoteBatchStatus).toBe("CANDIDATE_FAILED");
    expect(codes).toContain("PITEAS_TIMEOUT");
    expect(codes).not.toContain("REFERENCE_AFTER_FAILED");
    expect(codes).not.toContain("REFERENCE_DRIFT_UNAVAILABLE");
    expect(codes).not.toContain("CANDIDATE_DETERIORATION_UNAVAILABLE");
    expect(codes).not.toContain("REFERENCE_DRIFT_EXCEEDED");
    expect(codes).not.toContain("CANDIDATE_DETERIORATION_EXCEEDED");
    expect(result.actualQuoteCallCount).toBe(2);
    expect(quote).toHaveBeenCalledTimes(2);
    expect(result.referenceBeforeValidityStatus).toBe("VALID");
    expect(result.referenceAfterValidityStatus).toBe("NOT_EVALUATED");
    expect(result.candidateFreshnessStatus).toBe("UNAVAILABLE");
    expect(result.policyChecks.reference_after_quote?.status).toBe("not_run");
    expect(result.policyChecks.reference_drift?.status).toBe("not_run");
    expect(result.policyChecks.candidate_deterioration?.status).toBe("not_run");
    expect(result.allowanceStatus).toBe("NOT_EVALUATED");
    expect(result.approvalStatus).toBe("NOT_EVALUATED");
    expect(result.approvalIntent.status).toBe("NOT_EVALUATED");
    expect(result.routerIntegrityStatus).toBe("NOT_EVALUATED");
    expect(result.simulationStatus).toBe("NOT_RUN");
    expect(result.quoteFreshness?.freshnessAcceptable).toBe(false);
    expect(result.quoteFreshness?.freshnessConfidence).toBe("unavailable");
    expect(result.transactionPrepared).toBe(false);
  });

  it("short-circuits reference-before timeout after exactly one Piteas call", async () => {
    const quote = vi.fn(async () => piteasFailure("Piteas request timed out after 30000ms")) as never;
    const d = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.decisionClass).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(result.economicDecisionReached).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryDisposition).toBe("NEW_BATCH_WHEN_UPSTREAM_RECOVERS");
    expect(result.quoteBatchStatus).toBe("REFERENCE_BEFORE_FAILED");
    expect(result.actualQuoteCallCount).toBe(1);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(result.referenceBefore?.upstreamError?.code).toBe("PITEAS_TIMEOUT");
    expect(result.referenceBeforeValidityStatus).toBe("UNAVAILABLE");
    expect(result.referenceAfterValidityStatus).toBe("NOT_EVALUATED");
    expect(result.candidateFreshnessStatus).toBe("NOT_EVALUATED");
    expect(result.exactAmountEvidence.releasedUnusedSlots).toBe(2);
    expect(result.exactAmountEvidence.consumedSlots).toBe(1);
    expect(getPiteasRateLimitBudget(NOW).remaining).toBe(7);
    expect(result.preparedIntent).toBeNull();
    expect(d.preparePiteasSwap).not.toHaveBeenCalled();
  });

  it("short-circuits reference-before HTTP 500 after exactly one Piteas call", async () => {
    const quote = vi.fn(async () => piteasFailure("Piteas HTTP 500", 500)) as never;
    const d = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.quoteBatchStatus).toBe("REFERENCE_BEFORE_FAILED");
    expect(result.actualQuoteCallCount).toBe(1);
    expect(result.referenceBefore?.upstreamError).toMatchObject({
      code: "PITEAS_HTTP_500",
      httpStatus: 500,
      retryable: true,
    });
    expect(reasonCodes(result)).toContain("PITEAS_HTTP_500");
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("short-circuits candidate failure after exactly two Piteas calls", async () => {
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      if (call === 0) {
        return {
          ok: true,
          source: "piteas",
          advisory: true,
          data: quoteData({
            label: "reference_before",
            amountInRaw: req.amount,
            outputRaw: REF_OUTPUT_RAW,
            minRaw: "99000000000000000000",
          }),
        };
      }
      return piteasFailure("Piteas HTTP 500", 500);
    }) as never;
    const d = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.quoteBatchStatus).toBe("CANDIDATE_FAILED");
    expect(result.actualQuoteCallCount).toBe(2);
    expect(result.candidateQuote?.upstreamError?.code).toBe("PITEAS_HTTP_500");
    expect(result.referenceAfter?.attempted).toBe(false);
    expect(result.exactAmountEvidence.releasedUnusedSlots).toBe(1);
    expect(result.exactAmountEvidence.consumedSlots).toBe(2);
    expect(quote).toHaveBeenCalledTimes(2);
    expect(d.preparePiteasSwap).not.toHaveBeenCalled();
  });

  it("classifies reference-after failure after exactly three Piteas calls", async () => {
    const quote = vi.fn(async (_cfg: AppConfig, req: { amount: string; account?: string }) => {
      const call = quote.mock.calls.length - 1;
      if (call === 2) return piteasFailure("Piteas request timed out after 20000ms");
      return {
        ok: true,
        source: "piteas",
        advisory: true,
        data: quoteData({
          label: call === 0 ? "reference_before" : "candidate",
          amountInRaw: req.amount,
          outputRaw: req.account ? CANDIDATE_OUTPUT_RAW : REF_OUTPUT_RAW,
          minRaw: req.account ? CANDIDATE_MIN_RAW : "99000000000000000000",
        }),
      };
    }) as never;
    const d = deps({
      reservePiteasRateLimitSlots,
      getPiteasQuote: quote,
    });

    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.quoteBatchStatus).toBe("REFERENCE_AFTER_FAILED");
    expect(result.actualQuoteCallCount).toBe(3);
    expect(result.referenceAfter?.upstreamError?.code).toBe("PITEAS_TIMEOUT");
    expect(result.exactAmountEvidence.releasedUnusedSlots).toBe(0);
    expect(result.exactAmountEvidence.consumedSlots).toBe(3);
    expect(quote).toHaveBeenCalledTimes(3);
    expect(d.preparePiteasSwap).not.toHaveBeenCalled();
  });

  it("normalizes HTTP 429 and HTTP 403 Piteas failures without automatic retries", async () => {
    const rateLimited = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getPiteasQuote: vi.fn(async () => piteasFailure("Piteas HTTP 429", 429)) as never }),
    );
    expect(rateLimited.decisionClass).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.retryDisposition).toBe("NEW_BATCH_AFTER_RATE_LIMIT_RESET");
    expect(rateLimited.referenceBefore?.upstreamError).toMatchObject({
      code: "PITEAS_HTTP_429",
      httpStatus: 429,
      likelyTemporaryBlock: true,
      conservativeRetryAfterMs: 3_600_000,
    });
    expect(rateLimited.actualQuoteCallCount).toBe(1);

    const forbidden = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getPiteasQuote: vi.fn(async () => piteasFailure("Piteas HTTP 403", 403)) as never }),
    );
    expect(forbidden.decisionClass).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(forbidden.retryable).toBe(false);
    expect(forbidden.retryDisposition).toBe("NONE");
    expect(forbidden.referenceBefore?.upstreamError).toMatchObject({
      code: "PITEAS_HTTP_403",
      httpStatus: 403,
      operatorInvestigationRequired: true,
    });
    expect(forbidden.actualQuoteCallCount).toBe(1);
  });

  it("normalizes invalid JSON Piteas failures as retryable infrastructure failures", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getPiteasQuote: vi.fn(async () => piteasFailure("Piteas invalid JSON response")) as never }),
    );

    expect(result.decisionClass).toBe("INFRASTRUCTURE_REQUOTE_REQUIRED");
    expect(result.economicDecisionReached).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.referenceBefore?.upstreamError?.code).toBe("PITEAS_INVALID_JSON");
    expect(result.actualQuoteCallCount).toBe(1);
  });

  it("calculates exact-amount deterioration and rejects excessive reference drift", async () => {
    const d = deps({
      getPiteasQuote: defaultQuoteMock({
        referenceAfter: { amountOut: "90000000000000000000", outputRaw: "90000000000000000000" } as never,
      }),
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.referenceDriftPercent).toBeGreaterThan(0.5);
    expect(result.policyChecks.reference_drift?.status).toBe("fail");
  });

  it("rejects stale candidate quotes", async () => {
    let currentMs = NOW;
    const d = deps({
      nowMs: () => currentMs,
      ethCall: vi.fn(async () => {
        currentMs += 21_000;
        return { data: "0x" };
      }) as never,
    });
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumQuoteAgeMs: 20_000 }),
      d,
    );

    expect(result.decision).toBe("REJECT");
    expect(reasonCodes(result)).toContain("CANDIDATE_QUOTE_STALE");
    expect(result.quoteFreshness?.candidateAgeAfterSimulationMs).toBeGreaterThan(5_000);
  });

  it("rejects candidate fingerprint changes between quote and preparation", async () => {
    const d = deps({
      preparePiteasSwap: vi.fn((quote: PiteasQuoteData) => {
        const prepared = preparePiteasSwap(quote, { account: WALLET });
        if (!prepared.ok) return prepared;
        const changed = swapCalldata({
          amountInRaw: AMOUNT_50_RAW,
          minOutputRaw: (BigInt(CANDIDATE_MIN_RAW) - 1n).toString(),
        });
        return {
          ...prepared,
          intent: { ...prepared.intent, data: changed },
          methodParameters: { ...prepared.methodParameters, calldata: changed },
        };
      }) as never,
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.candidate_quote_binding?.status).toBe("fail");
    expect(result.policyChecks.calldata_fingerprint_binding?.status).toBe("fail");
    expect(result.policyChecks.method_parameter_fingerprint_binding?.status).toBe("fail");
  });

  it("rejects insufficient eUSDC input balance", async () => {
    const d = deps({ getInputBalance: vi.fn(async () => "0") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_INPUT_BALANCE");
  });

  it("accepts exact input and gas-balance equality but rejects one-unit-short balances", async () => {
    const exactGasWei = "312500000000000";
    const exact = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getNativeBalanceWei: vi.fn(async () => exactGasWei) }),
    );
    expect(exact.decision).toBe("WOULD_BUY");
    expect(exact.balances.inputBalanceSufficient).toBe(true);
    expect(exact.balances.gasBalanceSufficient).toBe(true);

    const oneInputUnitShort = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getInputBalance: vi.fn(async () => (BigInt(AMOUNT_50_RAW) - 1n).toString()) }),
    );
    expect(oneInputUnitShort.decision).toBe("REJECT");
    expect(oneInputUnitShort.policyChecks.input_balance?.status).toBe("fail");

    const oneGasWeiShort = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getNativeBalanceWei: vi.fn(async () => (BigInt(exactGasWei) - 1n).toString()) }),
    );
    expect(oneGasWeiShort.decision).toBe("REJECT");
    expect(oneGasWeiShort.policyChecks.gas_balance?.status).toBe("fail");
  });

  it("rejects insufficient PLS gas balance after gas cost calculation", async () => {
    const d = deps({ getNativeBalanceWei: vi.fn(async () => "1") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_GAS_BALANCE");
    expect(result.gasPolicy.safetyAdjustedGasWei).toBeTruthy();
  });

  it("rejects malformed native balance evidence without throwing", async () => {
    const d = deps({ getNativeBalanceWei: vi.fn(async () => "not-a-number") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.balances.nativeBalancePls).toBeNull();
    expect(result.balances.errors).toContain("PLS balance unavailable: malformed balance value");
    expect(result.policyChecks.gas_balance?.status).toBe("fail");
  });

  it("returns NEEDS_APPROVAL with exact bounded approval and invalidates prior swap evidence", async () => {
    const d = deps({ getAllowance: vi.fn(async () => "0") });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("NEEDS_APPROVAL");
    expect(reasonCodes(result)).toContain("INSUFFICIENT_ALLOWANCE");
    expect(result.approvalIntent.status).toBe("APPROVAL_REQUIRED");
    expect(result.approvalIntent.amountRaw).toBe(AMOUNT_50_RAW);
    expect(result.approvalIntent.unlimitedApproval).toBe(false);
    expect(BigInt(result.approvalIntent.amountRaw!)).toBeLessThanOrEqual(BigInt(AMOUNT_50_RAW));
    expect(result.approvalIntent.token).toBe(PHIAT_SHADOW_BUY_TOKEN_IN);
    expect(result.approvalIntent.spender?.toLowerCase()).toBe(PITEAS_ROUTER.toLowerCase());
    expect(result.swapEvidenceInvalidAfterApproval).toBe(true);
    const decodedApproval = decodeShadowBuyCalldata(result.approvalIntent.calldata!);
    expect(decodedApproval.method).toBe("approve");
    expect(decodedApproval.approvalAmountRaw).toBe(AMOUNT_50_RAW);
    expect(decodedApproval.unlimitedApproval).toBe(false);
  });

  it("does not return NEEDS_APPROVAL when gas balance is insufficient", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      getNativeBalanceWei: vi.fn(async () => "1"),
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.allowance?.status).toBe("warning");
    expect(result.policyChecks.gas_balance?.status).toBe("fail");
    expect(result.approvalIntent.status).toBe("UNAVAILABLE");
  });

  it("does not prepare an approval intent for a wrong spender", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      preparePiteasSwap: vi.fn((quote: PiteasQuoteData): PiteasPrepareResult => {
        const prepared = preparePiteasSwap(quote, { account: WALLET });
        if (!prepared.ok) return prepared;
        return {
          ...prepared,
          intent: { ...prepared.intent, to: BAD_ROUTER },
          review: { ...prepared.review, router: BAD_ROUTER },
        };
      }) as never,
      getRouterIntegrity: routerIntegrity({
        router: BAD_ROUTER,
        routerMatchesAllowlist: false,
      }),
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.router_allowlist?.status).toBe("fail");
    expect(result.approvalIntent.status).toBe("UNAVAILABLE");
    expect(result.approvalIntent.transactionPrepared).toBe(false);
  });

  it("rejects calldata that attempts an unlimited approval instead of a swap", async () => {
    const unlimitedApproval = encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [PITEAS_ROUTER as `0x${string}`, (1n << 256n) - 1n],
    });
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: unlimitedApproval, value: "0" } },
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.decodedIntent?.method).toBe("approve");
    expect(result.decodedIntent?.unlimitedApproval).toBe(true);
    expect(result.policyChecks.no_hidden_approval?.status).toBe("fail");
  });

  it("rejects when direct approval simulation fails", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      ethCall: vi.fn(async () => {
        throw new Error("approval reverted");
      }) as never,
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.approval_simulation?.status).toBe("fail");
  });

  it("rejects when direct approval gas estimation fails", async () => {
    const d = deps({
      getAllowance: vi.fn(async () => "0"),
      estimateGas: vi.fn(async () => {
        throw new Error("approval gas unavailable");
      }) as never,
    });
    const result = await buildPhiatShadowBuy(baseConfig, baseInput(), d);

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.approval_simulation?.status).toBe("fail");
    expect(result.approvalIntent.simulation?.estimateGasOk).toBe(false);
  });

  it("rejects wrong chain, wrong router, and empty router code", async () => {
    const wrongChain = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({ getPiteasQuote: defaultQuoteMock({ candidate: { chainId: 1 } }) }),
    );
    expect(wrongChain.policyChecks.chain_id?.status).toBe("fail");

    const wrongRouterDeps = deps({
      preparePiteasSwap: vi.fn((quote: PiteasQuoteData): PiteasPrepareResult => {
        const prepared = preparePiteasSwap(quote, { account: WALLET });
        if (!prepared.ok) return prepared;
        return {
          ...prepared,
          intent: { ...prepared.intent, to: BAD_ROUTER },
          review: { ...prepared.review, router: BAD_ROUTER },
        };
      }) as never,
      getRouterIntegrity: routerIntegrity({
        router: BAD_ROUTER,
        routerMatchesAllowlist: false,
      }),
    });
    const wrongRouter = await buildPhiatShadowBuy(baseConfig, baseInput(), wrongRouterDeps);
    expect(wrongRouter.policyChecks.transaction_to_router?.status).toBe("fail");
    expect(wrongRouter.policyChecks.router_allowlist?.status).toBe("fail");

    const emptyCode = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getRouterIntegrity: routerIntegrity({
          bytecodePresent: false,
          routerBytecodeHash: null,
          routerCodeHashApproved: null,
          codeHashAgreement: "unavailable",
        }),
      }),
    );
    expect(emptyCode.policyChecks.router_bytecode_present?.status).toBe("fail");
  });

  it("reports unapproved router hash without marking automatic execution eligible", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ approvedRouterCodeHashes: [] }),
      deps({
        getRouterIntegrity: routerIntegrity({
          routerBytecodeHash: UNAPPROVED_HASH,
          approvedRouterCodeHashes: [],
          routerCodeHashApproved: false,
        }),
      }),
    );

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.policyChecks.router_code_hash_approved?.status).toBe("warning");
    expect(result.automaticExecutionEligible).toBe(false);
  });

  it("keeps automatic execution disabled when the router trust record is not approved", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ approvedRouterCodeHashes: [], approvedRouterTrustRecords: [] }),
      deps({
        getRouterIntegrity: routerIntegrity({
          routerBytecodeHash: UNAPPROVED_HASH,
          approvedRouterCodeHashes: [],
          approvedRouterTrustRecords: [],
          routerCodeHashApproved: false,
          operatorApprovalRequired: true,
          trustRecordFingerprint: "0xunapproved-router-trust",
        }),
      }),
    );

    expect(result.routerIntegrity.operatorApprovalRequired).toBe(true);
    expect(result.automaticExecutionEligible).toBe(false);
    expect(result.policyChecks.router_code_hash_approved?.status).toBe("warning");
  });

  it("rejects two-RPC router code-hash disagreement", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getRouterIntegrity: routerIntegrity({
          codeHashAgreement: "disagrees",
          rpcCodeHashes: [
            { rpcUrl: "a", ok: true, codeHash: APPROVED_HASH, bytecodeLength: 100, error: null },
            { rpcUrl: "b", ok: true, codeHash: UNAPPROVED_HASH, bytecodeLength: 100, error: null },
          ],
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.router_code_hash_agreement?.status).toBe("fail");
  });

  it("rejects proxy implementation disagreement across RPCs", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getRouterIntegrity: routerIntegrity({
          proxyDetection: {
            ...baseRouterIntegrity().proxyDetection,
            proxyDetected: true,
            proxyType: "eip1967",
            implementationAddress: "0x5555555555555555555555555555555555555555",
            implementationCodeHash: APPROVED_HASH,
            rpcAgreement: "disagrees",
          },
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.router_code_hash_agreement?.status).toBe("fail");
  });

  it("resolves EIP-1967 proxy implementation trust records", async () => {
    const implementation = "0x5555555555555555555555555555555555555555";
    const routerCode = "0x60016000" as const;
    const implementationCode = "0x60026000" as const;
    const routerHash = keccak256(routerCode);
    const implementationHash = keccak256(implementationCode);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params?: string[];
        id?: number;
      };
      let result: string;
      if (body.method === "eth_blockNumber") result = "0x7b";
      else if (body.method === "eth_getCode" && body.params?.[0]?.toLowerCase() === PITEAS_ROUTER.toLowerCase()) {
        result = routerCode;
      } else if (body.method === "eth_getCode" && body.params?.[0]?.toLowerCase() === implementation.toLowerCase()) {
        result = implementationCode;
      } else if (body.method === "eth_getStorageAt") {
        result = `0x${"0".repeat(24)}${implementation.slice(2)}`;
      } else {
        throw new Error(`Unexpected RPC method ${body.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const integrity = await readRouterIntegrity(
      { ...baseConfig, rpcUrls: ["https://rpc-a.example"] },
      PITEAS_ROUTER,
      [],
      [
        {
          router: PITEAS_ROUTER,
          codeHash: routerHash,
          chainId: 369,
          implementationAddress: implementation,
          implementationCodeHash: implementationHash,
          label: "test proxy",
        },
      ],
    );

    expect(integrity.routerBytecodeHash).toBe(routerHash);
    expect(integrity.proxyDetection.proxyDetected).toBe(true);
    expect(integrity.proxyDetection.implementationAddress?.toLowerCase()).toBe(implementation.toLowerCase());
    expect(integrity.proxyDetection.implementationCodeHash).toBe(implementationHash);
    expect(integrity.routerCodeHashApproved).toBe(true);
    expect(integrity.operatorApprovalRequired).toBe(false);
    expect(integrity.rpcCodeHashes[0]?.bytecode).toBe(routerCode);
    expect(integrity.rpcCodeHashes[0]?.implementationBytecode).toBe(implementationCode);
    expect(integrity.rpcCodeHashes[0]?.blockNumber).toBe("123");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("pins Piteas router source evidence and the SwapManager selector", () => {
    const evidence = routerSourceEvidence();

    expect(toFunctionSelector(PITEAS_SWAP_MANAGER_CANONICAL_SIGNATURE)).toBe(PITEAS_SWAP_MANAGER_SELECTOR);
    expect(PITEAS_SWAP_MANAGER_SELECTOR).toBe("0x627dd56a");
    expect(evidence.sourceRepository).toBe("https://github.com/piteasio/piteas-contracts");
    expect(evidence.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.routerSourceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(evidence.pitErc20SourceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(evidence.swapManagerInterfaceSourceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(evidence.compilerVersion).toBe("v0.8.18+commit.87f61d96");
    expect(evidence.optimizerSettings.enabled).toBe(false);
    expect(evidence.verifiedRouterAbi).toBe(true);
    expect(evidence.verifiedRouterSource).toBe(true);
  });

  it("derives inherited SwapManager storage layout and decodes the live storage word", () => {
    const layout = deriveSwapManagerStorageLayout();
    const liveStorageWord =
      "0x00000000000000000000000058ab37d02696a481e2e5b5779967f3f4d237baa9";
    const liveManager = "0x58ab37d02696a481e2e5b5779967f3f4d237baa9";

    expect(layout.status).toBe("DERIVED");
    expect(layout.inheritanceOrder).toEqual(["Ownable", "EthReceiver", "PiteasRouter"]);
    expect(layout.slot).toBe(PITEAS_SWAP_MANAGER_STORAGE_SLOT);
    expect(layout.offsetBytes).toBe(0);
    expect(layout.widthBytes).toBe(20);
    expect(layout.layoutFingerprint).toMatch(/^0x[a-f0-9]{64}$/);

    const decoded = decodeAddressFromStorageWord({
      storageWord: liveStorageWord,
      slot: layout.slot,
      offsetBytes: layout.offsetBytes,
      widthBytes: layout.widthBytes,
    });
    expect(decoded.ok).toBe(true);
    expect(decoded.normalizedAddress?.toLowerCase()).toBe(liveManager);
    expect(decoded.normalizedAddress?.toLowerCase()).not.toBe(
      "0x0058ab37d02696a481e2e5b5779967f3f4d237ba",
    );

    const priorBadOffset = decodeAddressFromStorageWord({
      storageWord: liveStorageWord,
      slot: layout.slot,
      offsetBytes: 1,
      widthBytes: layout.widthBytes,
    });
    expect(priorBadOffset.normalizedAddress?.toLowerCase()).toBe(
      "0x0058ab37d02696a481e2e5b5779967f3f4d237ba",
    );
  });

  it("rejects malformed storage words and reports zero SwapManager addresses", () => {
    const layout = deriveSwapManagerStorageLayout();
    const malformed = decodeAddressFromStorageWord({
      storageWord: "0x1234",
      slot: layout.slot,
      offsetBytes: layout.offsetBytes,
      widthBytes: layout.widthBytes,
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toMatch(/32 bytes/);

    const zero = decodeAddressFromStorageWord({
      storageWord: `0x${"0".repeat(64)}`,
      slot: layout.slot,
      offsetBytes: layout.offsetBytes,
      widthBytes: layout.widthBytes,
    });
    expect(zero.ok).toBe(true);
    expect(zero.zeroAddress).toBe(true);
    expect(zero.normalizedAddress).toBe("0x0000000000000000000000000000000000000000");

    const wrongWidth = decodeAddressFromStorageWord({
      storageWord: packedManagerStorage(MANAGER),
      slot: layout.slot,
      offsetBytes: layout.offsetBytes,
      widthBytes: 19,
    });
    expect(wrongWidth.ok).toBe(false);
    expect(wrongWidth.error).toMatch(/20 bytes/);
  });

  it("derives active SwapManager from storage and reconciles ChangedSwapManager events", async () => {
    stubExecutionRpc({ manager: MANAGER, eventManager: MANAGER });

    const active = await discoverActiveSwapManager(baseConfig, "0x7c");

    expect(active.address?.toLowerCase()).toBe(MANAGER.toLowerCase());
    expect(active.storageSlot).toBe(PITEAS_SWAP_MANAGER_STORAGE_SLOT);
    expect(active.storageOffsetBytes).toBe(0);
    expect(active.storageWidthBytes).toBe(20);
    expect(active.swapManagerStorageLayout.slot).toBe(PITEAS_SWAP_MANAGER_STORAGE_SLOT);
    expect(active.swapManagerStorageLayout.offsetBytes).toBe(0);
    expect(active.swapManagerStorageLayout.widthBytes).toBe(20);
    expect(active.storageAgreement).toBe("agrees");
    expect(active.storageEvidenceByRpc).toHaveLength(2);
    expect(active.storageEvidenceByRpc.every((row) => row.decodedAddress?.toLowerCase() === MANAGER.toLowerCase())).toBe(true);
    expect(active.latestChangeEvent?.address?.toLowerCase()).toBe(MANAGER.toLowerCase());
    expect(active.latestChangeEvent?.topic).toBe(PITEAS_CHANGED_SWAP_MANAGER_TOPIC);
    expect(active.storageEventAgreement).toBe("agrees");
    expect(active.officialDocumentationMatch).toBe(false);
    expect(active.documentationStatus).toBe("STALE");
    expect(PITEAS_OFFICIAL_DOCUMENTED_SWAP_MANAGER.toLowerCase()).not.toBe(MANAGER.toLowerCase());
    expect(active.confidence).toBe("high");
  });

  it("fails manager discovery confidence when storage and latest event disagree", async () => {
    stubExecutionRpc({ manager: MANAGER, eventManager: OTHER });

    const active = await discoverActiveSwapManager(baseConfig, "0x7c");

    expect(active.address?.toLowerCase()).toBe(MANAGER.toLowerCase());
    expect(active.latestChangeEvent?.address?.toLowerCase()).toBe(OTHER.toLowerCase());
    expect(active.storageEventAgreement).toBe("disagrees");
    expect(active.confidence).toBe("medium");
  });

  it("requires independent event and two-RPC storage confirmation for manager automation", async () => {
    stubExecutionRpc({ manager: MANAGER, eventManager: null });
    const noEvent = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(noEvent.activeSwapManager.storageEventAgreement).toBe("event_unavailable");
    expect(noEvent.failureCodes).toContain("SWAP_MANAGER_EVENT_UNAVAILABLE");
    expect(noEvent.automaticExecutionEligible).toBe(false);

    stubExecutionRpc({ manager: MANAGER, eventManager: MANAGER });
    const singleRpc = await certifyPiteasExecutionLayer(
      { ...baseConfig, rpcUrls: ["https://rpc-a.example"] },
      executionCertArgs(),
    );

    expect(singleRpc.failureCodes).toContain("SWAP_MANAGER_STORAGE_DISAGREEMENT");
    expect(singleRpc.automaticExecutionEligible).toBe(false);
  });

  it("does not report false manager event mismatch or bytecode unavailable with corrected storage layout", async () => {
    stubExecutionRpc({ manager: MANAGER, eventManager: MANAGER });

    const certificate = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(certificate.activeSwapManager.address?.toLowerCase()).toBe(MANAGER.toLowerCase());
    expect(certificate.activeSwapManager.storageEventAgreement).toBe("agrees");
    expect(certificate.swapManagerIntegrity.codeHashesByRpc.every((row) => row.bytecodeLength !== 0)).toBe(true);
    expect(certificate.failureCodes).not.toContain("SWAP_MANAGER_EVENT_MISMATCH");
    expect(certificate.failureCodes).not.toContain("SWAP_MANAGER_BYTECODE_UNAVAILABLE");
    expect(certificate.activeSwapManager.documentationStatus).toBe("STALE");
  });

  it("certifies direct SwapManager integrity while keeping legacy trust records inert", async () => {
    stubExecutionRpc({ manager: MANAGER });
    const managerHash = keccak256(DIRECT_MANAGER_CODE);

    const integrity = await readSwapManagerIntegrity(baseConfig, MANAGER, "0x7c", [
      executionTrustRecord(MANAGER, "SwapManager", managerHash, [PITEAS_SWAP_MANAGER_SELECTOR]),
    ]);

    expect(integrity.address?.toLowerCase()).toBe(MANAGER.toLowerCase());
    expect(integrity.codeHashAgreement).toBe("agrees");
    expect(integrity.codeHashesByRpc).toHaveLength(2);
    expect(integrity.codeHashesByRpc.every((row) => row.runtimeCodeHash === managerHash)).toBe(true);
    expect(integrity.proxyType).toBe("none");
    expect(integrity.sourceVerificationStatus).toBe("verified");
    expect(integrity.abiFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(integrity.sourceFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(integrity.trusted).toBe(false);
    expect(integrity.operatorApprovalRequired).toBe(true);
  });

  it("does not classify delegatecall-capable manager bytecode as a proxy without proxy evidence", async () => {
    const delegatecallCapableCode = "0x60f4600055" as const;
    stubExecutionRpc({ manager: MANAGER, managerCode: delegatecallCapableCode });

    const integrity = await readSwapManagerIntegrity(baseConfig, MANAGER, "0x7c", []);

    expect(integrity.proxyType).toBe("none");
    expect(integrity.proxyDetection.proxyType).toBe("NONE_DETECTED");
    expect(integrity.proxyDetection.implementationAddress).toBeNull();
    expect(integrity.proxyDetection.beaconAddress).toBeNull();
    expect(integrity.executionOpcodeObservations.containsDelegatecallOpcode).toBe(true);
    expect(integrity.trusted).toBe(false);
    expect(integrity.operatorApprovalRequired).toBe(true);
  });

  it("keeps the historical Piteas trace fixture diagnostic-only", () => {
    const historicalTraceFixture = {
      historicalDiagnosticOnly: true,
      automaticExecutionQualifying: false,
      transactionHash: "0x1a0d519d0b1ae9e0f759d2a068fa720c3759d5f057b611f91c726ef8db570a56",
      blockNumber: "27195532",
      routerHash: "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b",
      currentRouterHash: "0xb5258c97b5eab452bf93b61916631704898cc81bcbb2dff8524c3215a8f1454b",
      manager: "0x58ab37d02696a481e2e5b5779967f3f4d237baa9",
      currentManager: "0x58ab37d02696a481e2e5b5779967f3f4d237baa9",
      managerHash: "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb",
      currentManagerHash: "0x92a4a63ef15f2f9f1fa21860dc3b80ce97a41964189d44076223744e361a3cfb",
      routerCallSequence: [
        {
          to: "0x58ab37d02696a481e2e5b5779967f3f4d237baa9",
          selector: PITEAS_SWAP_MANAGER_SELECTOR,
        },
      ],
      prohibitedOperations: [] as string[],
    };

    expect(historicalTraceFixture.routerHash).toBe(historicalTraceFixture.currentRouterHash);
    expect(historicalTraceFixture.manager.toLowerCase()).toBe(historicalTraceFixture.currentManager);
    expect(historicalTraceFixture.managerHash).toBe(historicalTraceFixture.currentManagerHash);
    expect(historicalTraceFixture.routerCallSequence).toContainEqual({
      to: historicalTraceFixture.manager,
      selector: PITEAS_SWAP_MANAGER_SELECTOR,
    });
    expect(historicalTraceFixture.prohibitedOperations).toEqual([]);
    expect(historicalTraceFixture.historicalDiagnosticOnly).toBe(true);
    expect(historicalTraceFixture.automaticExecutionQualifying).toBe(false);
  });

  it("detects SwapManager code-hash disagreement across RPCs", async () => {
    stubExecutionRpc({
      managerCodeByRpc: {
        "https://rpc-a.example": "0x60016000",
        "https://rpc-b.example": "0x60026000",
      },
    });

    const integrity = await readSwapManagerIntegrity(baseConfig, MANAGER, "0x7c", []);

    expect(integrity.codeHashAgreement).toBe("disagrees");
    expect(new Set(integrity.codeHashesByRpc.map((row) => row.runtimeCodeHash))).toHaveLength(2);
    expect(integrity.trusted).toBe(false);
    expect(integrity.operatorApprovalRequired).toBe(true);
  });

  it("resolves EIP-1967 implementation and beacon proxies for SwapManager integrity", async () => {
    const implementation = "0x7777777777777777777777777777777777777777";
    const implementationCode = "0x60076000" as const;
    const managerHash = keccak256(DIRECT_MANAGER_CODE);
    const implementationHash = keccak256(implementationCode);
    stubExecutionRpc({ implementationAddress: implementation, implementationCode });

    const eip1967 = await readSwapManagerIntegrity(baseConfig, MANAGER, "0x7c", [
      {
        ...executionTrustRecord(MANAGER, "SwapManager", managerHash, [PITEAS_SWAP_MANAGER_SELECTOR]),
        implementationAddress: implementation,
        implementationCodeHash: implementationHash,
      },
    ]);

    expect(eip1967.proxyType).toBe("eip1967");
    expect(eip1967.implementationAddress?.toLowerCase()).toBe(implementation.toLowerCase());
    expect(eip1967.implementationCodeHashesByRpc.every((row) => row.runtimeCodeHash === implementationHash)).toBe(true);
    expect(eip1967.trusted).toBe(false);

    const beacon = "0x8888888888888888888888888888888888888888";
    stubExecutionRpc({ beaconAddress: beacon, implementationAddress: implementation, implementationCode });
    const beaconIntegrity = await readSwapManagerIntegrity(baseConfig, MANAGER, "0x7c", []);

    expect(beaconIntegrity.proxyType).toBe("eip1967_beacon");
    expect(beaconIntegrity.implementationAddress?.toLowerCase()).toBe(implementation.toLowerCase());
    expect(beaconIntegrity.implementationCodeHashesByRpc.every((row) => row.runtimeCodeHash === implementationHash)).toBe(true);
  });

  it("detects EIP-1167 minimal proxy SwapManagers", async () => {
    const implementation = "0x7777777777777777777777777777777777777777";
    const minimalProxy =
      `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as const;
    stubExecutionRpc({ managerCode: minimalProxy, implementationAddress: null });

    const integrity = await readSwapManagerIntegrity(baseConfig, MANAGER, "0x7c", []);

    expect(integrity.proxyType).toBe("eip1167");
    expect(integrity.implementationAddress?.toLowerCase()).toBe(implementation.toLowerCase());
    expect(integrity.implementationCodeHashesByRpc).toHaveLength(2);
  });

  it("treats route bytes as manager-specific opaque data with heuristic addresses only", async () => {
    stubExecutionRpc({ manager: MANAGER });

    const certificate = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(certificate.routeData.rawFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(certificate.routeData.length).toBeGreaterThan(0);
    expect(certificate.routeData.managerCodeHash).toBe(keccak256(DIRECT_MANAGER_CODE));
    expect(certificate.routeData.decoderVersion).toBe("opaque-manager-bound-v1");
    expect(certificate.routeData.decoderMatchesManagerHash).toBe(false);
    expect(certificate.routeData.authoritativeFields).toEqual([]);
    expect(certificate.routeData.heuristicObservations.map((row) => row.value.toLowerCase())).toContain(
      POOL.toLowerCase(),
    );

    stubExecutionRpc({ manager: MANAGER, managerCode: "0x60018000" });
    const changedHashCertificate = await certifyPiteasExecutionLayer(
      baseConfig,
      executionCertArgs({
        approvedTrustRecords: [
          executionTrustRecord(MANAGER, "SwapManager", keccak256("0x60018000"), [
            PITEAS_SWAP_MANAGER_SELECTOR,
          ]),
          executionTrustRecord(PROTOCOL, "ProtocolRouter", keccak256(DIRECT_PROTOCOL_CODE), ["0xabcdef01"]),
        ],
      }),
    );
    expect(changedHashCertificate.routeData.managerCodeHash).toBe(keccak256("0x60018000"));
    expect(changedHashCertificate.routeData.decoderMatchesManagerHash).toBe(false);
  });

  it("traces the exact prepared call and leaves execution authority to a signed manifest", async () => {
    stubExecutionRpc({ traceRoot: successfulTrace() });

    const certificate = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(certificate.managerIntegrityStatus).toBe("PASSED");
    expect(certificate.executionTraceStatus).toBe("PASSED");
    expect(certificate.executionGraphStatus).toBe("PARTIALLY_RESOLVED");
    expect(certificate.traceBackend).toMatchObject({
      method: "debug_traceCall",
      stateOverridesUsed: false,
      supported: true,
    });
    expect(certificate.routerCallSequence.map((call) => call.classification)).toEqual([
      "source_token_transfer_from_wallet_to_swap_manager",
      "router_call_to_active_swap_manager",
      "destination_token_balance_check",
      "destination_token_transfer_to_recipient",
    ]);
    expect(certificate.executionGraph).toHaveLength(1);
    expect(certificate.executionGraph[0]).toMatchObject({
      to: PROTOCOL,
      selector: "0xabcdef01",
      protocolClassification: "state_changing_selector_unknown",
      trustStatus: "unresolved",
    });
    expect(certificate.unresolvedTargets).toContain("swap_manager_not_operator_approved");
    expect(certificate.failureCodes).toContain("TRUST_MANIFEST_REQUIRED");
    expect(certificate.failureCodes).toContain("EXECUTION_GRAPH_UNRESOLVED");
    expect(certificate.executionAuthority).toBe("MISSING");
    expect(certificate.automaticExecutionEligible).toBe(false);
  });

  it("reports unsupported and state-insufficient trace infrastructure honestly", async () => {
    stubExecutionRpc({
      debugTraceError: "the method debug_traceCall does not exist",
      traceCallError: "the method trace_call does not exist",
    });
    const unsupported = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(unsupported.executionTraceStatus).toBe("UNSUPPORTED");
    expect(unsupported.executionGraphStatus).toBe("UNRESOLVED");
    expect(unsupported.failureCodes).toContain("EXECUTION_TRACE_UNSUPPORTED");
    expect(unsupported.automaticExecutionEligible).toBe(false);

    stubExecutionRpc({
      debugTraceError: "insufficient funds for gas * price + value",
      traceCallError: "the method trace_call does not exist",
    });
    const stateInsufficient = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(stateInsufficient.executionTraceStatus).toBe("STATE_INSUFFICIENT");
    expect(stateInsufficient.failureCodes).toContain("EXECUTION_TRACE_STATE_INSUFFICIENT");
    expect(stateInsufficient.automaticExecutionEligible).toBe(false);
  });

  it("does not let a state-override diagnostic qualify automatic execution", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        certifyExecutionLayer: executionLayer({
          traceBackend: {
            ...resolvedExecutionLayer().traceBackend,
            stateOverridesUsed: true,
          },
          automaticExecutionEligible: true,
        }),
      }),
    );

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.executionTraceStatus).toBe("PASSED");
    expect(result.traceBackend.stateOverridesUsed).toBe(true);
    expect(result.automaticExecutionEligible).toBe(false);
  });

  it("requires a signed trust manifest before the shadow certificate can report execution eligibility", async () => {
    const missing = await buildPhiatShadowBuy(baseConfig, baseInput(), deps());
    expect(missing.automaticExecutionEligible).toBe(false);

    const signedExecutionTrustManifest = { manifest: { id: "mock-signed" } };
    const certified = resolvedExecutionLayer({
      manifestAuthorizationStatus: "VALID",
      liveExecutionAuthorityStatus: "VALID",
      executionAuthority: "VALID",
      trustManifestVerification: {
        manifest: null,
        manifestFingerprint: `0x${"12".repeat(32)}`,
        signatureAlgorithm: "Ed25519",
        operatorPublicKeyId: "test-operator",
        signature: "test-signature",
        signatureValid: true,
        expired: false,
        blockRemaining: "10",
        millisecondsRemaining: 60_000,
        chainRouterManagerConsistent: true,
        approvedRecordCount: 2,
        invalidRecordCount: 0,
        validationErrors: [],
        cryptographicStatus: "PASSED",
        schemaStatus: "PASSED",
        canonicalizationStatus: "PASSED",
        keyStatus: "PASSED",
        temporalStatus: "PASSED",
        revocationStatus: "PASSED",
        chainStateStatus: "PASSED",
        graphAuthorityStatus: "PASSED",
        temporalAuthority: null,
        verificationScope: "EXACT_LIVE_GRAPH",
        manifestAuthorizationStatus: "VALID",
        liveExecutionAuthorityStatus: "VALID",
        automaticExecutionEligible: true,
        authorizationLayers: {
          signedManifest: {
            status: "VALID",
            fingerprint: `0x${"12".repeat(32)}`,
            keyId: "test-operator",
            signatureValid: true,
            schemaValid: true,
            temporalValid: true,
          },
          revocation: { status: "PASSED", configured: true, clear: true },
          chainState: { status: "PASSED", routerMatched: true, managerMatched: true },
          liveGraph: {
            status: "VALID",
            evaluated: true,
            graphMatched: true,
            unexpectedTargets: [],
            unexpectedSelectors: [],
            unexpectedEdges: [],
          },
          execution: { status: "VALID", automaticExecutionEligible: true },
        },
        executionAuthority: "VALID",
      },
      trustManifestComparison: {
        status: "PASSED",
        automaticExecutionEligible: true,
        failureCodes: [],
        validationErrors: [],
        unexpectedTargets: [],
        unexpectedSelectors: [],
        unexpectedEdges: [],
      },
      automaticExecutionEligible: true,
      failureCodes: [],
      validationErrors: [],
    });
    const certifyExecutionLayer = vi.fn(async () => certified) as never;
    const eligible = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ signedExecutionTrustManifest }),
      deps({ certifyExecutionLayer }),
    );

    expect(certifyExecutionLayer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvedTrustRecords: [],
        signedExecutionTrustManifest,
      }),
    );
    expect(eligible.automaticExecutionEligible).toBe(true);
    expect(eligible.manifestAuthorizationStatus).toBe("VALID");
    expect(eligible.liveExecutionAuthorityStatus).toBe("VALID");
    expect(eligible.executionAuthority).toBe("VALID");
    expect(eligible.transactionSigned).toBe(false);
    expect(eligible.transactionSubmitted).toBe(false);
    expect(eligible.transactionBroadcast).toBe(false);
    expect(eligible.transactionExecuted).toBe(false);
  });

  it("does not reuse a standalone verifier-shaped input as execution authority", async () => {
    const standaloneVerifierResult = {
      manifestAuthorizationStatus: "VALID",
      liveExecutionAuthorityStatus: "VALID",
      executionAuthority: "VALID",
      automaticExecutionEligible: true,
    };
    const certified = resolvedExecutionLayer({
      manifestAuthorizationStatus: "VALID",
      liveExecutionAuthorityStatus: "NOT_EVALUATED",
      executionAuthority: "NOT_EVALUATED",
      trustManifestVerification: null,
      trustManifestComparison: null,
      automaticExecutionEligible: false,
      failureCodes: ["TRUST_MANIFEST_GRAPH_NOT_EVALUATED"],
      validationErrors: ["Live execution graph was not evaluated."],
    });
    const certifyExecutionLayer = vi.fn(async () => certified) as never;
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ signedExecutionTrustManifest: standaloneVerifierResult }),
      deps({ certifyExecutionLayer }),
    );

    expect(certifyExecutionLayer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signedExecutionTrustManifest: standaloneVerifierResult,
      }),
    );
    expect(result.decision).toBe("WOULD_BUY");
    expect(result.manifestAuthorizationStatus).toBe("VALID");
    expect(result.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(result.executionAuthority).toBe("NOT_EVALUATED");
    expect(result.automaticExecutionEligible).toBe(false);
    expect(result.transactionSigned).toBe(false);
    expect(result.transactionSubmitted).toBe(false);
    expect(result.transactionBroadcast).toBe(false);
    expect(result.transactionExecuted).toBe(false);
  });

  it("derives top-level automation only from independently valid live authority", async () => {
    const certified = resolvedExecutionLayer({
      manifestAuthorizationStatus: "VALID",
      liveExecutionAuthorityStatus: "NOT_EVALUATED",
      executionAuthority: "VALID",
      trustManifestComparison: {
        status: "PASSED",
        automaticExecutionEligible: true,
        failureCodes: [],
        validationErrors: [],
        unexpectedTargets: [],
        unexpectedSelectors: [],
        unexpectedEdges: [],
      },
      automaticExecutionEligible: true,
      failureCodes: [],
      validationErrors: [],
    });
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ signedExecutionTrustManifest: { manifest: { id: "mock-signed" } } }),
      deps({ certifyExecutionLayer: vi.fn(async () => certified) as never }),
    );

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.liveExecutionAuthorityStatus).toBe("NOT_EVALUATED");
    expect(result.executionAuthority).toBe("VALID");
    expect(result.automaticExecutionEligible).toBe(false);
    expect(result.transactionSigned).toBe(false);
    expect(result.transactionSubmitted).toBe(false);
    expect(result.transactionBroadcast).toBe(false);
    expect(result.transactionExecuted).toBe(false);
  });

  it("rejects manager, router, and manager-code changes between quote and simulation", async () => {
    stubExecutionRpc({
      managerAtQuote: OTHER,
      routerCodeAtQuote: "0x60111100",
      managerCodeAtQuote: "0x60222200",
    });

    const certificate = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(certificate.managerChangedSinceQuote).toBe(true);
    expect(certificate.routerManagerBinding.routerCodeChangedSinceQuote).toBe(true);
    expect(certificate.routerManagerBinding.managerCodeChangedSinceQuote).toBe(true);
    expect(certificate.failureCodes).toContain("SWAP_MANAGER_CHANGED");
    expect(certificate.failureCodes).toContain("ROUTER_CODE_CHANGED");
    expect(certificate.failureCodes).toContain("SWAP_MANAGER_CODE_CHANGED");
    expect(certificate.automaticExecutionEligible).toBe(false);
  });

  it("rejects unexpected router targets and SwapManager selector mismatches", async () => {
    stubExecutionRpc({
      traceRoot: successfulTrace({ managerInput: `0xdeadbeef${"0".repeat(64)}` }),
    });

    const certificate = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(certificate.executionGraphStatus).toBe("UNRESOLVED");
    expect(certificate.unresolvedTargets).toContain("router_to_active_swap_manager_call");
    expect(certificate.unresolvedTargets.some((target) => target.startsWith("unexpected_router_target:"))).toBe(true);
    expect(certificate.failureCodes).toContain("EXECUTION_GRAPH_UNRESOLVED");
    expect(certificate.automaticExecutionEligible).toBe(false);
  });

  it("rejects unknown delegatecall and unresolved protocol targets", async () => {
    stubExecutionRpc({
      traceRoot: successfulTrace({
        managerCalls: [
          {
            type: "DELEGATECALL",
            from: MANAGER,
            to: PROTOCOL,
            input: `0xdeadbeef${"0".repeat(64)}`,
            value: "0x0",
            gasUsed: "0x1234",
          },
        ],
      }),
    });

    const certificate = await certifyPiteasExecutionLayer(
      baseConfig,
      executionCertArgs({
        approvedTrustRecords: [
          executionTrustRecord(MANAGER, "SwapManager", keccak256(DIRECT_MANAGER_CODE), [
            PITEAS_SWAP_MANAGER_SELECTOR,
          ]),
        ],
      }),
    );

    expect(certificate.executionGraphStatus).toBe("PARTIALLY_RESOLVED");
    expect(certificate.unresolvedTargets.some((target) => target.startsWith("unknown_delegatecall_target:"))).toBe(true);
    expect(certificate.unresolvedTargets.some((target) => target.startsWith("unresolved_protocol_target:"))).toBe(true);
    expect(certificate.failureCodes).toContain("EXECUTION_GRAPH_UNRESOLVED");
    expect(certificate.automaticExecutionEligible).toBe(false);
  });

  it("rejects CREATE, CREATE2, SELFDESTRUCT, and CALLCODE in the manager graph", async () => {
    stubExecutionRpc({
      traceRoot: successfulTrace({
        managerCalls: [
          { type: "CREATE", from: MANAGER, input: "0x", value: "0x0", gasUsed: "0x1" },
          { type: "CREATE2", from: MANAGER, input: "0x", value: "0x0", gasUsed: "0x1" },
          { type: "SELFDESTRUCT", from: MANAGER, to: PROTOCOL, input: "0x", value: "0x0", gasUsed: "0x1" },
          { type: "CALLCODE", from: MANAGER, to: PROTOCOL, input: "0x", value: "0x0", gasUsed: "0x1" },
        ],
      }),
    });

    const certificate = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(certificate.executionGraphStatus).toBe("FAILED");
    expect(certificate.prohibitedOperations).toEqual([
      "CREATE_REJECTED",
      "CREATE2_REJECTED",
      "SELFDESTRUCT_REJECTED",
      "CALLCODE_REJECTED",
    ]);
    expect(certificate.failureCodes).toEqual(expect.arrayContaining(certificate.prohibitedOperations));
    expect(certificate.automaticExecutionEligible).toBe(false);
  });

  it("distinguishes wallet unlimited approvals from inert manager-internal approval evidence", async () => {
    const max = ((1n << 256n) - 1n).toString();
    stubExecutionRpc({
      traceRoot: successfulTrace({
        managerCalls: [
          {
            type: "CALL",
            from: MANAGER,
            to: PHIAT_SHADOW_BUY_TOKEN_IN,
            input: erc20ApproveData(PROTOCOL, max),
            value: "0x0",
            gasUsed: "0x1234",
          },
        ],
      }),
    });
    const trustedInternal = await certifyPiteasExecutionLayer(
      baseConfig,
      executionCertArgs({
        approvedTrustRecords: [
          executionTrustRecord(MANAGER, "SwapManager", keccak256(DIRECT_MANAGER_CODE), [
            PITEAS_SWAP_MANAGER_SELECTOR,
          ]),
          executionTrustRecord(PROTOCOL, "ProtocolRouter", keccak256(DIRECT_PROTOCOL_CODE), [
            "0xabcdef01",
            "0x095ea7b3",
          ]),
        ],
      }),
    );

    expect(trustedInternal.internalApprovals).toHaveLength(1);
    expect(trustedInternal.internalApprovals[0]).toMatchObject({
      ownerContext: "swap_manager",
      walletApproval: false,
      managerInternalApproval: true,
      approvedByPolicy: false,
    });

    stubExecutionRpc({
      traceRoot: successfulTrace({
        managerCalls: [
          {
            type: "CALL",
            from: WALLET,
            to: PHIAT_SHADOW_BUY_TOKEN_IN,
            input: erc20ApproveData(PROTOCOL, max),
            value: "0x0",
            gasUsed: "0x1234",
          },
        ],
      }),
    });
    const walletUnlimited = await certifyPiteasExecutionLayer(baseConfig, executionCertArgs());

    expect(walletUnlimited.internalApprovals[0]).toMatchObject({
      ownerContext: "wallet",
      walletApproval: true,
      managerInternalApproval: false,
      approvedByPolicy: false,
    });
    expect(walletUnlimited.unresolvedTargets).toContain("wallet_unlimited_or_unapproved_approval");
    expect(walletUnlimited.automaticExecutionEligible).toBe(false);
  });

  it("keeps automatic execution disabled until every manager trust gate passes", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        certifyExecutionLayer: executionLayer({
          swapManagerIntegrity: {
            ...resolvedExecutionLayer().swapManagerIntegrity,
            trusted: false,
            operatorApprovalRequired: true,
          },
          automaticExecutionEligible: true,
        }),
      }),
    );

    expect(result.decision).toBe("WOULD_BUY");
    expect(result.swapManagerIntegrity.operatorApprovalRequired).toBe(true);
    expect(result.automaticExecutionEligible).toBe(false);
  });

  it("rejects decoded recipient, token, input amount, native value, and min-output mismatches", async () => {
    const wrongTokenIn = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            srcToken: { address: OTHER, symbol: "OTHER", decimals: 6, chainId: 369 },
            tokenInParam: OTHER,
            methodParameters: {
              calldata: swapCalldata({ tokenIn: OTHER }),
              value: "0",
            },
          },
        }),
      }),
    );
    expect(wrongTokenIn.policyChecks.prepared_token_in?.status).toBe("fail");
    expect(wrongTokenIn.policyChecks.decoded_token_in?.status).toBe("fail");

    const wrongRecipient = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            methodParameters: { calldata: swapCalldata({ recipient: OTHER }), value: "0" },
          },
        }),
      }),
    );
    expect(wrongRecipient.policyChecks.decoded_recipient?.status).toBe("fail");

    const wrongToken = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            destToken: { address: OTHER, symbol: "OTHER", decimals: 18, chainId: 369 },
            tokenOutParam: OTHER,
            methodParameters: { calldata: swapCalldata({ tokenOut: OTHER }), value: "0" },
          },
        }),
      }),
    );
    expect(wrongToken.policyChecks.prepared_token_out?.status).toBe("fail");
    expect(wrongToken.policyChecks.decoded_token_out?.status).toBe("fail");

    const wrongAmount = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            methodParameters: { calldata: swapCalldata({ amountInRaw: "51000000" }), value: "0" },
          },
        }),
      }),
    );
    expect(wrongAmount.policyChecks.decoded_amount_in?.status).toBe("fail");

    const wrongValue = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: swapCalldata(), value: "0x1" } },
        }),
      }),
    );
    expect(wrongValue.policyChecks.native_value?.status).toBe("fail");

    const wrongMin = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            amountOutMin: CANDIDATE_MIN_RAW,
            methodParameters: {
              calldata: swapCalldata({ minOutputRaw: (BigInt(CANDIDATE_MIN_RAW) - 1n).toString() }),
              value: "0",
            },
          },
        }),
      }),
    );
    expect(wrongMin.policyChecks.decoded_minimum_output?.status).toBe("fail");
    expect(wrongMin.minimumOutputValidation?.relationship).toBe("CALLDATA_WEAKER");

    const stricterMin = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            amountOutMin: CANDIDATE_MIN_RAW,
            methodParameters: {
              calldata: swapCalldata({ minOutputRaw: (BigInt(CANDIDATE_MIN_RAW) + 1n).toString() }),
              value: "0",
            },
          },
        }),
      }),
    );
    expect(stricterMin.policyChecks.decoded_minimum_output?.status).toBe("pass");
    expect(stricterMin.policyChecks.decoded_minimum_output_stricter?.status).toBe("warning");
    expect(stricterMin.minimumOutputValidation?.relationship).toBe("CALLDATA_STRICTER");
    expect(stricterMin.reasons.map((reason) => reason.code)).not.toContain("DECODED_MINIMUM_OUTPUT_MISMATCH");

  });

  it("evaluates minimum-output relationships using bigint-only comparisons", () => {
    const quote = quoteData({
      outputRaw: "123456789012345678901234567890",
      minRaw: "123456789012345678901234567880",
    });
    const exact = decodeShadowBuyCalldata(
      swapCalldata({ outputRaw: quote.amountOut, minOutputRaw: quote.amountOutMin }),
    );
    const exactValidation = evaluateMinimumOutputValidation({ quote, decodedIntent: exact });
    expect(exactValidation.relationship).toBe("EXACT_MATCH");
    expect(exactValidation.validationStatus).toBe("PASSED");
    expect(exactValidation.sourceForEachValue.methodParametersMinimumOutputRaw).toContain(
      "Detail.destMinAmount",
    );

    const stricter = decodeShadowBuyCalldata(
      swapCalldata({
        outputRaw: quote.amountOut,
        minOutputRaw: "123456789012345678901234567881",
      }),
    );
    expect(evaluateMinimumOutputValidation({ quote, decodedIntent: stricter }).relationship).toBe(
      "CALLDATA_STRICTER",
    );

    const weaker = decodeShadowBuyCalldata(
      swapCalldata({
        outputRaw: quote.amountOut,
        minOutputRaw: "123456789012345678901234567879",
      }),
    );
    expect(evaluateMinimumOutputValidation({ quote, decodedIntent: weaker }).relationship).toBe(
      "CALLDATA_WEAKER",
    );

    const wrongApiField = evaluateMinimumOutputValidation({
      quote: { ...quote, amountOutMin: quote.amountOut },
      decodedIntent: exact,
    });
    expect(wrongApiField.relationship).toBe("CALLDATA_WEAKER");

    const wrongTupleField = evaluateMinimumOutputValidation({
      quote,
      decodedIntent: { ...exact, minimumOutputRaw: exact.amountInRaw },
    });
    expect(wrongTupleField.relationship).toBe("CALLDATA_WEAKER");

    const unresolved = evaluateMinimumOutputValidation({
      quote: { ...quote, amountOutMin: undefined },
      decodedIntent: exact,
    });
    expect(unresolved.relationship).toBe("SEMANTICS_UNRESOLVED");
    expect(unresolved.validationStatus).toBe("FAILED");
  });

  it("decodes the verified Piteas swap selector, tuple, and route envelope", () => {
    const payload = routePayloadWithAddresses(POOL);
    const calldata = swapCalldata({ routePayloads: [payload] });
    const decoded = decodeShadowBuyCalldata(calldata);

    expect(toFunctionSelector(PITEAS_SWAP_CANONICAL_SIGNATURE)).toBe(PITEAS_SWAP_SELECTOR);
    expect(calldata.slice(0, 10)).toBe(PITEAS_SWAP_SELECTOR);
    expect(decoded.decodable).toBe(true);
    expect(decoded.canonicalFunction).toBe(PITEAS_SWAP_CANONICAL_SIGNATURE);
    expect(decoded.selector).toBe("0x8218b58f");
    expect(decoded.tokenIn?.toLowerCase()).toBe(PHIAT_SHADOW_BUY_TOKEN_IN.toLowerCase());
    expect(decoded.tokenOut?.toLowerCase()).toBe(PHIAT_SHADOW_BUY_TOKEN_OUT.toLowerCase());
    expect(decoded.amountInRaw).toBe(AMOUNT_50_RAW);
    expect(decoded.minimumOutputRaw).toBe(CANDIDATE_MIN_RAW);
    expect(decoded.recipient?.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(decoded.deadline).toBe(TEST_DEADLINE_SECONDS.toString());
    expect(decoded.nativeValueWei).toBe("0");
    expect(decoded.permitDataPresent).toBe(false);
    expect(decoded.routeData?.decodable).toBe(true);
    expect(decoded.routeData?.destinationToken?.toLowerCase()).toBe(PHIAT_SHADOW_BUY_TOKEN_OUT.toLowerCase());
    expect(decoded.routeExpectedOutputRaw).toBe(CANDIDATE_OUTPUT_RAW);
    expect(decoded.routeDataFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(decoded.calldataFingerprint).toMatch(/^0x[a-f0-9]{64}$/);
    expect(decoded.routeData?.embeddedAddresses.map((address) => address.toLowerCase())).toContain(
      POOL.toLowerCase(),
    );
    expect(decoded.executionTargets).toEqual([]);
    expect(decoded.unresolvedExecutionTargets).toEqual([]);
  });

  it("rejects unknown selectors, malformed calldata, and unresolved execution targets", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: "0x12345678", value: "0" } },
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.calldata_decodable?.status).toBe("fail");
    expect(result.policyChecks.execution_targets_resolved?.status).toBe("fail");
    expect(result.executionTargets.unresolvedExecutionTargets.length).toBeGreaterThan(0);

    const malformed = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: "0x8218b58f1234", value: "0" } },
        }),
      }),
    );
    expect(malformed.decision).toBe("REJECT");
    expect(malformed.policyChecks.calldata_decodable?.status).toBe("fail");
    expect(reasonCodes(malformed)).toContain("CALLDATA_NOT_DECODABLE");

    const unresolved = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: {
            methodParameters: {
              calldata: swapCalldata({ routePayloads: [routePayloadWithAddresses(POOL)] }),
              value: "0",
            },
          },
        }),
        certifyExecutionLayer: executionLayer({
          executionGraphStatus: "UNRESOLVED",
          automaticExecutionEligible: false,
          failureCodes: ["EXECUTION_GRAPH_UNRESOLVED"],
          validationErrors: ["Full state-changing execution graph is not resolved."],
          unresolvedTargets: ["protocol_target_unresolved"],
        }),
      }),
    );
    expect(unresolved.decision).toBe("REJECT");
    expect(unresolved.primaryDecisionClass).toBe("TRANSACTION_INTEGRITY_REJECT");
    expect(unresolved.policyChecks.execution_layer_execution_graph_unresolved?.status).toBe("fail");
    expect(reasonCodes(unresolved)).toContain("EXECUTION_GRAPH_UNRESOLVED");
    expect(unresolved.unresolvedTargets).toContain("protocol_target_unresolved");
    expect(unresolved.automaticExecutionEligible).toBe(false);
  });

  it("does not place the same certificate check in passed and failed checks", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: "0x12345678", value: "0" } },
        }),
      }),
    );
    const failedCodes = new Set(result.failedChecks.map((check) => check.code));

    expect(result.passedChecks.some((code) => failedCodes.has(code))).toBe(false);
    expect(result.passedChecks).not.toContain("CALLDATA_NOT_DECODABLE");
    expect(result.passedChecks).not.toContain("CALLDATA_SELECTOR_NOT_ALLOWLISTED");
    expect(result.failedChecks.map((check) => check.code)).toContain("CALLDATA_NOT_DECODABLE");
  });

  it("keeps transaction-integrity rejection primary over insufficient funds", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getInputBalance: vi.fn(async () => "0"),
        getNativeBalanceWei: vi.fn(async () => "1"),
        getPiteasQuote: defaultQuoteMock({
          candidate: { methodParameters: { calldata: "0x12345678", value: "0" } },
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.primaryDecisionClass).toBe("TRANSACTION_INTEGRITY_REJECT");
    expect(result.decisionClass).toBe("TRANSACTION_INTEGRITY_REJECT");
    expect(result.secondaryDecisionClasses).toContain("INSUFFICIENT_FUNDS");
    expect(result.transactionIntegrityDecisionReached).toBe(true);
    expect(reasonCodes(result)).toContain("INSUFFICIENT_INPUT_BALANCE");
    expect(result.automaticExecutionEligible).toBe(false);
  });

  it("reports gas economics without rejecting when USD gas value is unavailable", async () => {
    const noUsd = await buildPhiatShadowBuy(baseConfig, baseInput(), deps());
    expect(noUsd.decision).toBe("WOULD_BUY");
    expect(noUsd.gasPolicy.estimatedGasCostPls).toBe("0.00025");
    expect(noUsd.gasPolicy.safetyAdjustedGasCostPls).toBe("0.0003125");
    expect(noUsd.gasPolicy.estimatedGasCostUsd).toBeNull();
    expect(noUsd.gasPolicy.gasCostAsPercentOfInputValue).toBeNull();

    const withUsd = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { gasUseEstimateUSD: 0.25 },
        }),
      }),
    );
    expect(withUsd.decision).toBe("WOULD_BUY");
    expect(withUsd.gasPolicy.estimatedGasCostUsd).toBe("0.25");
    expect(withUsd.gasPolicy.gasCostAsPercentOfInputValue).toBe(0.5);
  });

  it("rejects excessive slippage", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput({ maximumSlippagePercent: 0.5 }),
      deps({ getPiteasQuote: defaultQuoteMock({ candidate: { allowedSlippage: 5 } }) }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.policyChecks.slippage_policy?.status).toBe("fail");
  });

  it("rejects eth_call reverts and estimateGas failure", async () => {
    const reverted = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        ethCall: vi.fn(async () => {
          throw new Error("execution reverted");
        }) as never,
      }),
    );
    expect(reverted.policyChecks.eth_call?.status).toBe("fail");

    const gasFailed = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        estimateGas: vi.fn(async () => {
          throw new Error("cannot estimate");
        }) as never,
      }),
    );
    expect(gasFailed.policyChecks.estimate_gas?.status).toBe("fail");
  });

  it("rejects exact candidate amounts over the operational threshold", async () => {
    const result = await buildPhiatShadowBuy(
      baseConfig,
      baseInput(),
      deps({
        getPiteasQuote: defaultQuoteMock({
          candidate: { amountOut: "900000000000000000000", outputRaw: "900000000000000000000" } as never,
        }),
      }),
    );

    expect(result.decision).toBe("REJECT");
    expect(result.candidateDeteriorationPercent).toBeGreaterThan(2.5);
    expect(result.policyChecks.candidate_deterioration?.status).toBe("fail");
  });

  it("does not include signing, execution, wallet-secret, submission, broadcast, or disk-write paths", () => {
    const shadowDir = join(process.cwd(), "src/tools/analytics/phiat-shadow-buy");
    const source = [
      readFileSync(join(process.cwd(), "src/data/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/data/piteasRateLimit.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/phiatShadowBuy.ts"), "utf8"),
      ...readdirSync(shadowDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(join(shadowDir, name), "utf8")),
    ].join("\n");
    expect(source).toMatch(/getPiteasQuote/);
    expect(source).toMatch(/preparePiteasSwap/);
    expect(source).not.toMatch(/piteas_prepare_swap/);
    expect(source).not.toMatch(/from\s+["'].*wallet/);
    expect(source).not.toMatch(/sign_and_send|execute_agent_tx/);
    expect(source).not.toMatch(/sendTransaction|signTransaction|sendRawTransaction|broadcastTransaction|submitTransaction|executeSwap/);
    expect(source).not.toMatch(/privateKey|PRIVATE_KEY|MASTER_KEY|SEED_PHRASE|MNEMONIC|AGENT_WALLET/);
    expect(source).not.toMatch(/writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream/);
  });
});
