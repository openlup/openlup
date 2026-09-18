import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIGURATOR_OFFER_LAYOUT } from "../../../src/domains/commerce/offerLayoutContracts.js";
import { createPostgresCommerceSettingsPort } from "./commerceSettings.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

describe("Postgres commerce settings adapter", () => {
  it("reads both settings and preserves their fail-open defaults", async () => {
    const values = new Map<string, Record<string, unknown>>([
      ["shipping_flat_minor", { value_minor: 1490, value_text: null }],
      ["configurator_offer_layout", { value_minor: null, value_text: "invalid" }],
    ]);
    const executor: PgQueryExecutor = {
      async query(text, parameters = []) {
        expect(text).toContain("WHERE key = $1");
        return { rows: values.has(String(parameters[0])) ? [values.get(String(parameters[0]))!] : [] };
      },
    };
    const port = createPostgresCommerceSettingsPort(executor);

    expect(await port.getShippingFlatMinor()).toBe(1490);
    expect(await port.getConfiguratorOfferLayout()).toBe(DEFAULT_CONFIGURATOR_OFFER_LAYOUT);
  });
});
