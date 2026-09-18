import { describe, expect, it } from "vitest";
import { addressDraftFromDetail, deriveOrderRefFromId, eligibilityReason, formatOperatorOrderRef, isAddressDraftComplete, operatorPipelineStages } from "./ordersPageUtils";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { detailResponse } from "./OrdersPage.testHelpers";

describe("operatorPipelineStages", () => {
  it("projects the same canonical transit state for list and detail consumers", () => {
    const stages = operatorPipelineStages({
      paymentStatus: "succeeded",
      inventoryStatus: "consumed",
      customerFulfillmentStep: "transit",
    });

    expect(stages).toMatchObject([
      { key: "payment", complete: true },
      { key: "inventory", complete: true },
      { key: "fulfillment", complete: true, active: false },
      { key: "transit", active: true },
      { key: "delivered", complete: false },
    ]);
  });

  it("blocks fulfillment for a post-delivery exception instead of showing delivered", () => {
    const stages = operatorPipelineStages({
      paymentStatus: "succeeded",
      inventoryStatus: "consumed",
      customerFulfillmentStep: "exception",
    });

    expect(stages.find((stage) => stage.key === "fulfillment")).toMatchObject({ blocked: true });
    expect(stages.find((stage) => stage.key === "delivered")).toMatchObject({ complete: false });
  });
});

describe("formatOperatorOrderRef", () => {
  it("keeps a clean public OPENLUP order number as-is", () => {
    expect(
      formatOperatorOrderRef("OPENLUP-2EA41D1C", "2ea41d1c-d02d-428a-bb67-2dcb583d9294"),
    ).toBe("OPENLUP-2EA41D1C");
  });

  it("keeps a short human-readable non-OPENLUP order ref as-is", () => {
    expect(
      formatOperatorOrderRef("OMS-1001", "42222222-2222-4222-8222-222222222221"),
    ).toBe("OMS-1001");
  });

  it("never surfaces a synthetic outbox-matrix slug as the order number", () => {
    expect(
      formatOperatorOrderRef(
        "HP-OUTBOX-outbox-matrix-1782819131202--order-paid-fulfillment",
        "0ba07b03-61b2-4ec6-96b6-184296b41afb",
      ),
    ).toBe("OPENLUP-0BA07B03");
  });

  it("never surfaces a synthetic customer-account fixture slug as the order number", () => {
    expect(
      formatOperatorOrderRef(
        "HP-ACC-customer-account-fixture-17-79651-h2ygjx-B2C",
        "27cd8d79-76d9-4ac2-b636-fe9a1c38cb85",
      ),
    ).toBe("OPENLUP-27CD8D79");
  });

  it("never surfaces a raw UUID stored as the order number", () => {
    expect(
      formatOperatorOrderRef(
        "27cd8d79-76d9-4ac2-b636-fe9a1c38cb85",
        "27cd8d79-76d9-4ac2-b636-fe9a1c38cb85",
      ),
    ).toBe("OPENLUP-27CD8D79");
  });

  it("derives a clean OPENLUP ref when the order number is missing", () => {
    expect(formatOperatorOrderRef(null, "89b5b24c-0e55-4562-b3fa-99d3d78c0f73")).toBe("OPENLUP-89B5B24C");
    expect(formatOperatorOrderRef(undefined, "89b5b24c-0e55-4562-b3fa-99d3d78c0f73")).toBe("OPENLUP-89B5B24C");
    expect(formatOperatorOrderRef("   ", "89b5b24c-0e55-4562-b3fa-99d3d78c0f73")).toBe("OPENLUP-89B5B24C");
  });

  it("derives the same ref as the DB-side commerce_order_number_from_id format", () => {
    // 'OPENLUP-' || upper(substr(replace(id, '-', ''), 1, 8))
    expect(deriveOrderRefFromId("c1618759-0f79-4a5f-93cb-54fec9ec0770")).toBe("OPENLUP-C1618759");
  });

  it("degrades to a stable placeholder when no identifiers are available", () => {
    expect(formatOperatorOrderRef(null, null)).toBe("OPENLUP-UNKNOWN");
    expect(formatOperatorOrderRef(null, undefined)).toBe("OPENLUP-UNKNOWN");
  });
});

describe("addressDraftFromDetail", () => {
  it("uses the effective order-owned contact before the shared address", () => {
    const detail = detailResponse().order as unknown as OmsOrderDetail;
    const draft = addressDraftFromDetail({
      ...detail,
      shippingAddress: { ...detail.shippingAddress!, line1: "Shared 1", contactPhone: "111222333" },
      deliveryContact: {
        ...detail.deliveryContact!,
        effective: {
          ...detail.deliveryContact!.effective!,
          line1: "Order 2",
          contactEmail: "order@example.com",
          contactPhone: "500600700",
        },
      },
    });

    expect(draft).toMatchObject({
      line1: "Order 2",
      contactEmail: "order@example.com",
      contactPhone: "500600700",
    });
  });

  it("requires recipient, email and phone before submitting a correction", () => {
    const complete = addressDraftFromDetail(detailResponse().order as unknown as OmsOrderDetail);
    expect(isAddressDraftComplete(complete)).toBe(true);
    expect(isAddressDraftComplete({ ...complete, contactEmail: "" })).toBe(false);
    expect(isAddressDraftComplete({ ...complete, contactEmail: "not-an-email" })).toBe(false);
    expect(isAddressDraftComplete({ ...complete, contactPhone: "" })).toBe(false);
    expect(isAddressDraftComplete({ ...complete, recipientName: "" })).toBe(false);
  });
});

describe("eligibilityReason", () => {
  it("reads the delivery-contact refusal translations explicitly", () => {
    const t = ((key: string) => `translated:${key}`) as Parameters<typeof eligibilityReason>[1];
    expect(eligibilityReason("delivery_contact_submission_started", t))
      .toBe("translated:admin:adminOms.eligibility.delivery_contact_submission_started");
    expect(eligibilityReason("delivery_contact_stale_revision", t))
      .toBe("translated:admin:adminOms.eligibility.delivery_contact_stale_revision");
    expect(eligibilityReason("legacy_delivery_contact_read_only", t))
      .toBe("translated:admin:adminOms.eligibility.legacy_delivery_contact_read_only");
    expect(eligibilityReason("lock_timeout", t))
      .toBe("translated:admin:adminOms.eligibility.lock_timeout");
  });
});
