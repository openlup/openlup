import type { PromotionRow } from "../../../src/domains/promo/types.js";
import type {
  CommercePromoDataPort,
  PaidOrdersByMode,
  PromotionRedemptionCount,
} from "../../domains/commerce/promoDataPort.js";
import { promotionRedemptionMap } from "../../domains/commerce/promoDataPort.js";
import type {
  PromotionClaimSweepCounts,
  PromotionClaimSweepPort,
} from "../../domains/commerce/promotionClaimSweepPort.js";
import { parsePromotionClaimSweepCounts } from "../../domains/commerce/promotionClaimSweepPort.js";

interface PromoDataQuery extends PromiseLike<{ data: unknown; count: number | null; error: unknown }> {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): PromoDataQuery;
  eq(column: string, value: unknown): PromoDataQuery;
}

export interface PromoDataClient {
  from(table: string): PromoDataQuery;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export function createManagedCommercePromoDataPort(
  client: PromoDataClient,
): CommercePromoDataPort {
  return {
    async listActivePromotions(): Promise<PromotionRow[]> {
      const { data, error } = await client.from("promotions").select("*").eq("status", "active");
      if (error) throw error instanceof Error ? error : new Error("promotions_list_failed");
      return Array.isArray(data) ? (data as PromotionRow[]) : [];
    },
    async countPaidOrders(clientId: string): Promise<number> {
      const { count, error } = await client.from("commerce_orders")
        .select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("status", "paid");
      if (error) throw error instanceof Error ? error : new Error("paid_orders_count_failed");
      return typeof count === "number" ? count : 0;
    },
    async countPaidOrdersByMode(clientId: string): Promise<PaidOrdersByMode> {
      const countByMode = async (mode: string): Promise<number> => {
        const { count, error } = await client.from("commerce_orders")
          .select("id", { count: "exact", head: true }).eq("client_id", clientId)
          .eq("status", "paid").eq("mode", mode);
        if (error) throw error instanceof Error ? error : new Error("paid_orders_by_mode_count_failed");
        return typeof count === "number" ? count : 0;
      };
      const [oneTime, subscription] = await Promise.all([
        countByMode("one_time"), countByMode("subscription_cycle"),
      ]);
      return { oneTime, subscription };
    },
    async redemptionCounts(clientId: string | null): Promise<Map<string, PromotionRedemptionCount>> {
      const { data, error } = await client.rpc("commerce_promotion_redemption_counts", {
        p_client_id: clientId,
      });
      if (error) throw error instanceof Error ? error : new Error("redemption_counts_failed");
      return promotionRedemptionMap(data);
    },
    async deviceFirstOrderRedeemed(visitorId: string | null): Promise<boolean> {
      if (!visitorId?.trim()) return false;
      const { data, error } = await client.rpc("commerce_device_first_order_redeemed", {
        p_visitor_id: visitorId,
      });
      if (error) throw error instanceof Error ? error : new Error("device_first_order_check_failed");
      return data === true;
    },
  };
}

interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

export function createManagedPromotionClaimSweepPort(client: RpcClient): PromotionClaimSweepPort {
  return {
    async sweep(input): Promise<PromotionClaimSweepCounts> {
      const { data, error } = await client.rpc("commerce_sweep_stale_promotion_claims", {
        p_now: input.now,
        p_limit: input.limit,
        p_claim_lease_minutes: input.claimLeaseMinutes,
        p_grace_minutes: input.graceMinutes,
      });
      if (error) throw new Error(error.message ?? "promotion_claim_sweep_failed");
      return parsePromotionClaimSweepCounts(data);
    },
  };
}
