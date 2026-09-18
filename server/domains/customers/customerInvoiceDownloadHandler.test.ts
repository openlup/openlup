import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCustomerInvoiceDownloadHandler } from "./customerInvoiceDownloadHandler.js";

describe("customer invoice download handler", () => {
  it("requires an authenticated customer session before reading tickets", async () => {
    const port = { getInvoiceDownloadTicket: vi.fn() };
    const provider = { downloadInvoicePdf: vi.fn() };
    const handler = createCustomerInvoiceDownloadHandler({
      invoiceDownloadPort: port,
      invoicePdfProvider: provider,
      authenticateUser: vi.fn(async () => ({ ok: false as const, code: "UNAUTHORIZED" as const, message: "Customer session required" })),
    });
    const res = response();

    await handler(request(), res);

    expect(port.getInvoiceDownloadTicket).not.toHaveBeenCalled();
    expect(provider.downloadInvoicePdf).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns not found without provider fetch when the invoice is not owned or downloadable", async () => {
    const port = { getInvoiceDownloadTicket: vi.fn(async () => null) };
    const provider = { downloadInvoicePdf: vi.fn() };
    const handler = createCustomerInvoiceDownloadHandler({
      invoiceDownloadPort: port,
      invoicePdfProvider: provider,
      authenticateUser: vi.fn(async () => ({ ok: true as const, userId: "user-1" })),
    });
    const res = response();

    await handler(request(), res);

    expect(port.getInvoiceDownloadTicket).toHaveBeenCalledWith("user-1", "99999999-9999-9999-9999-999999999999", "invoice");
    expect(provider.downloadInvoicePdf).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("streams an owned Fakturownia PDF with no-store headers", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    const port = {
      getInvoiceDownloadTicket: vi.fn(async () => ({
        invoiceId: "99999999-9999-9999-9999-999999999999",
        invoiceRef: "FV-1",
        providerKind: "fakturownia",
        providerInvoiceId: "123",
        providerInvoiceNumber: "FV-1",
        artifact: "invoice" as const,
        fileName: "FV-1.pdf",
      })),
    };
    const provider = { downloadInvoicePdf: vi.fn(async () => ({ content: pdf, contentType: "application/pdf" })) };
    const handler = createCustomerInvoiceDownloadHandler({
      invoiceDownloadPort: port,
      invoicePdfProvider: provider,
      authenticateUser: vi.fn(async () => ({ ok: true as const, userId: "user-1" })),
    });
    const res = response();

    await handler(request(), res);

    expect(provider.downloadInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({
      providerKind: "fakturownia",
      providerInvoiceId: "123",
    }));
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", 'attachment; filename="FV-1.pdf"');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(pdf);
  });

  it("streams an owned preview test PDF through the same ticket boundary", async () => {
    const pdf = Buffer.from("%PDF-1.4 TEST");
    const port = {
      getInvoiceDownloadTicket: vi.fn(async () => ({
        invoiceId: "99999999-9999-9999-9999-999999999999",
        invoiceRef: "TEST-1",
        providerKind: "fakturownia_test",
        providerInvoiceId: "test_inv_ORDER-1",
        providerInvoiceNumber: "TEST/FV/2026/ORDER-1",
        artifact: "invoice" as const,
        fileName: "TEST-FV-2026-ORDER-1.pdf",
      })),
    };
    const provider = { downloadInvoicePdf: vi.fn(async () => ({ content: pdf, contentType: "application/pdf" })) };
    const handler = createCustomerInvoiceDownloadHandler({
      invoiceDownloadPort: port,
      invoicePdfProvider: provider,
      authenticateUser: vi.fn(async () => ({ ok: true as const, userId: "user-1" })),
    });
    const res = response();

    await handler(request(), res);

    expect(provider.downloadInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({
      providerKind: "fakturownia_test",
      providerInvoiceId: "test_inv_ORDER-1",
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(pdf);
  });

  it("passes a correction artifact through the ownership-scoped ticket boundary", async () => {
    const port = { getInvoiceDownloadTicket: vi.fn(async () => null) };
    const provider = { downloadInvoicePdf: vi.fn() };
    const handler = createCustomerInvoiceDownloadHandler({
      invoiceDownloadPort: port,
      invoicePdfProvider: provider,
      authenticateUser: vi.fn(async () => ({ ok: true as const, userId: "user-1" })),
    });
    const res = response();
    const req = request();
    req.query.artifact = "correction";

    await handler(req, res);

    expect(port.getInvoiceDownloadTicket).toHaveBeenCalledWith(
      "user-1",
      "99999999-9999-9999-9999-999999999999",
      "correction",
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

function request(): VercelRequest {
  return {
    method: "GET",
    query: { invoiceId: "99999999-9999-9999-9999-999999999999" },
    headers: {},
  } as unknown as VercelRequest;
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), send: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  vi.mocked(res.send).mockReturnValue(res);
  return res;
}
