import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { withAccountingInvoiceShadowTrigger } from "../../../../domains/accounting/fulfillmentInvoiceTrigger.js";
import {
  createSupabaseOrderInvoicePolicyReader,
  type OrderPolicySupabaseClient,
} from "../../../../adapters/supabase/orderBuyerCommsPolicyReader.js";
import { readAccountingRuntimeConfig } from "../../../../domains/accounting/accountingRuntimeConfig.js";
import { createSupabaseAccountingInvoicePort } from "../../../../adapters/supabase/accountingInvoicePort.js";
import { createAdminCommerceFulfillmentHandOffHandler } from "../../../../domains/fulfillment/commerceFulfillmentHandlers.js";
import { createSupabaseAdminCommerceFulfillmentGateway } from "../../../../adapters/supabase/adminCommerceFulfillmentGateway.js";
import { readAccountingLedgerProviderKind } from "../../../../infra/accounting/providerFactory.js";
import {
  authorizeCommerceFulfillmentAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminCommerceFulfillmentEnv,
} from "./shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceFulfillmentEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce fulfillment is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const attachAccountingHandoffTrigger = shouldAttachAccountingHandoffTrigger(process.env);
  const accountingProviderKind = readAccountingLedgerProviderKind(process.env);
  const gateway = createSupabaseAdminCommerceFulfillmentGateway(env, {
    handoffPortDecorator: attachAccountingHandoffTrigger
      ? (fulfillmentPort, serviceClient) =>
          withAccountingInvoiceShadowTrigger(fulfillmentPort, {
            accountingPort: createSupabaseAccountingInvoicePort(serviceClient),
            providerKind: accountingProviderKind,
            // Wave B6: an operator hand-off of a channel order must respect the
            // channel's invoice policy exactly as the automatic path does.
            invoicePolicyReader: createSupabaseOrderInvoicePolicyReader(
              serviceClient as unknown as OrderPolicySupabaseClient,
            ),
          })
      : undefined,
  });

  return createAdminCommerceFulfillmentHandOffHandler({
    fulfillmentPort: gateway.handoffPort,
    authorizeAdmin: () => authorizeCommerceFulfillmentAdminWithUser(authClient, accessToken),
  })(req, res);
}

export function shouldAttachAccountingHandoffTrigger(env: Record<string, string | undefined>): boolean {
  const accountingConfig = readAccountingRuntimeConfig(env);
  return accountingConfig.requestEnabled && accountingConfig.issueTrigger === "handoff";
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/commerce-orders/hand-off",
  domain: "fulfillment",
  surface: "admin",
  risk: "mutation",
  featureFlags: ["ACCOUNTING_REQUEST_ENABLED", "ACCOUNTING_ISSUE_TRIGGER", "COMMERCE_ACCOUNTING_SHADOW_ENABLED", "COMMERCE_ACCOUNTING_PROVIDER_MODE"],
}, handler);
