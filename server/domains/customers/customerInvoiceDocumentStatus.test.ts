import { describe, expect, it } from "vitest";
import { deriveCustomerDocumentDeliveryStatus } from "./customerInvoiceDocumentStatus.js";

describe("deriveCustomerDocumentDeliveryStatus", () => {
  it("maps customer-safe invoice and delivery states deterministically", () => {
    expect(status({ downloadAvailable: true })).toBe("pdf_ready");
    expect(status({ documentKind: "b2b_vat", ksefStatus: "pending", downloadAvailable: true })).toBe("ksef_pending");
    expect(status({ emailStatus: "pending", outboxStatus: "processing", downloadAvailable: true })).toBe("email_pending");
    expect(status({ emailStatus: "sent", outboxStatus: "succeeded", downloadAvailable: true })).toBe("email_provider_accepted");
    expect(status({ emailStatus: "provider_accepted", downloadAvailable: true })).toBe("email_provider_accepted");
    expect(status({ emailStatus: "failed", outboxStatus: "failed", downloadAvailable: true })).toBe("delivery_failed");
    expect(status({ outboxStatus: "uncertain", downloadAvailable: true })).toBe("delivery_failed");
    expect(status({ blockedReason: "buyer_data_invalid", downloadAvailable: true })).toBe("requires_correction");
    expect(status({ status: "rejected", downloadAvailable: false })).toBe("requires_correction");
    expect(status({ downloadAvailable: false })).toBe("not_ready");
  });
});

function status(overrides: Partial<Parameters<typeof deriveCustomerDocumentDeliveryStatus>[0]>) {
  return deriveCustomerDocumentDeliveryStatus({
    blockedReason: null,
    status: "issued",
    documentKind: null,
    ksefStatus: "not_required",
    emailStatus: "not_required",
    outboxStatus: null,
    downloadAvailable: false,
    ...overrides,
  });
}
