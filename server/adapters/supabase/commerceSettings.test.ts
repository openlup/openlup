import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIGURATOR_OFFER_LAYOUT } from "../../../src/domains/commerce/offerLayoutContracts.js";
import {
  createSupabaseCommerceSettingsPort as createCommerceSettingsPort,
  type CommerceSettingsSupabaseClient as CommerceSettingsClient,
} from "./commerceSettings.js";

function client(result: { data: unknown; error: unknown }): {
  client: CommerceSettingsClient;
  calls: Array<{ table: string; columns: string[]; keys: unknown[] }>;
} {
  const calls: Array<{ table: string; columns: string[]; keys: unknown[] }> = [];
  const settingsClient = {
    from(table: string) {
      const call = { table, columns: [] as string[], keys: [] as unknown[] };
      calls.push(call);
      const query = {
        select(columns: string) {
          call.columns.push(columns);
          return query;
        },
        eq(_column: string, value: unknown) {
          call.keys.push(value);
          return query;
        },
        then<TResult>(
          onFulfilled: (value: { data: unknown; error: unknown }) => TResult,
        ): PromiseLike<TResult> {
          return Promise.resolve(result).then(onFulfilled);
        },
      };
      return query;
    },
  } as unknown as CommerceSettingsClient;
  return { client: settingsClient, calls };
}

describe("commerce settings port — configurator offer layout", () => {
  it("reads the stored layout from the text lane of its own key", async () => {
    const { client: settingsClient, calls } = client({
      data: [{ value_text: "starter_first" }],
      error: null,
    });

    await expect(
      createCommerceSettingsPort(settingsClient).getConfiguratorOfferLayout(),
    ).resolves.toBe("starter_first");
    expect(calls).toEqual([
      {
        table: "commerce_settings",
        columns: ["value_text"],
        keys: ["configurator_offer_layout"],
      },
    ]);
  });

  it("falls back to the default when the row is missing", async () => {
    const { client: settingsClient } = client({ data: [], error: null });

    await expect(
      createCommerceSettingsPort(settingsClient).getConfiguratorOfferLayout(),
    ).resolves.toBe(DEFAULT_CONFIGURATOR_OFFER_LAYOUT);
  });

  it("falls back to the default for a NULL text value", async () => {
    const { client: settingsClient } = client({
      data: [{ value_text: null }],
      error: null,
    });

    await expect(
      createCommerceSettingsPort(settingsClient).getConfiguratorOfferLayout(),
    ).resolves.toBe(DEFAULT_CONFIGURATOR_OFFER_LAYOUT);
  });

  it("falls back to the default for a value outside the vocabulary", async () => {
    const { client: settingsClient } = client({
      data: [{ value_text: "bundle_first" }],
      error: null,
    });

    await expect(
      createCommerceSettingsPort(settingsClient).getConfiguratorOfferLayout(),
    ).resolves.toBe(DEFAULT_CONFIGURATOR_OFFER_LAYOUT);
  });

  it("rejects on a real query failure instead of guessing a layout", async () => {
    const { client: settingsClient } = client({
      data: null,
      error: new Error("connection reset"),
    });

    await expect(
      createCommerceSettingsPort(settingsClient).getConfiguratorOfferLayout(),
    ).rejects.toThrow("connection reset");
  });

  it("leaves the shipping-rate numeric read on its own key and column", async () => {
    const { client: settingsClient, calls } = client({
      data: [{ value_minor: 1500 }],
      error: null,
    });

    await expect(
      createCommerceSettingsPort(settingsClient).getShippingFlatMinor(),
    ).resolves.toBe(1500);
    expect(calls).toEqual([
      {
        table: "commerce_settings",
        columns: ["value_minor"],
        keys: ["shipping_flat_minor"],
      },
    ]);
  });
});
