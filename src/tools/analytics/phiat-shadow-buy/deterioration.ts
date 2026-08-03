import type { PiteasQuoteData } from "../../../data/index.js";
import { EUSDC_DECIMALS, PHIAT_DECIMALS } from "./constants.js";
import { formatScaledDecimal, stringToBigInt } from "./inputNormalization.js";

export function calculateReferenceDriftPercent(
  before: PiteasQuoteData,
  after: PiteasQuoteData,
): number | null {
  const beforePrice = averagePriceScaled(before);
  const afterPrice = averagePriceScaled(after);
  if (beforePrice === null || afterPrice === null) return null;
  const sum = beforePrice + afterPrice;
  if (sum <= 0n) return null;
  const diff = beforePrice > afterPrice ? beforePrice - afterPrice : afterPrice - beforePrice;
  return microPercentToNumber((diff * 200_000_000n) / sum);
}

export function calculateCandidateDeteriorationPercent(
  before: PiteasQuoteData,
  candidate: PiteasQuoteData,
  after: PiteasQuoteData,
): number | null {
  const beforePrice = averagePriceScaled(before);
  const candidatePrice = averagePriceScaled(candidate);
  const afterPrice = averagePriceScaled(after);
  if (beforePrice === null || candidatePrice === null || afterPrice === null) return null;
  const referenceAverage = (beforePrice + afterPrice) / 2n;
  if (referenceAverage <= 0n) return null;
  const signed = ((candidatePrice - referenceAverage) * 100_000_000n) / referenceAverage;
  return microPercentToNumber(signed);
}

export function averagePriceScaled(quote: PiteasQuoteData): bigint | null {
  const amountIn = stringToBigInt(quote.amountIn);
  const amountOut = stringToBigInt(quote.amountOut);
  if (amountIn === null || amountOut === null || amountOut <= 0n) return null;
  const scale = 10n ** 18n;
  const inputDecimals = 10n ** BigInt(EUSDC_DECIMALS);
  const outputDecimals = 10n ** BigInt(PHIAT_DECIMALS);
  return (amountIn * outputDecimals * scale) / (amountOut * inputDecimals);
}

export function averagePriceDecimal(quote: PiteasQuoteData): string | null {
  const scaled = averagePriceScaled(quote);
  return scaled === null ? null : formatScaledDecimal(scaled, 18);
}

function microPercentToNumber(value: bigint): number {
  return Number(value) / 1_000_000;
}
