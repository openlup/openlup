import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createInvoiceDataLookupHandler } from "../../domains/accounting/accountingHandlers.js";
import { createHiddenInvoiceDataLookupRoute } from "./shared.js";

const invoiceDataLookupHandler = createHiddenInvoiceDataLookupRoute((port) =>
  createInvoiceDataLookupHandler({ lookupPort: port }),
);

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return invoiceDataLookupHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/accounting/invoice-data-lookup",
  domain: "accounting",
  surface: "hidden",
  risk: "read",
  featureFlags: ["COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED"],
}, handler);
