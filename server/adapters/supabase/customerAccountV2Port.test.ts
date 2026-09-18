import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseCustomerAccountV2Port } from "./customerAccountV2Port.js";

type Row = Record<string, unknown>;

// `.from(t).select().eq()[.eq()].maybeSingle()` → { data, error }.
function client(responses: Record<string, Row | null>): SupabaseClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: responses[table] ?? null, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function invoiceRow(over: Row = {}): Row {
  return {
    id: "inv-1",
    order_id: "ord-1",
    invoice_ref: "FV/1",
    status: "issued",
    blocked_reason: null,
    provider_kind: "fakturownia",
    provider_invoice_id: "prov-1",
    provider_invoice_number: "FV/1/2026",
    correction_of_invoice_id: null,
    correction_status: "none",
    metadata: {},
    ...over,
  };
}

const ACCOUNTING_ENV = [
  "COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED",
  "COMMERCE_ACCOUNTING_TEST_PDF_ENABLED",
  "VERCEL_ENV",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of ACCOUNTING_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ACCOUNTING_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makePort(invoice: Row | null, opts: { linkedClient?: Row | null; ownedOrder?: Row | null } = {}) {
  const customerClient = client({
    clients: opts.linkedClient === undefined ? { id: "c1" } : opts.linkedClient,
    commerce_orders: opts.ownedOrder === undefined ? { id: "ord-1" } : opts.ownedOrder,
  });
  const serviceClient = client({ accounting_invoices: invoice });
  return createSupabaseCustomerAccountV2Port({ customerClient, serviceClient });
}

describe("getInvoiceDownloadTicket", () => {
  it("returns a ticket for a settled, owned fakturownia invoice", async () => {
    const ticket = await makePort(invoiceRow()).getInvoiceDownloadTicket("u1", "inv-1");
    expect(ticket).toMatchObject({
      invoiceId: "inv-1",
      invoiceRef: "FV/1",
      providerKind: "fakturownia",
      providerInvoiceId: "prov-1",
    });
    expect(ticket?.fileName).toBe("FV-1-2026.pdf");
  });

  it("returns null when the user has no linked client", async () => {
    const ticket = await makePort(invoiceRow(), { linkedClient: null }).getInvoiceDownloadTicket("u1", "inv-1");
    expect(ticket).toBeNull();
  });

  it("returns null when the order is not owned by the client", async () => {
    const ticket = await makePort(invoiceRow(), { ownedOrder: null }).getInvoiceDownloadTicket("u1", "inv-1");
    expect(ticket).toBeNull();
  });

  it("returns null when the invoice is blocked", async () => {
    const ticket = await makePort(invoiceRow({ blocked_reason: "manual_review" })).getInvoiceDownloadTicket("u1", "inv-1");
    expect(ticket).toBeNull();
  });

  it("gates fakturownia_test behind accountingPreviewTestPdfEligible", async () => {
    const testInvoice = invoiceRow({ provider_kind: "fakturownia_test" });
    expect(await makePort(testInvoice).getInvoiceDownloadTicket("u1", "inv-1")).toBeNull();
    process.env.COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED = "true";
    process.env.COMMERCE_ACCOUNTING_TEST_PDF_ENABLED = "true";
    expect(await makePort(testInvoice).getInvoiceDownloadTicket("u1", "inv-1")).not.toBeNull();
    process.env.VERCEL_ENV = "production";
    expect(await makePort(testInvoice).getInvoiceDownloadTicket("u1", "inv-1")).toBeNull();
  });

  it("allows an issued replacement invoice", async () => {
    const ticket = await makePort(invoiceRow({ correction_of_invoice_id: "base-invoice" }))
      .getInvoiceDownloadTicket("u1", "inv-1");
    expect(ticket).toMatchObject({ providerInvoiceId: "prov-1", artifact: "invoice" });
  });

  it("allows the corrected original only as an explicitly requested historical invoice", async () => {
    const ticket = await makePort(invoiceRow({ status: "corrected" }))
      .getInvoiceDownloadTicket("u1", "inv-1", "invoice");
    expect(ticket).toMatchObject({ providerInvoiceId: "prov-1", artifact: "invoice" });
  });

  it("resolves a correction artifact from trusted invoice metadata", async () => {
    const ticket = await makePort(invoiceRow({
      status: "corrected",
      correction_status: "issued",
      metadata: {
        correctionProviderInvoiceId: "prov-k12",
        correctionProviderInvoiceNumber: "K12/2026",
      },
    })).getInvoiceDownloadTicket("u1", "inv-1", "correction");
    expect(ticket).toMatchObject({
      providerInvoiceId: "prov-k12",
      providerInvoiceNumber: "K12/2026",
      artifact: "correction",
      fileName: "K12-2026.pdf",
    });
  });

  it("does not invent a correction ticket when provider metadata is incomplete", async () => {
    const ticket = await makePort(invoiceRow({ status: "corrected", correction_status: "issued" }))
      .getInvoiceDownloadTicket("u1", "inv-1", "correction");
    expect(ticket).toBeNull();
  });
});
