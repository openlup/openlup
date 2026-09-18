import { z } from "zod";
import type { OrderMoneyMismatchCode } from "../../../../src/domains/platform/orderMoneyReconciliationContracts.js";

const claimTransitionSchema = z.enum(["reserved", "redeemed", "released", "late_paid"]);
const promotionMoneyMismatchSchema = z.enum([
  "promotion_adjustments_invalid",
  "promotion_product_total",
  "promotion_shipping_total",
  "promotion_product_discount_bound",
  "promotion_shipping_discount_bound",
  "promotion_product_floor",
  "promotion_claim_ids",
]);

const promotionHealthRpcSchema = z.object({
  contractVersion: z.literal("promotion-health.v1"),
  measuredAt: z.iso.datetime({ offset: true }),
  windowFrom: z.iso.datetime({ offset: true }),
  staleBefore: z.iso.datetime({ offset: true }),
  aggregates: z.object({
    claims: z.object({
      reserved: z.number().int().nonnegative(),
      redeemed: z.number().int().nonnegative(),
      released: z.number().int().nonnegative(),
      activeCapacity: z.number().int().nonnegative(),
      staleReserved: z.number().int().nonnegative(),
      staleBlockingCapacity: z.number().int().nonnegative(),
    }).strict(),
    capacity: z.object({
      definition: z.literal("reserved_plus_redeemed"),
      configuredLimitCodes: z.number().int().nonnegative(),
      atLimitCodes: z.number().int().nonnegative(),
      overLimitCodes: z.number().int().nonnegative(),
    }).strict(),
    lifecycleMismatchCount: z.number().int().nonnegative(),
    missingClaimOrderCount: z.number().int().nonnegative(),
    orphanClaimCount: z.number().int().nonnegative(),
    promotionMoneyMismatchCount: z.number().int().nonnegative(),
  }).strict(),
  transitionCounts24h: z.record(claimTransitionSchema, z.number().int().nonnegative()),
  historyCoverage: z.literal("post_migration_only"),
  evidence: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("capacity_exceeded"),
      claimId: z.uuid().optional(),
      promotionCodeId: z.uuid(),
      orderId: z.uuid().optional(),
      scope: z.enum(["global", "customer"]),
      count: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      observedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    z.object({
      kind: z.enum(["lifecycle_mismatch", "orphan_claim"]),
      claimId: z.uuid(),
      promotionCodeId: z.uuid().optional(),
      orderId: z.uuid(),
      observedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    z.object({
      kind: z.literal("missing_claim"),
      orderId: z.uuid(),
      observedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    z.object({
      kind: z.enum(["stale_reserved", "late_paid"]),
      claimId: z.uuid(),
      promotionCodeId: z.uuid().optional(),
      orderId: z.uuid().optional(),
      blockingCapacity: z.boolean().optional(),
      observedAt: z.iso.datetime({ offset: true }),
    }).strict(),
  ])).max(100),
  moneyEvidence: z.array(z.object({
    orderId: z.uuid(),
    mismatchCodes: z.array(promotionMoneyMismatchSchema).min(1).max(7),
  }).strict()).max(100),
}).strict();

export type PromotionHealthRpcSnapshot = z.infer<typeof promotionHealthRpcSchema>;

type PromotionHealthRpcClient = {
  rpc: (
    name: "commerce_promotion_health_snapshot",
    args: {
      p_since: string;
      p_stale_before: string;
      p_evidence_limit: number;
      p_include_health: boolean;
    },
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export async function readPromotionHealthSnapshot(
  client: PromotionHealthRpcClient,
  now: Date,
  includeHealth: boolean,
): Promise<PromotionHealthRpcSnapshot> {
  const { data, error } = await client.rpc("commerce_promotion_health_snapshot", {
    p_since: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    p_stale_before: new Date(now.getTime() - 15 * 60 * 1_000).toISOString(),
    p_evidence_limit: 100,
    p_include_health: includeHealth,
  });
  if (error) throw new Error(`commerce_promotion_health_snapshot: ${error.message ?? "query failed"}`);
  const parsed = promotionHealthRpcSchema.safeParse(data);
  if (!parsed.success) throw new Error("commerce_promotion_health_snapshot: invalid response");
  return parsed.data;
}

export const PROMOTION_MONEY_MISMATCH_CODES = promotionMoneyMismatchSchema.options satisfies readonly OrderMoneyMismatchCode[];
