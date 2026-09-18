import {
  DEFAULT_CONFIGURATOR_OFFER_LAYOUT,
  isConfiguratorOfferLayout,
  type ConfiguratorOfferLayout,
} from "../../../src/domains/commerce/offerLayoutContracts.js";
import type {
  CommerceOfferLayoutSettingsPort,
  CommerceSettingsPort,
} from "../../domains/commerce/commerceSettingsPort.js";

/**
 * The `value_text` lane of the same table, deliberately a second capability and
 * deliberately declared here rather than in `commerceSettingsPort.ts`.
 *
 * `CommerceSettingsPort` is implemented structurally by the quote/checkout money
 * path (`server/bff/commerce/quote-batch.ts` memoizes it, two suites fake it
 * inline), so widening that interface would drag an unrelated read into pricing.
 * Keeping the new capability beside its only implementation leaves that contract
 * untouched; a consumer asks for exactly the lane it reads.
 */
interface SettingsQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): SettingsQuery;
  eq(column: string, value: unknown): SettingsQuery;
}

export interface CommerceSettingsSupabaseClient {
  from(table: string): SettingsQuery;
}

const SHIPPING_FLAT_KEY = "shipping_flat_minor";
const OFFER_LAYOUT_KEY = "configurator_offer_layout";

export function createSupabaseCommerceSettingsPort(
  client: CommerceSettingsSupabaseClient,
): CommerceSettingsPort & CommerceOfferLayoutSettingsPort {
  return {
    async getShippingFlatMinor(): Promise<number> {
      const { data, error } = await client
        .from("commerce_settings")
        .select("value_minor")
        .eq("key", SHIPPING_FLAT_KEY);
      if (error) throw error instanceof Error ? error : new Error("shipping_rate_read_failed");
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const value = rows[0]?.value_minor;
      return typeof value === "number" && value >= 0 ? value : 0;
    },
    async getConfiguratorOfferLayout(): Promise<ConfiguratorOfferLayout> {
      const { data, error } = await client
        .from("commerce_settings")
        .select("value_text")
        .eq("key", OFFER_LAYOUT_KEY);
      // A real query failure is the only case that rejects: the caller maps it to
      // 503 rather than silently re-merchandising. Absent, NULL, or unrecognized
      // stored values are ordinary "not configured" and fall back to the default.
      if (error) throw error instanceof Error ? error : new Error("offer_layout_read_failed");
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const value = rows[0]?.value_text;
      return isConfiguratorOfferLayout(value)
        ? value
        : DEFAULT_CONFIGURATOR_OFFER_LAYOUT;
    },
  };
}
