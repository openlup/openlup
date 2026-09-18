import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { createCustomerInvoiceDownloadHandler } from "../../../domains/customers/customerInvoiceDownloadHandler.js";
import { createSupabaseCustomerAccountV2Port } from "../../../adapters/supabase/customerAccountV2Port.js";
import { createFakturowniaClient, readFakturowniaReadClientConfig } from "../../../infra/fakturownia/client.js";
import { createTestInvoicePdfProvider } from "../../../infra/accounting/testInvoicePdfProvider.js";
import type { CustomerInvoiceDownloadTicket } from "../../../domains/customers/ports.js";
import {
  authenticateCustomerUser,
  createCustomerClients,
  customerSelfServiceEnabled,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!customerSelfServiceEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer self-service is disabled", {
      details: { feature: "customer_self_service", reason: "feature_flag_disabled" },
    });
    return;
  }
  const env = readCustomerSelfServiceEnv();
  if (!env) return sendBffError(res, "INTERNAL", "Supabase environment is not configured");
  const accessToken = readBearerToken(req);
  const clients = createCustomerClients(env, accessToken);
  const invoicePdfProvider = createInvoicePdfProvider(process.env);
  return createCustomerInvoiceDownloadHandler({
    invoiceDownloadPort: createSupabaseCustomerAccountV2Port(clients),
    invoicePdfProvider,
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
  })(req, res);
}

function createInvoicePdfProvider(env: Record<string, string | undefined>) {
  const fakturowniaConfig = readFakturowniaReadClientConfig(env);
  const fakturownia = fakturowniaConfig ? createFakturowniaClient(fakturowniaConfig) : null;
  const testPdf = env.COMMERCE_ACCOUNTING_TEST_PDF_ENABLED === "true" && env.VERCEL_ENV !== "production"
    ? createTestInvoicePdfProvider()
    : null;
  if (!fakturownia && !testPdf) return null;
  return {
    downloadInvoicePdf(ticket: CustomerInvoiceDownloadTicket) {
      if (ticket.providerKind === "fakturownia_test" && testPdf) return testPdf.downloadInvoicePdf(ticket);
      if (ticket.providerKind === "fakturownia" && fakturownia) {
        return fakturownia.downloadInvoicePdf(ticket.providerInvoiceId);
      }
      throw new Error("invoice_download_provider_not_configured");
    },
  };
}

export default withObservedRoute({
  route: "/api/bff/customers/invoices/download",
  domain: "customers",
  surface: "customer",
  risk: "provider",
  featureFlags: [
    "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED",
    "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
    "COMMERCE_ACCOUNTING_PREVIEW_UI_ENABLED",
    "COMMERCE_ACCOUNTING_TEST_PDF_ENABLED",
  ],
}, handler);
