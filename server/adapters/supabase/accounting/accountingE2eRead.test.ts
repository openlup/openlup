import { describe, expect, it, vi } from "vitest";
import { readAccountingE2eInvoice } from "./accountingE2eRead.js";

describe("readAccountingE2eInvoice", () => {
  it("reads the hidden-preview invoice fields by id", async () => {
    const client = createClient({
      data: { id: "invoice-1", status: "issued" },
      error: null,
    });

    await expect(readAccountingE2eInvoice(client, "invoice-1")).resolves.toEqual({
      id: "invoice-1",
      status: "issued",
    });

    expect(client.operations).toEqual([
      ["from", "accounting_invoices"],
      [
        "select",
        "id, order_id, invoice_ref, status, document_kind, ksef_required, ksef_status, provider_kind, provider_invoice_id, provider_invoice_number, email_status, blocked_reason, updated_at",
      ],
      ["eq", "id", "invoice-1"],
      ["maybeSingle"],
    ]);
  });
});

function createClient(result: {
  data: Record<string, unknown> | null;
  error: { message?: string } | null;
}) {
  const state = {
    operations: [] as unknown[][],
    from: vi.fn((table: string) => {
      state.operations.push(["from", table]);
      const builder = {
        select: vi.fn((columns: string) => {
          state.operations.push(["select", columns]);
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          state.operations.push(["eq", column, value]);
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          state.operations.push(["maybeSingle"]);
          return result;
        }),
      };
      return builder;
    }),
  };
  return state;
}
