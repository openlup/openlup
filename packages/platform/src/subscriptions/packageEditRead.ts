import type { PackageEditReadPort } from "./packageEditContracts.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** The same settings key, column and strict integer domain are used by the definer apply. */
export function createPostgresPackageEditReadPort(db: SubscriptionQueryExecutor): PackageEditReadPort {
  return {
    async readSubscription(id) {
      const row = (await db.query("SELECT cadence_days,composition_constraint,template_version FROM public.subscriptions WHERE id=$1::uuid", [id])).rows[0];
      if (!row) throw new Error("subscription_reprice_subscription_not_found");
      const version = Number(row.template_version);
      if (!Number.isInteger(version) || version < 1) throw new Error("subscription_reprice_invalid_template_version");
      return { cadenceDays: Number(row.cadence_days), templateVersion: version,
        compositionConstraint: row.composition_constraint == null ? null : subscriptionRecord(row.composition_constraint) };
    },
    async readLines(id) {
      const rows = (await db.query(`SELECT l.*,t.quantity*t.unit_amount_minor AS frozen_gross,t.quantity AS frozen_quantity,
        s.currency_code AS frozen_currency FROM public.subscription_lines l JOIN public.catalog_skus sku ON sku.id=l.variant_id
        LEFT JOIN LATERAL (SELECT t.* FROM public.subscription_renewal_term_lines t WHERE t.subscription_id=l.subscription_id AND t.sku=sku.sku
          AND t.quantity=l.quantity AND t.unit_amount_minor=l.unit_price_minor ORDER BY t.line_ordinal LIMIT 1) t ON true
        LEFT JOIN public.subscription_renewal_terms s ON s.subscription_id=l.subscription_id
        WHERE l.subscription_id=$1::uuid ORDER BY l.sort_order,l.variant_id`, [id])).rows;
      return rows.map(row => ({ lineId: String(row.id), variantId: String(row.variant_id), quantity: Number(row.quantity),
        sortOrder: Number(row.sort_order), isAddon: row.is_addon === true,
        ...(row.frozen_gross != null && Number.isSafeInteger(Number(row.frozen_gross)) && typeof row.frozen_currency === "string"
          ? { frozenLineSubtotalGross: { amountMinor: Number(row.frozen_gross), currency: row.frozen_currency } } : {}) }));
    },
    async readMinimumBaseUnits() {
      const raw = (await db.query("SELECT value_text FROM public.commerce_settings WHERE key='subscription_minimum_base_units'")).rows[0]?.value_text;
      if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2_147_483_647) {
        throw new Error("subscription_reprice_minimum_base_units_unavailable");
      }
      return Number(raw);
    },
  };
}
