import { describe, expect, it } from "vitest";

import { resolveAccountingDocumentHistory } from "./accountingDocumentHistory.js";

describe("resolveAccountingDocumentHistory", () => {
  it("keeps a single issued invoice current and downloadable", () => {
    const history = resolveAccountingDocumentHistory({
      invoices: [invoice()],
      providerArtifactEligible: (kind) => kind === "fakturownia",
    });

    expect(history.current).toMatchObject({
      invoiceId: "10000000-0000-4000-8000-000000000001",
      role: "original",
      isCurrent: true,
      downloadAvailable: true,
    });
    expect(history.documents).toHaveLength(1);
  });

  it("resolves original, correction, and newest valid replacement", () => {
    const base = invoice({
      status: "corrected",
      correction_status: "issued",
      metadata: {
        correctionProviderInvoiceId: "provider-k12",
        correctionProviderInvoiceNumber: "K12/2026",
      },
    });
    const replacement = invoice({
      id: "10000000-0000-4000-8000-000000000002",
      invoice_ref: "OPENLUP-0F50280B:reissue-1",
      provider_invoice_id: "provider-2",
      provider_invoice_number: "2/07/2026",
      correction_of_invoice_id: base.id,
      created_at: "2026-07-13T07:00:00Z",
      updated_at: "2026-07-13T07:00:00Z",
    });

    const history = resolveAccountingDocumentHistory({
      invoices: [replacement, base],
      operations: [
        {
          invoice_id: base.id,
          operation: "correction_issued",
          created_at: "2026-07-13T06:00:00Z",
        },
        {
          invoice_id: base.id,
          operation: "provider_email_sent",
          provider_ref: "provider-1",
          payload: { providerInvoiceId: "provider-k12" },
          created_at: "2026-07-13T06:05:00Z",
        },
      ],
      providerArtifactEligible: (kind) => kind === "fakturownia",
    });

    expect(history.current).toMatchObject({
      invoiceId: replacement.id,
      providerInvoiceNumber: "2/07/2026",
      role: "replacement",
    });
    expect(history.documents.map((document) => document.role)).toEqual([
      "original",
      "correction",
      "replacement",
    ]);
    expect(history.documents[0]).toMatchObject({
      providerInvoiceNumber: "1/07/2026",
      status: "corrected",
      isCurrent: false,
      downloadAvailable: true,
    });
    expect(history.documents[1]).toMatchObject({
      providerInvoiceNumber: "K12/2026",
      artifact: "correction",
      emailState: "provider_accepted",
      downloadAvailable: true,
    });
  });

  it("does not select a blocked or draft replacement", () => {
    const base = invoice({ status: "corrected" });
    const replacement = invoice({
      id: "10000000-0000-4000-8000-000000000002",
      correction_of_invoice_id: base.id,
      status: "draft",
      created_at: "2026-07-13T07:00:00Z",
    });
    const history = resolveAccountingDocumentHistory({
      invoices: [base, replacement],
      providerArtifactEligible: () => true,
    });

    expect(history.current).toBeNull();
    expect(history.documents.every((document) => !document.isCurrent)).toBe(true);
  });

  it("shows incomplete correction evidence without offering an unsafe download", () => {
    const history = resolveAccountingDocumentHistory({
      invoices: [invoice({
        status: "correction_requested",
        correction_status: "requested",
        metadata: {
          correctionProviderInvoiceId: "provider-k12",
          correctionProviderInvoiceNumber: "K12/2026",
        },
      })],
      providerArtifactEligible: () => true,
    });

    expect(history.documents.find((document) => document.role === "correction")).toMatchObject({
      status: "not_ready",
      downloadAvailable: false,
    });
  });

  it("projects an uncertain delivery occurrence as failed while keeping the PDF available", () => {
    const current = invoice({ email_status: "pending" });
    const history = resolveAccountingDocumentHistory({
      invoices: [current],
      deliveryOutboxes: [{
        invoice_id: current.id,
        status: "uncertain",
        metadata: {},
        created_at: "2026-07-16T10:00:00Z",
      }],
      providerArtifactEligible: () => true,
    });

    expect(history.current).toMatchObject({
      emailState: "failed",
      downloadAvailable: true,
    });
  });

  it("uses timestamp and id tie-breaks deterministically for multiple reissues", () => {
    const base = invoice({ status: "corrected" });
    const first = invoice({
      id: "10000000-0000-4000-8000-000000000002",
      correction_of_invoice_id: base.id,
      created_at: "2026-07-13T07:00:00Z",
    });
    const second = invoice({
      id: "10000000-0000-4000-8000-000000000003",
      correction_of_invoice_id: base.id,
      created_at: "2026-07-13T07:00:00Z",
    });

    expect(resolveAccountingDocumentHistory({
      invoices: [first, base, second],
      providerArtifactEligible: () => true,
    }).current?.invoiceId).toBe(second.id);
  });
});

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    order_id: "20000000-0000-4000-8000-000000000001",
    invoice_ref: "OPENLUP-0F50280B:base",
    status: "issued",
    blocked_reason: null,
    provider_kind: "fakturownia",
    provider_invoice_id: "provider-1",
    provider_invoice_number: "1/07/2026",
    correction_of_invoice_id: null,
    correction_status: "none",
    metadata: {},
    ksef_number: null,
    ksef_status: "not_required",
    email_status: "sent",
    total_gross_cents: 11_175,
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    ...overrides,
  };
}
