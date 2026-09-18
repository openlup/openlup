import { describe, expect, it, vi } from "vitest";
import type {
  AccountingInvoiceDeliveryTarget,
  AccountingInvoiceEmailDeliveryResult,
} from "../../../src/domains/accounting/ports.js";
import {
  assertInvoicePdf,
  invoicePdfFilename,
  runAccountingInvoiceDeliveryJob,
} from "./accountingInvoiceDeliveryJob.js";
import type { AccountingRuntimeConfig } from "./accountingRuntimeConfig.js";

describe("accounting invoice delivery job", () => {
  it("downloads a valid provider PDF and atomically acknowledges the Resend id", async () => {
    const port = portStub([claim]);
    const provider = providerStub();
    const deliveryPort = deliveryStub({
      status: "sent",
      providerMessageId: "re_invoice_1",
    });

    await expect(runAccountingInvoiceDeliveryJob({
      port: port as never,
      provider: provider as never,
      deliveryPort,
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toEqual({ ok: true, checked: 1, updated: 1, skipped: false, failures: 0 });

    expect(provider.downloadInvoicePdf).toHaveBeenCalledWith("provider-1");
    expect(deliveryPort.sendInvoiceDocument).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "accounting-invoice-delivery:outbox-1:provider-1",
      recipientEmail: "client@example.test",
      document: expect.objectContaining({ filename: "FV-1-2026.pdf" }),
    }));
    expect(port.markInvoiceDeliverySucceeded).toHaveBeenCalledWith({
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      providerInvoiceId: "provider-1",
      providerMessageId: "re_invoice_1",
    });
    expect(port.markInvoiceDeliveryFailed).not.toHaveBeenCalled();
    expect(port.markInvoiceDeliveryUncertain).not.toHaveBeenCalled();
  });

  it.each([
    { content: new Uint8Array(), contentType: "application/pdf", code: "accounting_invoice_pdf_empty" },
    { content: Buffer.from("not-a-pdf"), contentType: "application/pdf", code: "accounting_invoice_pdf_signature_invalid" },
    { content: Buffer.from("%PDF-1.4"), contentType: "text/plain", code: "accounting_invoice_pdf_content_type_invalid" },
    { content: new Uint8Array(25 * 1024 * 1024 + 1), contentType: "application/pdf", code: "accounting_invoice_pdf_too_large" },
  ])("fails safely before email transport for invalid PDF: $code", async (pdf) => {
    const port = portStub([claim]);
    const provider = providerStub(pdf);
    const deliveryPort = deliveryStub({ status: "sent", providerMessageId: "re_never" });

    await expect(runAccountingInvoiceDeliveryJob({
      port: port as never,
      provider: provider as never,
      deliveryPort,
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toMatchObject({ ok: false, updated: 0, failures: 1 });

    expect(deliveryPort.sendInvoiceDocument).not.toHaveBeenCalled();
    expect(port.markInvoiceDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      providerInvoiceId: "provider-1",
      error: { message: pdf.code },
    }));
  });

  it("makes an ambiguous provider attempt terminally uncertain without retry", async () => {
    const port = portStub([claim]);
    const deliveryPort = deliveryStub({
      status: "uncertain",
      error: { code: "invoice_email_provider_outcome_uncertain", httpStatus: 503 },
    });

    await expect(runAccountingInvoiceDeliveryJob({
      port: port as never,
      provider: providerStub() as never,
      deliveryPort,
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toMatchObject({ ok: false, updated: 0, failures: 1 });

    expect(port.markInvoiceDeliveryUncertain).toHaveBeenCalledWith({
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      providerInvoiceId: "provider-1",
      providerMessageId: null,
      error: { code: "invoice_email_provider_outcome_uncertain", httpStatus: 503 },
    });
    expect(port.markInvoiceDeliveryFailed).not.toHaveBeenCalled();
  });

  it("rejects a drifted occurrence key before downloading or sending", async () => {
    const port = portStub([{ ...claim, idempotencyKey: "wrong-key" }]);
    const provider = providerStub();
    const deliveryPort = deliveryStub({ status: "sent", providerMessageId: "re_never" });

    await expect(runAccountingInvoiceDeliveryJob({
      port: port as never,
      provider: provider as never,
      deliveryPort,
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toMatchObject({ ok: false, updated: 0, failures: 1 });

    expect(provider.downloadInvoicePdf).not.toHaveBeenCalled();
    expect(deliveryPort.sendInvoiceDocument).not.toHaveBeenCalled();
    expect(port.markInvoiceDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      error: { message: "accounting_invoice_delivery_idempotency_key_invalid" },
    }));
  });

  it("rejects a claim owned by another accounting provider before download", async () => {
    const port = portStub([{ ...claim, providerKind: "unexpected-provider" }]);
    const provider = providerStub();
    const deliveryPort = deliveryStub({ status: "sent", providerMessageId: "re_never" });

    await expect(runAccountingInvoiceDeliveryJob({
      port: port as never,
      provider: provider as never,
      deliveryPort,
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toMatchObject({ ok: false, updated: 0, failures: 1 });

    expect(provider.downloadInvoicePdf).not.toHaveBeenCalled();
    expect(deliveryPort.sendInvoiceDocument).not.toHaveBeenCalled();
    expect(port.markInvoiceDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      error: { message: "accounting_invoice_delivery_provider_kind_mismatch" },
    }));
  });

  it("downgrades a lost local finalizer acknowledgement to uncertain with the provider id", async () => {
    const port = portStub([claim]);
    port.markInvoiceDeliverySucceeded.mockRejectedValueOnce(new Error("response lost"));

    await expect(runAccountingInvoiceDeliveryJob({
      port: port as never,
      provider: providerStub() as never,
      deliveryPort: deliveryStub({ status: "sent", providerMessageId: "re_accepted" }),
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toMatchObject({ ok: false, updated: 0, failures: 1 });

    expect(port.markInvoiceDeliveryUncertain).toHaveBeenCalledWith({
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      providerInvoiceId: "provider-1",
      providerMessageId: "re_accepted",
      error: { code: "invoice_email_local_finalize_uncertain" },
    });
    expect(port.markInvoiceDeliveryFailed).not.toHaveBeenCalled();
  });

  it("does no provider work when no outbox row is claimable", async () => {
    const provider = providerStub();
    const deliveryPort = deliveryStub({ status: "sent", providerMessageId: "re_never" });

    await expect(runAccountingInvoiceDeliveryJob({
      port: portStub([]) as never,
      provider: provider as never,
      deliveryPort,
      expectedProviderKind: "fakturownia",
      config: config(),
    })).resolves.toMatchObject({ ok: true, checked: 0, updated: 0 });

    expect(provider.downloadInvoicePdf).not.toHaveBeenCalled();
    expect(deliveryPort.sendInvoiceDocument).not.toHaveBeenCalled();
  });

  it("sanitizes document references into attachment filenames", () => {
    expect(invoicePdfFilename(" FV/1/2026 ../ klient ")).toBe("FV-1-2026-klient.pdf");
    expect(invoicePdfFilename("///")).toBe("faktura.pdf");
    expect(() => assertInvoicePdf({
      content: Buffer.from("%PDF-1.7"),
      contentType: "application/pdf; charset=binary",
    })).not.toThrow();
  });
});

const claim: AccountingInvoiceDeliveryTarget = {
  outboxId: "outbox-1",
  attemptCount: 1,
  providerKind: "fakturownia",
  invoiceId: "invoice-1",
  orderId: "order-1",
  clientId: "client-1",
  orderRef: "OPENLUP-1",
  invoiceRef: "OPENLUP-1:base",
  providerInvoiceId: "provider-1",
  providerInvoiceNumber: "FV/1/2026",
  recipientEmail: "client@example.test",
  deliverySource: "invoice_issued",
  idempotencyKey: "accounting-invoice-delivery:outbox-1:provider-1",
};

function providerStub(pdf: { content: Uint8Array; contentType: string } = {
  content: Buffer.from("%PDF-1.4"),
  contentType: "application/pdf",
}) {
  return { downloadInvoicePdf: vi.fn(async () => pdf) };
}

function deliveryStub(result: AccountingInvoiceEmailDeliveryResult) {
  return { sendInvoiceDocument: vi.fn(async () => result) };
}

function portStub(deliveries: AccountingInvoiceDeliveryTarget[]) {
  return {
    claimInvoiceDeliveries: vi.fn(async () => deliveries),
    markInvoiceDeliverySucceeded: vi.fn(async () => undefined),
    markInvoiceDeliveryFailed: vi.fn(async () => undefined),
    markInvoiceDeliveryUncertain: vi.fn(async () => undefined),
  };
}

function config(): AccountingRuntimeConfig {
  return {
    requestEnabled: false,
    createEnabled: false,
    b2cEmailEnabled: true,
    providerEmailEnabled: true,
    ksefPollEnabled: false,
    issueTrigger: "handoff",
    b2bEmailRequiresKsefAcceptance: true,
  };
}
