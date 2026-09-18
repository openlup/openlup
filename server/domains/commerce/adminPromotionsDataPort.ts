import type {
  AdminPromotion,
  AdminPromotionUpdatePayload,
  AdminSubscriptionBandEntry,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";

/**
 * @agent-domain-anti-reference
 * NOT THE REFERENCE — Promotions back-compat harness port (see
 * `adminPromotionsHandler.ts`); copy the catalog `@agent-domain-reference` port.
 *
 * Server-side data access for the admin discounts editor. Promotions are a
 * single-row service-role UPDATE; the subscription band is an atomic RPC. The
 * promotion-edit audit now goes through the non-repudiable
 * `record_admin_audit_event` fn and is a REQUIRED step (Wave 4.5) — no longer a
 * best-effort write that could silently vanish.
 */

export interface AdminPromotionsAuditEntry {
  actorId: string;
  actorEmail: string | null;
  action: "promo_update" | "promo_status_change" | "shipping_rate_change";
  promotionId: string;
  newValue: Record<string, unknown>;
}

export interface AdminPromotionsDataPort {
  listPromotions(): Promise<AdminPromotion[]>;
  updatePromotion(id: string, updates: AdminPromotionUpdatePayload): Promise<void>;
  listSubscriptionBand(): Promise<AdminSubscriptionBandEntry[]>;
  setSubscriptionBandPercent(
    percent: number,
  ): Promise<{ updatedSkuCount: number; appliedPercent: number }>;
  /** Flat shipping rate (gross minor units) from commerce_settings; 0 when unset. */
  getShippingFlatMinor(): Promise<number>;
  /** Upsert the flat shipping rate (gross minor units). */
  setShippingFlatMinor(minor: number): Promise<void>;
  /**
   * Set a SKU's one-time (list) price across the active PL/PLN list via the
   * append-only `admin_set_catalog_price` RPC. Subscription prices are untouched
   * (re-apply the band to recompute them). The RPC writes its own audit row.
   */
  setCatalogPrice(input: {
    actorId: string;
    sku: string;
    unitPriceMinor: number;
  }): Promise<void>;
  recordPromotionAudit(entry: AdminPromotionsAuditEntry): Promise<void>;
}
