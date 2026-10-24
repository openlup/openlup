import { createInvoiceReadModel } from "@openlup/platform/invoicing";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { customerInvoiceDownloadRequestSchema } from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerInvoiceDownloadPort, CustomerInvoiceDownloadTicket } from "./ports.js";

export interface CustomerInvoicePdfProvider {
  downloadInvoicePdf(ticket: CustomerInvoiceDownloadTicket): Promise<{ content: Buffer; contentType: string }>;
}

export interface CustomerInvoiceDownloadDeps {
  invoiceDownloadPort: CustomerInvoiceDownloadPort;
  invoicePdfProvider: CustomerInvoicePdfProvider | null;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerInvoiceDownloadHandler({
  invoiceDownloadPort,
  invoicePdfProvider,
  authenticateUser,
}: CustomerInvoiceDownloadDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    let authentication: CustomerUserAuthenticationResult;
    try {
      authentication = await authenticateUser(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed");
      return;
    }
    if (authentication.ok === false) return sendBffError(res, authentication.code, authentication.message);

    const parsed = customerInvoiceDownloadRequestSchema.safeParse({
      invoiceId: queryValue(req.query.invoiceId),
      artifact: queryValue(req.query.artifact),
    });
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid invoice download request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    if (!invoicePdfProvider) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invoice download provider is not configured");
      return;
    }

    try {
      const result = await createInvoiceReadModel().ownedPdf({
        resolve: () => invoiceDownloadPort.getInvoiceDownloadTicket(
          authentication.userId, parsed.data.invoiceId, parsed.data.artifact,
        ),
        download: ticket => invoicePdfProvider.downloadInvoicePdf(ticket),
      });
      if (result.kind === "denied") return sendBffError(res, "NOT_FOUND", "Customer invoice was not found");
      const { ticket, pdf } = result;
      res.setHeader("Content-Type", pdf.contentType || "application/pdf");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${ticket.fileName}"`);
      res.status(200).send(pdf.content);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invoice PDF download failed");
    }
  };
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
