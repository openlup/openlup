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
