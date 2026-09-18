import { withObservedRoute } from "../../_lib/observability/route.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCompanyIdentityLookupHandler } from "../../domains/company-identity/companyIdentityHandlers.js";
import { invoiceDataLookupEnabled } from "../accounting/shared.js";
import { createCompanyIdentityLookupPortFromEnv } from "./shared.js";

const lookupHandler = createCompanyIdentityLookupHandler({
  lookupPort: createCompanyIdentityLookupPortFromEnv(process.env),
});

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!invoiceDataLookupEnabled(process.env)) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Company identity lookup is disabled", {
      details: {
        feature: "company_identity_lookup",
        featureFlag: "COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED",
        reason: "feature_flag_disabled",
      },
    });
    return Promise.resolve();
  }
  return lookupHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/company-identity/lookup",
  domain: "company-identity",
  surface: "hidden",
  risk: "read",
  featureFlags: ["COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED"],
}, handler);
