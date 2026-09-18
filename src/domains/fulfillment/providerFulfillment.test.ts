import { describe, expect, it } from "vitest";
import {
  providerStatusConsumesInventory,
  PROVIDER_FULFILLMENT_TRACKING_STATUSES,
} from "./providerFulfillment.js";

describe("provider fulfillment boundary contracts", () => {
  it("models provider visibility statuses without making stock truth provider-owned", () => {
    expect(PROVIDER_FULFILLMENT_TRACKING_STATUSES).toContain("provider_received");
    expect(PROVIDER_FULFILLMENT_TRACKING_STATUSES).toContain("delivered");
    expect(providerStatusConsumesInventory("label_created")).toBe(false);
    expect(providerStatusConsumesInventory("in_transit")).toBe(false);
    expect(providerStatusConsumesInventory("handed_over")).toBe(true);
  });
});
