import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAccountingProviderSyncHandler } from "../../../domains/accounting/accountingHandlers.js";
import { createSupabaseAdminAccountingGateway } from "../../../adapters/supabase/adminAccountingGateway.js";
import {
  accountingMutationsEnabled,
  authorizeAccountingAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAccountingEnv,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminAccountingEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Accounting environment is not configured");
    return;
  }
  if (!accountingMutationsEnabled()) {
    sendBffError(res, "FORBIDDEN", "Accounting mutations are not enabled");
    return;
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const gateway = createSupabaseAdminAccountingGateway(env);
  const route = createAccountingProviderSyncHandler({
    authorizeAdmin: () => authorizeAccountingAdminWithUser(authClient, accessToken),
    accountingPort: gateway.controlPort(),
    mutationsEnabled: accountingMutationsEnabled,
  });

  await route(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/accounting/provider-sync",
  domain: "accounting",
  surface: "admin",
  risk: "mutation",
  featureFlags: ["COMMERCE_ACCOUNTING_MUTATIONS_ENABLED"],
}, handler);
