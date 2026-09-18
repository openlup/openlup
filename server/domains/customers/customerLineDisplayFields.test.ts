import { describe, expect, it } from "vitest";
import {
  customerLineDisplayFields,
  resolveOrderLineProductSlug,
  resolveSubscriptionLineProductSlug,
} from "./customerLineDisplayFields.js";

describe("customerLineDisplayFields", () => {
  it("builds customer-safe display fields for known launch products", () => {
    expect(customerLineDisplayFields("venison")).toEqual({
      productSlug: "venison",
      flavourSlug: "venison",
      displayLabel: "Dziczyzna + EntoPro™",
      accentColor: "#8B1A4A",
    });
  });

  it("resolves subscription line product slug from catalog, metadata or labels", () => {
    expect(
      resolveSubscriptionLineProductSlug({
        skuProductSlug: "lamb",
        metadata: {},
        title: "Raw fallback",
        recipeName: null,
      }),
    ).toBe("lamb");
    expect(
      resolveSubscriptionLineProductSlug({
        skuProductSlug: null,
        metadata: { flavorSlug: "venison" },
        title: null,
        recipeName: null,
      }),
    ).toBe("venison");
  });

  it("resolves order line product slug from immutable snapshots", () => {
    const firstText = (row: Record<string, unknown>, keys: string[]) => {
      const value = keys.map((key) => row[key]).find((candidate) => typeof candidate === "string");
      return typeof value === "string" ? value : null;
    };

    expect(
      resolveOrderLineProductSlug({
        snapshot: { productSlug: "venison" },
        variant: {},
        title: "Fallback",
        recipeName: null,
        firstText,
      }),
    ).toBe("venison");
  });
});
