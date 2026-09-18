import { describe, expect, it } from "vitest";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { actionFingerprint, normalizeAddressDraft } from "./orderDetailActionUtils";
import { detailResponse } from "./OrdersPage.testHelpers";

const detail = detailResponse({
  order: {
    fulfillment: {
      fulfillmentOrderId: "f3222222-2222-4222-8222-222222222221",
      status: "label_created",
      latestOperationType: "label_created",
      latestOperationAt: "2026-06-05T10:30:00+00:00",
      providerTrackingId: "TRACK-123",
    },
  },
}).order as OmsOrderDetail;

const baseInput = {
  addressDraft: {
    recipientName: "",
    contactEmail: "ala@example.com",
    contactPhone: "",
    line1: "Prosta 1",
    line2: "",
    postalCode: "00-001",
    city: "Warszawa",
    country: "PL",
    deliveryNotes: "",
    courierInstructions: "",
  },
  note: "",
  labelTrackingId: "TRACK-123",
  trackingStatus: "delivered",
  fulfillmentProviderKind: "hidden_preview_fulfillment",
  cancelReason: "",
  markRefundedReason: "",
};

describe("orderDetailActionUtils", () => {
  it("fingerprints label actions with the configured provider kind", () => {
    expect(actionFingerprint("label", detail, baseInput)).toContain("hidden_preview_fulfillment");
    expect(actionFingerprint("label", detail, baseInput)).not.toContain("manual_preview");
  });

  it("fingerprints tracking actions by selected status", () => {
    const delivered = actionFingerprint("tracking", detail, baseInput);
    const exception = actionFingerprint("tracking", detail, {
      ...baseInput,
      trackingStatus: "exception",
    });

    expect(delivered).not.toEqual(exception);
    expect(exception).toContain("exception");
  });

  it("fingerprints the single cancellation action against the fulfillment", () => {
    const fingerprint = actionFingerprint("cancel", detail, {
      ...baseInput,
      cancelReason: "provider cancelled",
    });
    expect(fingerprint).toContain(detail.fulfillment.fulfillmentOrderId ?? "");
  });

  it("fingerprints legacy corrections against revision and exact contact digest", () => {
    const first = actionFingerprint("updateAddress", {
      ...detail,
      deliveryContact: {
        baseline: null,
        effective: null,
        scope: "legacy_inferred",
        source: "legacy_inferred",
        revision: 1,
        digest: "0123456789abcdef0123456789abcdef",
        frozen: false,
        providerSubmissionState: "not_materialized",
        correctionAllowed: true,
      },
    }, baseInput);
    const second = actionFingerprint("updateAddress", {
      ...detail,
      deliveryContact: {
        baseline: null,
        effective: null,
        scope: "legacy_inferred",
        source: "legacy_inferred",
        revision: 1,
        digest: "fedcba9876543210fedcba9876543210",
        frozen: false,
        providerSubmissionState: "not_materialized",
        correctionAllowed: true,
      },
    }, baseInput);
    expect(first).not.toBe(second);
  });

  it("does not invent a delivery contact revision for the fingerprint", () => {
    const fingerprint = actionFingerprint("updateAddress", {
      ...detail,
      deliveryContact: undefined,
    }, baseInput);
    expect(JSON.parse(fingerprint)).toMatchObject({
      expectedRevision: null,
      expectedContactDigest: null,
    });
  });

  it("normalizes required delivery contact fields as trimmed strings", () => {
    expect(normalizeAddressDraft({
      ...baseInput.addressDraft,
      recipientName: " Ala Kowalska ",
      contactEmail: " ala@example.com ",
      contactPhone: " 500600700 ",
    })).toMatchObject({
      recipientName: "Ala Kowalska",
      contactEmail: "ala@example.com",
      contactPhone: "500600700",
    });
  });
});
