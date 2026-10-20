import type {
  AdminPromotion,
  AdminPromotionUpdatePayload,
  AdminSubscriptionBandEntry,
} from "./contracts/index.js";

/**
 * @agent-domain-anti-reference
 * NOT THE REFERENCE — Promotions back-compat harness port (see
 * `adminPromotionsHandler.ts`); copy the catalog `@agent-domain-reference` port.
 *
 * Server-side data access for the admin discounts editor. The
 * host must provide promotion updates and atomic subscription-band writes.
 * Promotion-edit audit recording is required: an audit failure must surface
 * rather than silently turn into a successful unaudited edit.
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
  /** Flat shipping rate (gross minor units) from host settings; 0 when unset. */
  getShippingFlatMinor(): Promise<number>;
  /** Upsert the flat shipping rate (gross minor units). */
  setShippingFlatMinor(minor: number): Promise<void>;
  /**
   * Set a SKU's one-time (list) price across the active price list via the
   * host's append-only atomic writer. Subscription prices are untouched
   * (re-apply the band to recompute them). The writer records its own audit row.
   */
  setCatalogPrice(input: {
    actorId: string;
    sku: string;
    unitPriceMinor: number;
  }): Promise<void>;
  recordPromotionAudit(entry: AdminPromotionsAuditEntry): Promise<void>;
}
