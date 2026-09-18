import { describe, expect, it } from "vitest";

import { serviceTierLabel } from "./deliveryMethodLabel";

// The mapper must never let a raw carrier enum/slug through: it either returns
// null (dropped segment), a known tier key, or the generic fallback key.
const t = (key: string) => key;

describe("serviceTierLabel", () => {
  it("returns null for an absent or blank code so the segment is dropped", () => {
    expect(serviceTierLabel(null, t)).toBeNull();
    expect(serviceTierLabel(undefined, t)).toBeNull();
    expect(serviceTierLabel("   ", t)).toBeNull();
  });

  it("maps known carrier service codes to their friendly tier label key", () => {
    expect(serviceTierLabel("DHL_COURIER_STANDARD", t)).toBe(
      "account:dashboard.ordersV2.serviceTier.dhl_courier_standard",
    );
    // Lowercase tracking-reference slug resolves to the same key.
    expect(serviceTierLabel("dpd_courier_standard", t)).toBe(
      "account:dashboard.ordersV2.serviceTier.dpd_courier_standard",
    );
    expect(serviceTierLabel("INPOST_LOCKER_STANDARD", t)).toBe(
      "account:dashboard.ordersV2.serviceTier.inpost_locker_standard",
    );
    expect(serviceTierLabel("INPOST_COURIER_STANDARD", t)).toBe(
      "account:dashboard.ordersV2.serviceTier.inpost_courier_standard",
    );
  });

  it("routes any unknown code through the generic fallback (never the raw code)", () => {
    const label = serviceTierLabel("GLS_COURIER_EXPRESS", t);
    expect(label).toBe("account:dashboard.ordersV2.serviceTier.fallback");
    expect(label).not.toMatch(/GLS|EXPRESS|_COURIER_/);
  });
});
