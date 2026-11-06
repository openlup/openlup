import type { PromotionRow } from "@openlup/core/promo";
import type {
  CommercePromoDataPort,
  PaidOrdersByMode,
  PromotionRedemptionCount,
} from "./promoDataPort.js";
import { promotionRedemptionMap } from "./promoDataPort.js";
import {
  parsePromotionClaimSweepCounts,
  type PromotionClaimSweepPort,
} from "./promotionClaimSweepPort.js";
import type { PgQueryExecutor } from "../data/index.js";

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

/** Trusted quote evidence only; never customer identity or access authority. */
export interface QuoteCustomerEligibilityResolution {
  clientId: string | null;
  source: "anonymous" | "resolved_client";
  matchKind: "exact" | "plus_normalized" | null;
}

function plusNormalize(email: string): string {
  const normalized = email.trim().toLowerCase(), at = normalized.lastIndexOf("@");
  return at <= 0 ? normalized : `${normalized.slice(0, at).replace(/\+.*/, "")}${normalized.slice(at)}`;
}

/** Exact first, then at most 25 oldest candidates; never changes stored contact. */
export function createPostgresQuoteCustomerEligibility(executor: PgQueryExecutor) {
  return {
    async resolve(email: string | null): Promise<QuoteCustomerEligibilityResolution> {
      const anonymous: QuoteCustomerEligibilityResolution = { clientId: null, source: "anonymous", matchKind: null };
      if (!email) return anonymous;
      const normalized = email.trim().toLowerCase();
      const exact = (await executor.query("SELECT id FROM public.clients WHERE email=$1 ORDER BY created_at LIMIT 1", [normalized])).rows[0];
      if (exact) return { clientId: String(exact.id), source: "resolved_client", matchKind: "exact" };
      const key = plusNormalize(normalized), at = key.lastIndexOf("@");
      if (at <= 0) return anonymous;
      const escape = (value: string) => value.replace(/[%_\\]/g, "\\$&");
      const rows = (await executor.query("SELECT id,email FROM public.clients WHERE email ILIKE $1 ORDER BY created_at LIMIT 25",
        [`${escape(key.slice(0, at))}%@${escape(key.slice(at + 1))}`])).rows;
      const match = rows.find(row => plusNormalize(String(row.email ?? "")) === key);
      return match ? { clientId: String(match.id), source: "resolved_client", matchKind: "plus_normalized" } : anonymous;
    },
    /** Final family check uses the same native paid-subscription facts as quotes. */
    async hasPaidSubscription(clientId: string | null): Promise<boolean> {
      if (clientId === null) return false;
      return scalar(await executor.query(`SELECT EXISTS (
        SELECT FROM public.clients purchaser JOIN public.clients family ON
          (family.id=purchaser.id OR regexp_replace(lower(btrim(family.email)), '\\+[^@]*@', '@') =
            regexp_replace(lower(btrim(purchaser.email)), '\\+[^@]*@', '@'))
        WHERE purchaser.id=$1::uuid
          AND (public.commerce_promotion_paid_order_counts(family.id)->>'subscription')::bigint > 0
      ) AS result`, [clientId])) === true;
    },
  };
}
