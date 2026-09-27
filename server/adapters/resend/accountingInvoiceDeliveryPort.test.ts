import { describe, expect, it, vi } from "vitest";
import type { EmailTransport } from "../../infra/email/emailTransport.js";
import { createAccountingInvoiceDeliveryPort } from "./accountingInvoiceDeliveryPort.js";

describe("accounting invoice delivery email adapter", () => {
  it("records required processing evidence before sending the PDF with a stable key", async () => {
    const calls: string[] = [];
    const rpc = vi.fn(async () => {
      calls.push("timeline");
      return { data: "timeline-1", error: null };
    });
    const transport = transportStub(async (message) => {
      calls.push("transport");
      return {
        outcome: { ok: true, resendId: "re_123", httpStatus: 200, providerError: null, aborted: false },
        providerResponse: { id: "re_123" },
      };
    });

    await expect(createAccountingInvoiceDeliveryPort({
      client: { rpc }, transport,
      fromEmail: "openlup <hello@example.test>", baseUrl: "https://preview.example.test",
    }).sendInvoiceDocument(delivery())).resolves.toEqual({
      status: "sent",
      providerMessageId: "re_123",
    });

    expect(calls).toEqual(["timeline", "transport"]);
    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_dedupe_key: "accounting-invoice-delivery:outbox-1:provider-1",
      p_template_slug: "commerce-invoice-document",
      p_trigger_source: "accounting-invoice-delivery",
      p_trigger_event: "invoice.document.delivery",
      p_status: "processing",
      p_aggregate_type: "commerce_order",
      p_aggregate_id: "order-1",
    }));
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "client@example.test",
      idempotencyKey: "accounting-invoice-delivery:outbox-1:provider-1",
      attachments: [{ filename: "FV-1-2026.pdf", content: "JVBERi0xLjQ=" }],
      html: expect.stringContaining('href="https://preview.example.test/konto?sekcja=orders"'),
    }));
    const sent = transport.send.mock.calls[0]?.[0];
    expect(sent?.html).toContain('<img src="https://preview.example.test/email-logo-wordmark.png"');
    expect(sent?.html).not.toContain("email-banner");
  });

  it.each([
    { ok: true, resendId: null, httpStatus: 200, providerError: null, aborted: false },
    { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false, suppressed: "drop" as const },
    { ok: false, resendId: null, httpStatus: 503, providerError: "unavailable", aborted: false },
    { ok: false, resendId: null, httpStatus: 0, providerError: "aborted", aborted: true },
  ])("maps every non-confirmed transport result to uncertain", async (outcome) => {
    const transport = transportStub(async () => ({ outcome, providerResponse: {} }));
    const result = await createAccountingInvoiceDeliveryPort({
      client: { rpc: async () => ({ data: "timeline-1", error: null }) },
      transport,
      fromEmail: "hello@example.test",
      baseUrl: "https://preview.example.test",
    }).sendInvoiceDocument(delivery());

    expect(result).toMatchObject({ status: "uncertain" });
  });

  it("preserves sanitized provider diagnostics for an uncertain send", async () => {
    const transport = transportStub(async () => ({
      outcome: {
        ok: false,
        resendId: null,
        httpStatus: 403,
        providerError: "The preview sender domain is not verified",
        providerErrorCode: "validation_error",
        aborted: false,
        egressMode: "sandbox_sink",
      },
      providerResponse: {},
    }));

    await expect(createAccountingInvoiceDeliveryPort({
      client: { rpc: async () => ({ data: "timeline-1", error: null }) },
      transport,
      fromEmail: "hello@example.test",
      baseUrl: "https://preview.example.test",
    }).sendInvoiceDocument(delivery())).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "invoice_email_provider_outcome_uncertain",
        providerKind: "resend",
        httpStatus: 403,
        aborted: false,
        suppressed: null,
        providerErrorCode: "validation_error",
        providerError: "The preview sender domain is not verified",
        egressMode: "sandbox_sink",
      },
    });
  });

  it("does not enter the transport when required processing evidence fails", async () => {
    const transport = transportStub(async () => {
      throw new Error("should not run");
    });
    const port = createAccountingInvoiceDeliveryPort({
      client: { rpc: async () => ({ data: null, error: { code: "P0001" } }) },
      transport,
      fromEmail: "hello@example.test",
      baseUrl: "https://preview.example.test",
    });

    await expect(port.sendInvoiceDocument(delivery())).rejects.toThrow("email_delivery_timeline_rpc_error");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("turns a thrown transport call into uncertain without leaking its message", async () => {
    const transport = transportStub(async () => {
      throw new Error("client@example.test secret");
    });
    await expect(createAccountingInvoiceDeliveryPort({
      client: { rpc: async () => ({ data: "timeline-1", error: null }) },
      transport,
      fromEmail: "hello@example.test",
      baseUrl: "https://preview.example.test",
    }).sendInvoiceDocument(delivery())).resolves.toEqual({
      status: "uncertain",
      error: { code: "invoice_email_provider_transport_threw", providerKind: "resend" },
    });
  });

  it("labels a correction as a correction while reusing the same delivery template", async () => {
    const transport = transportStub(async () => ({
      outcome: { ok: true, resendId: "re_correction", httpStatus: 200, providerError: null, aborted: false },
      providerResponse: { id: "re_correction" },
    }));
    const port = createAccountingInvoiceDeliveryPort({
      client: { rpc: async () => ({ data: "timeline-1", error: null }) },
      transport,
      fromEmail: "hello@example.test",
      baseUrl: "https://preview.example.test",
    });

    await port.sendInvoiceDocument({
      ...delivery(),
      deliverySource: "correction_issued",
      providerInvoiceNumber: "KOR/1/2026",
    });

    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: "Korekta faktury do zamówienia OPENLUP-1",
      text: expect.stringContaining("Korekta faktury jest gotowa"),
    }));
  });

});

function delivery() {
  return {
    outboxId: "outbox-1",
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
    document: { filename: "FV-1-2026.pdf", content: Buffer.from("%PDF-1.4") },
  };
}

function transportStub(send: EmailTransport["send"]): EmailTransport & { send: ReturnType<typeof vi.fn> } {
  return { providerKind: "resend", send: vi.fn(send) };
}
