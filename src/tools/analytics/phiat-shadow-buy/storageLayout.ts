import { getAddress } from "viem";
import {
  PITEAS_CONTRACTS_REPOSITORY,
  PITEAS_CONTRACTS_SOURCE_COMMIT,
  PITEAS_ROUTER_COMPILER_VERSION,
  PITEAS_ROUTER_SOURCE_HASH,
  PITEAS_ROUTER_VERIFIED_SOURCE_FINGERPRINT,
} from "./constants.js";
import { fingerprint } from "./inputNormalization.js";
import type { SwapManagerAddressDecode, SwapManagerStorageLayout } from "./types.js";

export function deriveSwapManagerStorageLayout(): SwapManagerStorageLayout {
  const derivationEvidence = [
    "Verified PiteasRouter is Ownable, EthReceiver.",
    "OpenZeppelin Ownable declares address _owner before derived PiteasRouter fields.",
    "EthReceiver declares no storage variables.",
    "PiteasRouter declares bool status before address swapManager.",
    "Solidity packs status into the remaining bytes of slot 0 after Ownable._owner.",
    "Only 11 bytes remain in slot 0, so address swapManager starts at slot 1 offset 0.",
  ];
  return {
    status: "DERIVED",
    source: {
      repository: PITEAS_CONTRACTS_REPOSITORY,
      commit: PITEAS_CONTRACTS_SOURCE_COMMIT,
      routerSourceHash: PITEAS_ROUTER_SOURCE_HASH,
      verifiedSourceFingerprint: PITEAS_ROUTER_VERIFIED_SOURCE_FINGERPRINT,
    },
    compilerVersion: PITEAS_ROUTER_COMPILER_VERSION,
    contractName: "PiteasRouter",
    inheritanceOrder: ["Ownable", "EthReceiver", "PiteasRouter"],
    slot: "0x0000000000000000000000000000000000000000000000000000000000000001",
    offsetBytes: 0,
    widthBytes: 20,
    derivationEvidence,
    layoutFingerprint: fingerprint({
      sourceCommit: PITEAS_CONTRACTS_SOURCE_COMMIT,
      compilerVersion: PITEAS_ROUTER_COMPILER_VERSION,
      contractName: "PiteasRouter",
      inheritanceOrder: ["Ownable", "EthReceiver", "PiteasRouter"],
      slot: "1",
      offsetBytes: 0,
      widthBytes: 20,
      derivationEvidence,
    }),
  };
}

export function decodeAddressFromStorageWord(args: {
  storageWord: string;
  slot: string;
  offsetBytes: number;
  widthBytes: number;
}): SwapManagerAddressDecode {
  const { storageWord, slot, offsetBytes, widthBytes } = args;
  if (!/^0x[0-9a-fA-F]{64}$/.test(storageWord)) {
    return {
      ok: false,
      address: null,
      normalizedAddress: null,
      zeroAddress: false,
      slot,
      offsetBytes,
      widthBytes,
      error: "storage word must be exactly 32 bytes",
    };
  }
  if (!Number.isInteger(offsetBytes) || !Number.isInteger(widthBytes)) {
    return invalidRange(args, "offsetBytes and widthBytes must be integers");
  }
  if (offsetBytes < 0 || widthBytes < 0 || offsetBytes + widthBytes > 32) {
    return invalidRange(args, "storage byte range exceeds one 32-byte slot");
  }
  if (widthBytes !== 20) {
    return invalidRange(args, "address width must be exactly 20 bytes");
  }

  const bytes = storageWord.slice(2).match(/.{2}/g);
  if (!bytes || bytes.length !== 32) {
    return invalidRange(args, "storage word byte decoding failed");
  }
  const start = 32 - offsetBytes - widthBytes;
  const end = 32 - offsetBytes;
  const rawAddress = `0x${bytes.slice(start, end).join("")}`;
  const zeroAddress = /^0x0{40}$/i.test(rawAddress);
  try {
    const normalizedAddress = getAddress(rawAddress);
    return {
      ok: true,
      address: normalizedAddress,
      normalizedAddress,
      zeroAddress,
      slot,
      offsetBytes,
      widthBytes,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      address: null,
      normalizedAddress: null,
      zeroAddress,
      slot,
      offsetBytes,
      widthBytes,
      error: err instanceof Error ? err.message : "decoded address is invalid",
    };
  }
}

function invalidRange(
  args: { storageWord: string; slot: string; offsetBytes: number; widthBytes: number },
  error: string,
): SwapManagerAddressDecode {
  return {
    ok: false,
    address: null,
    normalizedAddress: null,
    zeroAddress: false,
    slot: args.slot,
    offsetBytes: args.offsetBytes,
    widthBytes: args.widthBytes,
    error,
  };
}
