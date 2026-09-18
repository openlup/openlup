import { describe, expect, it } from "vitest";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import type { OmsAccountingInvoiceRow } from "../../../../../src/domains/commerce/omsReadModel.js";
import { readAccountingOutbox } from "./accounting.js";
import { FakeOmsClient } from "./readQueriesTestKit.js";

describe("supabase commerce OMS accounting helpers", () => {
  it("reads accounting outbox rows for the hydrated invoice ids", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        accounting_invoice_issue_outbox: [
          {
            invoice_id: "invoice-1",
            status: "failed",
            attempt_count: 2,
            created_at: "2026-06-05T10:03:00+00:00",
          },
          {
            invoice_id: "invoice-2",
            status: "pending",
            attempt_count: 1,
            created_at: "2026-06-05T10:04:00+00:00",
          },
        ],
      },
    });

    const rows = await readAccountingOutbox(client, [
      invoice("invoice-1"),
    ]);

    expect(rows).toEqual([
      {
        invoice_id: "invoice-1",
        status: "failed",
        attempt_count: 2,
        created_at: "2026-06-05T10:03:00+00:00",
      },
    ]);
    expect(client.tablesRead).toEqual(["accounting_invoice_issue_outbox"]);
    expect(client.selects).toEqual([
      {
        table: "accounting_invoice_issue_outbox",
        columns: "invoice_id, status, attempt_count, next_attempt_at, last_error, created_at",
      },
    ]);
    expect(client.filters).toContainEqual({
      table: "accounting_invoice_issue_outbox",
      kind: "in",
      column: "invoice_id",
      value: ["invoice-1"],
    });
  });

  it("does not query the outbox table when there are no invoices", async () => {
    const client = new FakeOmsClient({ rpcData: {}, rows: {} });

    await expect(readAccountingOutbox(client, [])).resolves.toEqual([]);
    expect(client.tablesRead).toEqual([]);
  });

  it("raises an OMS persistence error when the outbox read fails", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {},
      selectErrors: [
        {
          table: "accounting_invoice_issue_outbox",
          whenColumnsInclude: "invoice_id",
          error: { code: "XX000", message: "boom" },
        },
      ],
    });

    await expect(readAccountingOutbox(client, [invoice("invoice-1")])).rejects.toBeInstanceOf(
      CommerceOmsPersistenceError,
    );
  });
});

function invoice(id: string): OmsAccountingInvoiceRow {
  return {
    id,
    order_id: `order-${id}`,
    invoice_ref: `FV/${id}`,
    status: "issued",
    provider_kind: "manual",
    provider_invoice_number: null,
    ksef_status: null,
    total_gross_cents: 12345,
    currency: "PLN",
    updated_at: "2026-06-05T10:00:00+00:00",
  };
}
