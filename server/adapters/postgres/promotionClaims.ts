import type { PromotionRow } from "../../../src/domains/promo/types.js";
import type {
  CommercePromoDataPort,
  PaidOrdersByMode,
  PromotionRedemptionCount,
} from "../../domains/commerce/promoDataPort.js";
import { promotionRedemptionMap } from "../../domains/commerce/promoDataPort.js";
import {
  parsePromotionClaimSweepCounts,
  type PromotionClaimSweepPort,
} from "../../domains/commerce/promotionClaimSweepPort.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const ACTIVE_SQL = "SELECT public.commerce_promotion_active_definitions() AS result";
const COUNTS_SQL = "SELECT public.commerce_promotion_paid_order_counts($1::uuid) AS result";
const REDEMPTIONS_SQL = "SELECT * FROM public.commerce_promotion_redemption_counts($1::uuid)";
const DEVICE_SQL = "SELECT public.commerce_promotion_device_first_order_redeemed($1) AS result";
const SWEEP_SQL = "SELECT public.commerce_sweep_stale_promotion_claims($1,$2,$3,$4) AS result";

export function createPostgresCommercePromoDataPort(executor: PgQueryExecutor): CommercePromoDataPort {
  return {
    async listActivePromotions(): Promise<PromotionRow[]> {
      const value = scalar(await executor.query(ACTIVE_SQL));
      if (!Array.isArray(value)) throw new Error("promotions_list_invalid_response");
      return value as PromotionRow[];
    },
    async countPaidOrders(clientId): Promise<number> {
      const counts = paidCounts(scalar(await executor.query(COUNTS_SQL, [clientId])));
      return counts.oneTime + counts.subscription;
    },
    async countPaidOrdersByMode(clientId): Promise<PaidOrdersByMode> {
      return paidCounts(scalar(await executor.query(COUNTS_SQL, [clientId])));
    },
    async redemptionCounts(clientId): Promise<Map<string, PromotionRedemptionCount>> {
      return promotionRedemptionMap((await executor.query(REDEMPTIONS_SQL, [clientId])).rows);
    },
    async deviceFirstOrderRedeemed(visitorId): Promise<boolean> {
      if (!visitorId?.trim()) return false;
      return scalar(await executor.query(DEVICE_SQL, [visitorId])) === true;
    },
  };
}

export function createPostgresPromotionClaimSweepPort(executor: PgQueryExecutor): PromotionClaimSweepPort {
  return {
    async sweep(input) {
      return parsePromotionClaimSweepCounts(scalar(await executor.query(SWEEP_SQL, [
        input.now, input.limit, input.claimLeaseMinutes, input.graceMinutes,
      ])));
    },
  };
}

function scalar(result: { rows: Record<string, unknown>[] }): unknown {
  if (result.rows.length !== 1 || !("result" in result.rows[0]!)) {
    throw new Error("promotion_claim_response_invalid");
  }
  return result.rows[0]!.result;
}

function paidCounts(value: unknown): PaidOrdersByMode {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const oneTime = Number(row.oneTime ?? -1);
  const subscription = Number(row.subscription ?? -1);
  if (!Number.isSafeInteger(oneTime) || oneTime < 0
    || !Number.isSafeInteger(subscription) || subscription < 0) {
    throw new Error("promotion_paid_order_counts_invalid_response");
  }
  return { oneTime, subscription };
}
