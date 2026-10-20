import { readProcessEnvironment } from "../../../_lib/observability/runtimeProvenance.js";
import { createPostgresNotificationRecipientsPort } from "@openlup/platform/communications";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createCommunicationsNotificationRecipientsHandler,
} from "../../../domains/communications/notificationRecipientsHandler.js";
import { createSupabaseCommunicationsActorGateway } from "../../../adapters/supabase/communicationsGateway.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../_lib/admin-domain/auth.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const runtimeEnv=readProcessEnvironment();
  if (runtimeEnv.PLATFORM_BUNDLE === "node-postgres") {
    const token=readBearerToken(req),auth=resolveAdminAuthBinding(runtimeEnv);
    if(!auth.binding)return sendBffError(res,"UPSTREAM_UNAVAILABLE","Admin authorization unavailable");
    try {await auth.binding.run(token,async port=>{
      const authorization=await port.authorize(token,{allowedRoles:["admin"]});
      if(!authorization.ok)return sendBffError(res,authorization.code,authorization.message);
      const connectionString=runtimeEnv.DATABASE_URL?.trim();if(!connectionString)throw new Error("database_url_required");
      const recipients=createPostgresNotificationRecipientsPort({connectionString},{operatorId:authorization.principalId});
      try{await createCommunicationsNotificationRecipientsHandler({recipientsPort:recipients,authorizeAdmin:async()=>true})(req,res);}finally{await recipients.close();}
    });}catch{sendBffError(res,"UPSTREAM_UNAVAILABLE","Notification recipients unavailable");}
    return;
  }
  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  return createCommunicationsNotificationRecipientsHandler({
    recipientsPort: createSupabaseCommunicationsActorGateway(client).notificationRecipientsPort(),
    authorizeAdmin: () => authorizeAdmin(client, accessToken),
  })(req, res);
}

async function authorizeAdmin(
  client: Parameters<typeof authorizeAdminBooleanWithUser>[0],
  accessToken: string | null,
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/notification-recipients",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, handler);
