import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAccountingOrderSummaryHandler } from "../../../domains/accounting/accountingHandlers.js";
import { createSupabaseAdminAccountingGateway } from "../../../adapters/supabase/adminAccountingGateway.js";
import {
  authorizeAccountingAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAccountingEnv,
} from "./shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminAccountingEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin accounting is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const gateway = createSupabaseAdminAccountingGateway(env);

  return createAccountingOrderSummaryHandler({
    accountingPort: gateway.readPort(),
    authorizeAdmin: () => authorizeAccountingAdminWithUser(authClient, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/accounting/order-summary",
  domain: "accounting",
  surface: "admin",
  risk: "read",
}, handler);
