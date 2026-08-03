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
  maximumBatchDurationMs: z.number().int().min(1_000).max(120_000).optional(),
  maximumGasPls: z.string().min(1).optional(),
  requireOperationalRecommendation: z.boolean().optional(),
  referenceAmountHuman: z.string().min(1).optional(),
  gasSafetyFactor: z.number().finite().min(1).max(10).optional(),
  approvedRouterCodeHashes: z
    .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/))
    .optional(),
  approvedRouterTrustRecords: z
    .array(
      z.object({
        router: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
        codeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        chainId: z.number().int().positive().optional(),
        implementationAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .nullable()
          .optional(),
        implementationCodeHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .nullable()
          .optional(),
        label: z.string().min(1).optional(),
      }),
    )
    .optional(),
  approvedExecutionTrustRecords: z
    .array(
      z.object({
        chainId: z.number().int().positive(),
        address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        role: z.enum([
          "PiteasRouter",
          "SwapManager",
          "ManagerImplementation",
          "DelegatecallTarget",
          "ProtocolRouter",
          "PoolFactory",
          "Pool",
          "Token",
        ]),
        runtimeCodeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        implementationAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .nullable()
          .optional(),
        implementationCodeHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .nullable()
          .optional(),
        sourceFingerprint: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .nullable()
          .optional(),
        approvedSelectors: z.array(z.string().regex(/^0x[a-fA-F0-9]{8}$/)),
        approvalEvidence: z.string().min(1),
        approvedAtBlock: z.string().regex(/^\d+$/).nullable().optional(),
        expiresAtBlockOrTime: z.string().min(1).nullable().optional(),
        operatorApproved: z.boolean(),
      }),
    )
    .optional(),
  signedExecutionTrustManifest: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .optional()
    .describe(
      "Externally signed execution trust manifest. Verification is read-only and never signs or submits a transaction.",
    ),
};
