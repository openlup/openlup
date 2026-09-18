import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createCatalogSkuPacksHandler } from "../../../../domains/catalog/catalogSkuPacksHandler.js";
import {
  createSupabaseCatalogSkuPacksPort,
  type CatalogSkuPacksSupabaseClient,
} from "../../../../adapters/supabase/catalogSkuPacks.js";
import { createSupabaseDataGateway } from "../../../../adapters/supabase/dataGateway.js";
import { readSupabaseActorDataGatewayEnv } from "../../../../adapters/supabase/dataGatewayClientFactory.js";
import {
  authorizeAdminBooleanWithUser,
  readBearerToken,
} from "../../../../_lib/admin-domain/auth.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseActorDataGatewayEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const gateway = createSupabaseDataGateway(env, {
    resolveAccessToken: () => accessToken,
  });

  return gateway.asActor({ role: "authenticated" }, (client) =>
    createCatalogSkuPacksHandler({
      packsPort: createSupabaseCatalogSkuPacksPort(client as unknown as CatalogSkuPacksSupabaseClient),
      authorizeAdmin: () =>
        authorizeAdmin(client as Parameters<typeof authorizeAdminBooleanWithUser>[0], accessToken),
    })(req, res),
  );
}

async function authorizeAdmin(
  client: Parameters<typeof authorizeAdminBooleanWithUser>[0],
  accessToken: string | null,
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export default withObservedRoute({
  route: "/api/bff/admin/commerce/catalog/sku-eans",
  domain: "catalog",
  surface: "admin",
  risk: "read",
}, handler);
