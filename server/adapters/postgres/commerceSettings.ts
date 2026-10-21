import type { ShippingRateDataPort } from "@openlup/platform/shipping";
import type { PostgresShippingRateTransactionLane } from "./dataGateway.js";
import {
  DEFAULT_CONFIGURATOR_OFFER_LAYOUT,
  isConfiguratorOfferLayout,
  type ConfiguratorOfferLayout,
} from "../../../src/domains/commerce/offerLayoutContracts.js";
import type {
  CommerceOfferLayoutSettingsPort,
  CommerceSettingsPort,
} from "../../domains/commerce/commerceSettingsPort.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const SHIPPING_FLAT_KEY = "shipping_flat_minor";
const OFFER_LAYOUT_KEY = "configurator_offer_layout";
const SETTING_SQL = `
  SELECT value_minor, value_text
  FROM public.commerce_settings
  WHERE key = $1`;

interface SettingRow {
  value_minor: number | null;
  value_text: string | null;
}

export function createPostgresCommerceSettingsPort(
  executor: PgQueryExecutor,
): CommerceSettingsPort & CommerceOfferLayoutSettingsPort {
  async function read(key: string): Promise<SettingRow | null> {
    const result = await executor.query(SETTING_SQL, [key]);
    return (result.rows[0] as unknown as SettingRow | undefined) ?? null;
  }

  return {
    async getShippingFlatMinor(): Promise<number> {
      const value = (await read(SHIPPING_FLAT_KEY))?.value_minor;
      return typeof value === "number" && value >= 0 ? value : 0;
    },

    async getConfiguratorOfferLayout(): Promise<ConfiguratorOfferLayout> {
      const value = (await read(OFFER_LAYOUT_KEY))?.value_text;
      return isConfiguratorOfferLayout(value)
        ? value
        : DEFAULT_CONFIGURATOR_OFFER_LAYOUT;
    },
  };
}

/** Fixed-key native rate capability; audit has no portable store. */
export function createPostgresShippingRateDataPort(
  transactions: PostgresShippingRateTransactionLane,
): ShippingRateDataPort {
  return {
    getShippingFlatMinor: () => transactions.run(async gateway => {
      const executor = gateway as PgQueryExecutor;
      const result = await executor.query(
        "SELECT value_minor FROM public.commerce_settings WHERE key = $1",
        [SHIPPING_FLAT_KEY],
      );
      if (result.rows.length !== 1) throw new Error("shipping_native_flat_rate_row_required");
      return Number(result.rows[0].value_minor);
    }),
    setShippingFlatMinor: minor => transactions.run(async gateway => {
      const executor = gateway as PgQueryExecutor;
      const result = await executor.query(
        "UPDATE public.commerce_settings SET value_minor = $1, updated_at = now() WHERE key = $2 RETURNING key",
        [minor, SHIPPING_FLAT_KEY],
      );
      if (result.rows.length !== 1) throw new Error("shipping_native_flat_rate_row_required");
    }),
    async recordPromotionAudit() {
      throw new Error("shipping_native_flat_rate_audit_unsupported");
    },
  };
}
