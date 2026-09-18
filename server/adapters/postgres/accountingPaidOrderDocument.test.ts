import { describe, expect, it, vi } from "vitest";
import { createPostgresAccountingPaidOrderDocumentPort } from "./accountingPaidOrderDocument.js";

describe("createPostgresAccountingPaidOrderDocumentPort", () => {
  it("requests the paid-order document through the public rail and maps replay", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ response: {
          replayed: true,
          document: { id: "document-1", status: "issue_requested" },
        } }] })
      .mockResolvedValueOnce({ rows: [{
        document_ref: "order:11111111-1111-4111-8111-111111111111:base",
      }] });
    const port = createPostgresAccountingPaidOrderDocumentPort({ query });

    await expect(port.requestInvoiceIssueFromPaidOrder({
      idempotencyKey: "paid-order-1",
      orderId: "11111111-1111-4111-8111-111111111111",
      providerKind: "captured",
    })).resolves.toEqual({
      invoice: {
        id: "document-1",
        invoiceRef: "order:11111111-1111-4111-8111-111111111111:base",
        status: "issue_requested",
        replayed: true,
      },
    });

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("accounting_document_request_from_paid_order");
    expect(values).toEqual([
      "paid-order-1",
      "11111111-1111-4111-8111-111111111111",
      "captured",
    ]);
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining("accounting_documents"),
      ["document-1"],
    ]);
  });

  it("fails closed on a missing or malformed rail answer", async () => {
    const port = createPostgresAccountingPaidOrderDocumentPort({
      query: vi.fn(async () => ({ rows: [] })),
    });

    await expect(port.requestInvoiceIssueFromPaidOrder({
      idempotencyKey: "paid-order-2",
      orderId: "22222222-2222-4222-8222-222222222222",
      providerKind: "captured",
    })).rejects.toThrow("accounting_paid_order_document_response_invalid");
  });
});
