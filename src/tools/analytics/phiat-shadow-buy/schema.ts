import { z } from "zod";

export const phiatShadowBuyInputSchema = {
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Wallet address that would receive PHIAT. No private key is read."),
  amountInHuman: z
    .string()
    .min(1)
    .describe("eUSDC amount in human units, for example \"50\"."),
  analyticalThresholdPercent: z.number().finite().min(0).max(100).optional(),
  operationalThresholdPercent: z.number().finite().min(0).max(100).optional(),
  maximumReferenceDriftPercent: z.number().finite().min(0).max(100).optional(),
  maximumSlippagePercent: z.number().finite().min(0).max(100).optional(),
  maximumQuoteAgeMs: z.number().int().min(1_000).max(600_000).optional(),
  maximumGasPls: z.string().min(1).optional(),
  requireOperationalRecommendation: z.boolean().optional(),
  referenceAmountHuman: z.string().min(1).optional(),
  gasSafetyFactor: z.number().finite().min(1).max(10).optional(),
  approvedRouterCodeHashes: z
    .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/))
    .optional(),
};
