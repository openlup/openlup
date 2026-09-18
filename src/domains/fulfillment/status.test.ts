import { describe, expect, it } from "vitest";
import {
  dhlPublicTrackingUrl,
  fulfillmentDisplayStatus,
  mapDhlTrackingStatus,
  shipmentDate,
  shipmentSortKey,
} from "./status.js";

describe("fulfillment status mapping", () => {
  it("maps DHL delivered codes and descriptions", () => {
    expect(mapDhlTrackingStatus({ codes: ["DOR"], descriptions: [] })).toBe("delivered");
    expect(
      mapDhlTrackingStatus({
        codes: [],
        descriptions: ["Shipment delivered to recipient"],
      }),
    ).toBe("delivered");
  });

  it("keeps EDWP-only events from becoming in-transit or delivered", () => {
    expect(mapDhlTrackingStatus({ codes: ["EDWP"], descriptions: [] })).toBeNull();
  });

  it("maps DHL transit codes and descriptions", () => {
    expect(mapDhlTrackingStatus({ codes: ["DWP"], descriptions: [] })).toBe("in_transit");
    expect(
      mapDhlTrackingStatus({
        codes: [],
        descriptions: ["Przesylka odebrana od nadawcy"],
      }),
    ).toBe("in_transit");
  });

  it("maps legacy post-delivery tester statuses into delivered display", () => {
    expect(fulfillmentDisplayStatus("shipped")).toBe("shipped");
    expect(fulfillmentDisplayStatus("in_transit")).toBe("in_transit");
    expect(fulfillmentDisplayStatus("feedback_final")).toBe("delivered");
  });

  it("uses delivered_at for delivered display dates and status_updated_at otherwise", () => {
    expect(
      shipmentDate({
        status: "feedback_mid",
        statusUpdatedAt: "2026-05-30T10:00:00.000Z",
        deliveredAt: "2026-05-29T10:00:00.000Z",
      }),
    ).toBe("2026-05-29T10:00:00.000Z");

    expect(
      shipmentDate({
        status: "shipped",
        statusUpdatedAt: "2026-05-29T08:00:00.000Z",
        deliveredAt: null,
      }),
    ).toBe("2026-05-29T08:00:00.000Z");
  });

  it("sorts waiting shipments before delivered history", () => {
    const shipped = shipmentSortKey({
      status: "shipped",
      statusUpdatedAt: "2026-05-29T08:00:00.000Z",
      deliveredAt: null,
    });
    const delivered = shipmentSortKey({
      status: "delivered",
      statusUpdatedAt: "2026-05-29T09:00:00.000Z",
      deliveredAt: "2026-05-29T10:00:00.000Z",
    });

    expect(shipped).toBeLessThan(delivered);
  });

  it("builds DHL public tracking URLs", () => {
    expect(dhlPublicTrackingUrl("ABC 123")).toContain("tracking-id=ABC%20123");
  });
});
