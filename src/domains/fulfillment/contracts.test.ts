import { describe, expect, it } from "vitest";
import {
  providerOwnsDeliveredNotification,
  adminLowStockEvidenceRequestSchema,
  adminLowStockEvidenceResponseSchema,
} from "./contracts";
import {
  adminShipmentsOverviewRequestSchema,
  adminShipmentsOverviewResponseSchema,
  bookDhlCourierRequestSchema,
  bookDhlCourierResponseSchema,
  clearDhlShipmentStateRequestSchema,
  clearDhlShipmentStateResponseSchema,
  cleanupDhlShipmentRequestSchema,
  cleanupDhlShipmentResponseSchema,
  createDhlShipmentRequestSchema,
  createDhlShipmentResponseSchema,
  getDhlLabelRequestSchema,
  getDhlLabelResponseSchema,
  mergeDhlLabelsRequestSchema,
  mergeDhlLabelsResponseSchema,
  repairDhlCourierPickupRequestSchema,
  repairDhlCourierPickupResponseSchema,
  shipmentStatusReadRequestSchema,
  shipmentStatusReadResponseSchema,
} from "./contracts.js";

describe("fulfillment contracts", () => {
  it("validates safe shipment status read requests", () => {
    expect(
      shipmentStatusReadRequestSchema.parse({ trackingNumber: "TRK-1" }),
    ).toEqual({ trackingNumber: "TRK-1" });
  });

  it("rejects empty shipment status read requests", () => {
    expect(shipmentStatusReadRequestSchema.safeParse({}).success).toBe(false);
  });

  it("validates shipment status read responses", () => {
    const parsed = shipmentStatusReadResponseSchema.parse({
      shipment: {
        id: "legacy:testers:tester-1:shipment",
        provider: "dhl",
        status: "in_transit",
        trackingNumber: "TRK-1",
        trackingUrl: "https://www.dhl.com/pl-pl/home/tracking/tracking-parcel.html?tracking-id=TRK-1",
        statusUpdatedAt: "2026-05-29T10:00:00.000Z",
        deliveredAt: null,
      },
    });

    expect(parsed.shipment.provider).toBe("dhl");
  });

  it("accepts Supabase UTC offset timestamps in shipment status responses", () => {
    const parsed = shipmentStatusReadResponseSchema.parse({
      shipment: {
        id: "legacy:testers:tester-1:shipment",
        provider: "dhl",
        status: "delivered",
        trackingNumber: "TRK-1",
        trackingUrl: "https://www.dhl.com/pl-pl/home/tracking/tracking-parcel.html?tracking-id=TRK-1",
        statusUpdatedAt: "2026-05-29T10:00:00+00:00",
        deliveredAt: "2026-05-30T10:00:00+00:00",
      },
    });

    expect(parsed.shipment.deliveredAt).toBe("2026-05-30T10:00:00+00:00");
  });

  it("validates DHL cleanup contracts", () => {
    expect(
      cleanupDhlShipmentRequestSchema.parse({ trackingNumber: " TRACK-1 " }),
    ).toEqual({ trackingNumber: "TRACK-1" });

    expect(
      cleanupDhlShipmentResponseSchema.parse({
        dhlDeleted: false,
        dhlError: "not found",
        labelDeleted: true,
        canProceed: true,
      }).canProceed,
    ).toBe(true);
    expect(clearDhlShipmentStateRequestSchema.parse({ testerId: " tester-1 " })).toEqual({
      testerId: "tester-1",
    });
    expect(
      clearDhlShipmentStateResponseSchema.parse({
        testerId: "tester-1",
        cleared: true,
      }).cleared,
    ).toBe(true);
  });

  it("validates DHL shipment action contracts", () => {
    expect(createDhlShipmentRequestSchema.parse({ testerId: " tester-1 " })).toEqual({
      testerId: "tester-1",
      skipStatusChange: true,
    });
    expect(
      createDhlShipmentResponseSchema.parse({
        trackingNumber: "TRK-1",
        trackingUrl: "https://dhl.example/TRK-1",
        labelUrl: null,
        dhlShipmentId: "SHIP-1",
        dhlShipmentDate: "2026-04-29",
      }).trackingNumber,
    ).toBe("TRK-1");
    expect(getDhlLabelRequestSchema.parse({ testerId: " tester-1 " })).toEqual({
      testerId: "tester-1",
    });
    expect(getDhlLabelResponseSchema.parse({ labelUrl: "https://cdn.example/TRK-1.pdf" }).labelUrl)
      .toBe("https://cdn.example/TRK-1.pdf");
    expect(mergeDhlLabelsRequestSchema.parse({ testerIds: [" tester-1 "] })).toEqual({
      testerIds: ["tester-1"],
    });
    expect(mergeDhlLabelsResponseSchema.parse({ pdfBase64: "PDFDATA", labelCount: 1 }).labelCount)
      .toBe(1);
    expect(
      bookDhlCourierRequestSchema.parse({
        pickupDate: "2026-04-29",
        pickupTimeFrom: "10:00",
        pickupTimeTo: "16:00",
        testerIds: [" tester-1 "],
      }),
    ).toEqual({
      pickupDate: "2026-04-29",
      pickupTimeFrom: "10:00",
      pickupTimeTo: "16:00",
      testerIds: ["tester-1"],
    });
    expect(
      bookDhlCourierResponseSchema.parse({
        pickupDate: "2026-04-29",
        pickupTime: "10:00-16:00",
        shipmentsCount: 1,
        courierOrderId: "ORDER-1",
      }).shipmentsCount,
    ).toBe(1);
    expect(
      repairDhlCourierPickupRequestSchema.parse({
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        mode: "dry_run",
        expectedCourierOrderId: "877230626WWW",
        expectedShipmentCount: 38,
      }),
    ).toEqual({
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      mode: "dry_run",
      sendEmails: true,
      expectedCourierOrderId: "877230626WWW",
      expectedShipmentCount: 38,
    });
    expect(
      repairDhlCourierPickupResponseSchema.parse({
        mode: "commit",
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        pickupStatus: "succeeded",
        courierOrderId: "877230626WWW",
        recordedShipmentsCount: 38,
        linkedShipmentsCount: 38,
        expectedShipmentsCount: 38,
        canCommit: true,
        committed: true,
        alreadyRepaired: false,
        testerStatuses: [{
          testerId: "tester-1",
          trackingNumber: "30701335502",
          dhlShipmentId: "30701335502",
          status: "packing",
          emailStatus: null,
          emailAlreadySent: false,
          willRequestEmail: true,
        }],
        emailDedupPreview: { sendEmails: true, alreadySentCount: 0, requestCount: 1 },
      }).committed,
    ).toBe(true);
  });

  it("validates admin shipments overview contracts", () => {
    expect(adminShipmentsOverviewRequestSchema.parse({})).toEqual({ shippedFilter: "7d" });
    expect(adminShipmentsOverviewRequestSchema.parse({ shippedFilter: "all" }).shippedFilter)
      .toBe("all");

    const parsed = adminShipmentsOverviewResponseSchema.parse({
      approved: [{
        id: "a1",
        first_name: "Jan",
        last_name: "Kowalski",
        city: " Warszawa ",
        postal_code: "00-001",
        dog_weight_kg: 12,
        cat_weight_kg: null,
        pet_type: "dog",
      }],
      packing: [{
        id: "p1",
        first_name: "Anna",
        last_name: "Nowak",
        email: "anna@example.com",
        phone: "123456789",
        street: "Leśna 5",
        city: "Kraków",
        postal_code: "30-002",
        tracking_number: "TRACK-1",
        label_url: "",
        dhl_shipment_id: null,
        dhl_shipment_date: "2026-04-29",
      }],
      shippedToday: 1,
      shipped: [{
        id: "s1",
        first_name: "Ola",
        last_name: "Lis",
        city: "Gdańsk",
        status: "shipped",
        status_updated_at: "2026-05-31T10:00:00.000Z",
        delivered_at: null,
        tracking_number: "TRACK-2",
        tracking_url: null,
      }],
    });

    expect(parsed.approved[0].city).toBe("Warszawa");
    expect(parsed.packing[0].label_url).toBeNull();
    expect(parsed.shippedToday).toBe(1);
  });
});

describe("fulfillment contracts public re-exports", () => {
  it("re-exports the provider delivered-notification ownership policy (W6/W8)", () => {
    expect(providerOwnsDeliveredNotification("omnipack")).toBe(false);
    expect(providerOwnsDeliveredNotification("dhl")).toBe(false);
    expect(providerOwnsDeliveredNotification("unknown-provider")).toBe(false);
  });
});

describe("admin low-stock evidence contracts (W7b)", () => {
  it("defaults the status filter to open and rejects unknown filters", () => {
    expect(adminLowStockEvidenceRequestSchema.parse({})).toEqual({ statusFilter: "open" });
    expect(adminLowStockEvidenceRequestSchema.safeParse({ statusFilter: "nope" }).success).toBe(false);
  });

  it("accepts a well-formed evidence response and rejects an invalid threshold kind", () => {
    const valid = {
      statusFilter: "open" as const,
      openCount: 1,
      items: [
        {
          id: "ev1",
          sku: "__omnipack_stock_sync__",
          thresholdKind: "stale_sync" as const,
          severity: "warning" as const,
          status: "open" as const,
          providerForSaleQuantity: null,
          localAvailableQuantity: null,
          forecastDays: null,
          firstSeenAt: "2026-06-24T10:00:00.000Z",
          lastSeenAt: "2026-06-24T11:00:00.000Z",
          resolvedAt: null,
        },
      ],
    };
    expect(adminLowStockEvidenceResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      adminLowStockEvidenceResponseSchema.safeParse({
        ...valid,
        items: [{ ...valid.items[0], thresholdKind: "made_up" }],
      }).success,
    ).toBe(false);
  });
});
