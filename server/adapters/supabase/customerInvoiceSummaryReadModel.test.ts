import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readCustomerInvoiceSummaries } from "./customerInvoiceSummaryReadModel.js";

type Row = Record<string, unknown>;

// Minimal thenable query mock: `.from(t).select().in().is()` and
// `.from(t).select().in()` both await to { data, error }. The builder is a
// thenable so awaiting it at any point in the chain resolves the table's rows.
function serviceClient(invoices: Row[], outbox: Row[] = [], operations: Row[] = []): SupabaseClient {
  return {
    from(table: string) {
      const data = table === "accounting_invoices"
        ? invoices
        : table === "accounting_invoice_operations"
          ? operations
          : outbox;
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        is: () => builder,
        order: () => builder,
        then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data, error: null }),
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
    ksef_status: "n/a",
    ksef_number: null,
    correction_of_invoice_id: null,
    correction_status: "none",
    metadata: {},
    email_status: "sent",
    total_gross_cents: 12300,
    updated_at: "2026-06-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
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

async function downloadAvailableFor(row: Row): Promise<boolean> {
  const map = await readCustomerInvoiceSummaries(serviceClient([row]), ["ord-1"]);
  return Boolean(map.get("ord-1")?.invoice?.downloadAvailable);
}

describe("readCustomerInvoiceSummaries downloadAvailable", () => {
  it("returns an empty map for no order ids", async () => {
    const map = await readCustomerInvoiceSummaries(serviceClient([]), []);
    expect(map.size).toBe(0);
  });

  it("allows download for a settled fakturownia invoice", async () => {
    expect(await downloadAvailableFor(invoiceRow())).toBe(true);
  });

  it("blocks download when the invoice is blocked", async () => {
    expect(await downloadAvailableFor(invoiceRow({ blocked_reason: "manual_review" }))).toBe(false);
  });

  it("blocks download for a non-settled status", async () => {
    expect(await downloadAvailableFor(invoiceRow({ status: "draft" }))).toBe(false);
  });

  it("blocks download when the provider invoice id is missing", async () => {
    expect(await downloadAvailableFor(invoiceRow({ provider_invoice_id: null }))).toBe(false);
  });

  it("gates fakturownia_test behind accountingPreviewTestPdfEligible", async () => {
    const testRow = invoiceRow({ provider_kind: "fakturownia_test" });
    expect(await downloadAvailableFor(testRow)).toBe(false); // flags off
    process.env.COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED = "true";
    process.env.COMMERCE_ACCOUNTING_TEST_PDF_ENABLED = "true";
    expect(await downloadAvailableFor(testRow)).toBe(true); // VERCEL_ENV unset !== production
    process.env.VERCEL_ENV = "production";
    expect(await downloadAvailableFor(testRow)).toBe(false);
  });

  it("exposes a download url only when available", async () => {
    const map = await readCustomerInvoiceSummaries(serviceClient([invoiceRow()]), ["ord-1"]);
    expect(map.get("ord-1")?.invoice?.downloadUrl).toContain("invoiceId=inv-1");
    const blocked = await readCustomerInvoiceSummaries(
      serviceClient([invoiceRow({ blocked_reason: "x" })]),
      ["ord-1"],
    );
    expect(blocked.get("ord-1")?.invoice).toBeNull();
  });

  it("selects the reissue and exposes original, correction, and replacement history", async () => {
    const base = invoiceRow({
      invoice_ref: "OPENLUP-0F50280B:base",
      status: "corrected",
      provider_invoice_number: "1/07/2026",
      correction_status: "issued",
      metadata: {
        correctionProviderInvoiceId: "provider-k12",
        correctionProviderInvoiceNumber: "K12/2026",
      },
    });
    const reissue = invoiceRow({
      id: "inv-2",
      invoice_ref: "OPENLUP-0F50280B:reissue-1",
      provider_invoice_id: "provider-2",
      provider_invoice_number: "2/07/2026",
      correction_of_invoice_id: "inv-1",
      created_at: "2026-07-13T07:00:00Z",
      updated_at: "2026-07-13T07:00:00Z",
    });
    const map = await readCustomerInvoiceSummaries(
      serviceClient([base, reissue], [], [{
        invoice_id: "inv-1",
        operation: "correction_issued",
        created_at: "2026-07-13T06:00:00Z",
      }]),
      ["ord-1"],
    );

    expect(map.get("ord-1")?.invoice?.providerInvoiceNumber).toBe("2/07/2026");
    expect(map.get("ord-1")?.invoiceDocuments.map((document) => ({
      number: document.providerInvoiceNumber,
      role: document.role,
      current: document.isCurrent,
    }))).toEqual([
      { number: "1/07/2026", role: "original", current: false },
      { number: "K12/2026", role: "correction", current: false },
      { number: "2/07/2026", role: "replacement", current: true },
    ]);
    expect(map.get("ord-1")?.invoiceDocuments[1]?.downloadUrl).toContain("artifact=correction");
  });
});
