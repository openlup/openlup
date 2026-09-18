import { describe, expect, it } from "vitest";

import type { SellableCatalogItem, SellableCatalogProfile } from "@/domains/catalog/contracts";
import {
  buildSubscribeEntryCommand,
  isContactComplete,
  subscribableOffers,
  SUBSCRIBE_ENTRY_CADENCE_DAYS,
  type SubscribeEntryContact,
} from "./subscribeEntryModel";

const profile: SellableCatalogProfile = {
  id: "example-store",
  brand: "Northstar Supply",
  country: "DE",
  currency: "EUR",
  locale: "en",
  timezone: "UTC",
};

const subscribable: SellableCatalogItem = {
  sku: "NORTHSTAR-REFILL-001",
  title: "Northstar Supply Refill",
  unitPrice: { amountMinor: 1490, currency: "EUR" },
  permittedPurchaseModes: ["one_time", "subscription"],
};

const oneTimeOnly: SellableCatalogItem = {
  sku: "NORTHSTAR-GIFT-001",
  title: "Northstar Supply Gift Box",
  unitPrice: { amountMinor: 4900, currency: "EUR" },
  permittedPurchaseModes: ["one_time"],
};

const contact: SubscribeEntryContact = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  phone: "600100200",
  street: "Analytical 1",
  postalCode: "10115",
  city: "Berlin",
};

const baseInput = {
  offers: [subscribable, oneTimeOnly],
  profile,
  selection: { sku: subscribable.sku, quantity: 2, cadenceDays: 30 },
  contact,
  idempotencyKey: "subscribe-entry-test-key-0001",
};

describe("subscribeEntryModel", () => {
  it("offers only what the deployment permits subscribing to", () => {
    expect(subscribableOffers([subscribable, oneTimeOnly])).toEqual([subscribable]);
    expect(subscribableOffers([oneTimeOnly])).toEqual([]);
  });

  it("builds a subscription command carrying the cadence and the offer's own currency", () => {
    const result = buildSubscribeEntryCommand(baseInput);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.command.mode).toBe("subscription");
    expect(result.command.cadenceDays).toBe(30);
    expect(result.command.currency).toBe("EUR");
    expect(result.command.lines).toEqual([{ sku: subscribable.sku, quantity: 2 }]);
    expect(result.command.shippingAddress.country).toBe("DE");
  });

  it("refuses an offer this deployment does not sell on a recurring basis", () => {
    const result = buildSubscribeEntryCommand({
      ...baseInput,
      selection: { ...baseInput.selection, sku: oneTimeOnly.sku },
    });

    expect(result).toEqual({ status: "refused", reason: "offer_not_subscribable" });
  });

  it("refuses when the deployment publishes nothing subscribable at all", () => {
    const result = buildSubscribeEntryCommand({ ...baseInput, offers: [oneTimeOnly] });

    expect(result).toEqual({ status: "refused", reason: "no_subscribable_offer" });
  });

  it("refuses an incomplete address rather than letting the BFF reject it", () => {
    const result = buildSubscribeEntryCommand({
      ...baseInput,
      contact: { ...contact, city: "  " },
    });

    expect(result).toEqual({ status: "refused", reason: "details_incomplete" });
    expect(isContactComplete({ ...contact, city: "  " })).toBe(false);
  });

  it("every offered cadence produces a command the published schema accepts", () => {
    for (const cadenceDays of SUBSCRIBE_ENTRY_CADENCE_DAYS) {
      const result = buildSubscribeEntryCommand({
        ...baseInput,
        selection: { ...baseInput.selection, cadenceDays },
      });
      expect(result.status, `cadence ${cadenceDays}`).toBe("ready");
    }
  });
});
