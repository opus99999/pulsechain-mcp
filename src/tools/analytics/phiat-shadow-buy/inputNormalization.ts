import { createHash } from "node:crypto";
import { formatUnits } from "viem";
import { hexOrDecToDecimalWei, type PiteasQuoteData } from "../../../data/index.js";

export function parseHumanUnitsStrict(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  const rawText = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  try {
    return BigInt(rawText === "" ? "0" : rawText);
  } catch {
    return null;
  }
}

export function formatRawToken(raw: string | null | undefined, decimals: number): string | null {
  const value = stringToBigInt(raw);
  return value === null ? null : formatUnits(value, decimals);
}

export function formatScaledDecimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function stringToBigInt(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function isPositiveIntegerString(value: string | null | undefined): boolean {
  const parsed = stringToBigInt(value);
  return parsed !== null && parsed > 0n;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

export function quoteFingerprint(data: PiteasQuoteData): string {
  return data.responseFingerprint ?? fingerprint({
    amountIn: data.amountIn,
    amountOut: data.amountOut,
    amountOutMin: data.amountOutMin ?? null,
    methodParameters: data.methodParameters,
    routeSignature: data.route?.signature ?? null,
  });
}

export function fingerprint(value: unknown): string {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 9_999_999_999 ? numeric : numeric * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonEmptyDifferent(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

export function selectorOf(calldata: string | null | undefined): string | null {
  return typeof calldata === "string" && /^0x[a-fA-F0-9]{8}/.test(calldata)
    ? calldata.slice(0, 10)
    : null;
}

export function safeWei(value: string | null | undefined): string | null {
  try {
    return value ? hexOrDecToDecimalWei(value) : null;
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
