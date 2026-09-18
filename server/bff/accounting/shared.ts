import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";
import {
  createCompanyIdentityLookupPortFromEnv,
  createInvoiceDataLookupPortFromCompanyIdentity,
} from "../company-identity/shared.js";

type InvoiceDataLookupHandlerFactory = (
  port: InvoiceDataLookupPort,
) => (req: VercelRequest, res: VercelResponse) => Promise<void>;

export function createHiddenInvoiceDataLookupRoute(
  factory: InvoiceDataLookupHandlerFactory,
) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!invoiceDataLookupEnabled(process.env)) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invoice data lookup is disabled", {
        details: {
          feature: "invoice_data_lookup",
          featureFlag: "COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    return factory(createInvoiceDataLookupPortFromEnv(process.env))(req, res);
  };
}

export function invoiceDataLookupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED === "false") return false;
  return env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED === "true" || env.VERCEL_ENV === "preview";
}

export function createInvoiceDataLookupPortFromEnv(
  env: Record<string, string | undefined>,
): InvoiceDataLookupPort {
  return createInvoiceDataLookupPortFromCompanyIdentity(
    createCompanyIdentityLookupPortFromEnv(env),
  );
}
