import { describe, expect, it } from "vitest";
import { buildOmsFulfillmentDebug } from "./omsFulfillmentDebug.js";

describe("OMS fulfillment debug packet", () => {
  it("summarizes the happy path as a watch-only flow when no action is needed", () => {
    const debug = buildOmsFulfillmentDebug(baseInput());

    expect(debug).toMatchObject({
      severity: "ok",
      nextAction: "wait",
      blockers: [],
    });
    expect(debug.steps.map((step) => [step.key, step.status])).toEqual([
      ["payment", "ok"],
      ["stock", "ok"],
      ["provider_stock", "ok"],
      ["fulfillment", "ok"],
      ["dispatch", "ok"],
      ["provider", "ok"],
      ["tracking", "ok"],
      ["communication", "ok"],
    ]);
  });

  it("points operators at provider review for quarantined inbound evidence", () => {
    const debug = buildOmsFulfillmentDebug({
      ...baseInput(),
      inboundProviderEvents: [{
        id: "evt-1",
        provider: "omnipack",
        provider_event_id: "order.shipped:provider-order-1",
        event_type: "order.shipped",
        processing_status: "ignored",
        error: { reason: "omnipack_dispatch_ref_not_found" },
        created_at: "2026-06-05T10:40:00+00:00",
      }],
    });

    expect(debug.severity).toBe("action_required");
    expect(debug.nextAction).toBe("review_provider");
    expect(debug.blockers).toContain("Provider evidence");
    expect(debug.steps.find((step) => step.key === "provider")).toMatchObject({
      status: "warning",
      value: "shipped",
      details: ["order.shipped", "omnipack_dispatch_ref_not_found"],
    });
  });

  it("recommends reconciliation when provider shipped but tracking refs are missing", () => {
    const debug = buildOmsFulfillmentDebug({
      ...baseInput(),
      fulfillment: {
        ...baseInput().fulfillment,
        providerTrackingId: null,
        trackingReferences: [],
      },
      omnipackStatusEvidence: [{
        fulfillment_order_id: "fulfillment-1",
        provider_status: "shipped",
        local_status: "in_transit",
        evidence_kind: "reconciliation",
        occurred_at: "2026-06-05T10:35:00+00:00",
      }],
    });

    expect(debug.nextAction).toBe("reconcile");
    expect(debug.steps.find((step) => step.key === "tracking")).toMatchObject({ status: "missing" });
  });

  it("includes provider attempt failures in the provider review signal", () => {
    const debug = buildOmsFulfillmentDebug({
      ...baseInput(),
      providerAttempts: [{
        fulfillment_order_id: "fulfillment-1",
        provider_kind: "omnipack",
        status: "failed",
        provider_tracking_id: null,
        error: { reason: "provider_timeout" },
        created_at: "2026-06-05T10:25:00+00:00",
      }],
    });

    expect(debug.nextAction).toBe("review_provider");
    expect(debug.steps.find((step) => step.key === "provider")).toMatchObject({
      status: "warning",
      details: ["attempt failed", "provider_timeout"],
    });
  });

  it("requires provider-current stock for OmniPack orders", () => {
    const debug = buildOmsFulfillmentDebug({
      ...baseInput(),
      providerStockCurrent: [],
    });

    expect(debug.nextAction).toBe("review_stock");
    expect(debug.blockers).toContain("Provider stock");
    expect(debug.steps.find((step) => step.key === "provider_stock")).toMatchObject({
      status: "missing",
      value: null,
    });
  });
});

function baseInput(): Parameters<typeof buildOmsFulfillmentDebug>[0] {
  return {
    paymentStatus: "succeeded",
    inventory: {
      status: "reserved",
      reservationId: "reservation-1",
      reservationStatus: "reserved",
      expiresAt: "2026-06-05T11:00:00+00:00",
      locationId: "location-1",
      locationCode: "pl-main",
    },
    reservations: [{
      id: "reservation-1",
      order_id: "order-1",
      order_item_id: "item-1",
      quantity: 1,
      status: "reserved",
      expires_at: "2026-06-05T11:00:00+00:00",
      location_id: "location-1",
    }],
    fulfillment: {
      fulfillmentOrderId: "fulfillment-1",
      status: "in_transit",
      providerKind: "omnipack",
      latestOperationType: "handed_over",
      latestOperationAt: "2026-06-05T10:30:00+00:00",
      providerTrackingId: "TRACK-1",
      trackingUrl: "https://carrier.example/TRACK-1",
      carrierKind: "inpost",
      service: "courier",
      trackingReferences: [{
        providerKind: "omnipack",
        trackingNumber: "TRACK-1",
        trackingUrl: "https://carrier.example/TRACK-1",
        carrierKind: "inpost",
        service: "courier",
        updatedAt: "2026-06-05T10:31:00+00:00",
      }],
      trackingTimeline: [],
      providerEvidence: [],
    },
    communicationDeliveries: [{
      id: "delivery-1",
      purpose: "shipment_dispatched",
      template_slug: "commerce-shipment-dispatched",
      trigger_source: "commerce",
      trigger_event: "commerce.shipment.dispatched",
      aggregate_type: "commerce_order",
      aggregate_id: "order-1",
      dedupe_key: "shipment-dispatched:order-1",
      status: "sent",
      provider_kind: "resend",
      provider_message_id: "msg-1",
      scheduled_due_at: null,
      expected_send_at: null,
      queued_at: null,
      first_attempt_at: "2026-06-05T10:32:00+00:00",
      sent_at: "2026-06-05T10:33:00+00:00",
      delivered_at: null,
      terminal_at: null,
      last_error_code: null,
      outbox_event_id: "outbox-1",
      platform_job_run_id: null,
      email_send_id: "email-1",
      metadata: {},
      created_at: "2026-06-05T10:32:00+00:00",
      updated_at: "2026-06-05T10:33:00+00:00",
    }],
    providerAttempts: [],
    omnipackDispatchRefs: [{
      fulfillment_order_id: "fulfillment-1",
      provider_order_id: "provider-order-1",
      dispatch_mode: "stage",
      status: "created",
      created_at: "2026-06-05T10:20:00+00:00",
      updated_at: "2026-06-05T10:21:00+00:00",
    }],
    omnipackStatusEvidence: [{
      fulfillment_order_id: "fulfillment-1",
      provider_status: "shipped",
      local_status: "in_transit",
      evidence_kind: "webhook",
      occurred_at: "2026-06-05T10:35:00+00:00",
    }],
    inboundProviderEvents: [],
    providerStockCurrent: [{
      provider_kind: "omnipack",
      sku: "OPENLUP-BEEF-2KG",
      provider_for_sale_quantity: 12,
      provider_total_quantity: 14,
      last_synced_at: "2026-06-05T10:15:00+00:00",
      stale_after: "2099-06-05T16:15:00+00:00",
    }],
  };
}
