import { readProcessEnvironment } from "../../_lib/observability/runtimeProvenance.js";
import { resolveCommunicationPreferenceBinding } from "../../runtime/communications/preferenceBinding.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { verifyCommunicationPreferenceToken } from "../../domains/communications/preferencesToken.js";
import { createSupabasePublicCommunicationPreferencesGateway } from "../../adapters/supabase/communications/gateway.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  const runtimeEnv=readProcessEnvironment();
  if (runtimeEnv.PLATFORM_BUNDLE === "node-postgres") {
    const payload = verifyCommunicationPreferenceToken(isRecord(req.body) && typeof req.body.token === "string" ? req.body.token : "", runtimeEnv.COMMUNICATION_PREFERENCES_TOKEN_SECRET ?? "");
    if (!payload) return sendBffError(res,"BAD_REQUEST","Invalid or expired communication preference token");
    try { const port=resolveCommunicationPreferenceBinding(runtimeEnv); const state=isRecord(req.body)&&req.body.state==="denied"?"denied":"suppressed";
      sendBffSuccess(res,await port.updatePreference(payload,state));
    } catch {sendBffError(res,"UPSTREAM_UNAVAILABLE","Communication preference write failed");}
    return;
  }
  const env = readEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communication preferences are not configured");
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const token = typeof body.token === "string" ? body.token : "";
  const payload = verifyCommunicationPreferenceToken(token, env.tokenSecret);
  if (!payload) {
    sendBffError(res, "BAD_REQUEST", "Invalid or expired communication preference token");
    return;
  }

  const state = body.state === "denied" ? "denied" : "suppressed";
  const gateway = createSupabasePublicCommunicationPreferencesGateway({
    url: env.supabaseUrl,
    serviceRoleKey: env.serviceRoleKey,
  });
  const port = gateway.preferenceTokenPort();

  try {
    sendBffSuccess(res, await port.updatePreference(payload, state));
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communication preference write failed");
  }
}

function readEnv(): { supabaseUrl: string; serviceRoleKey: string; tokenSecret: string } | null {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tokenSecret = process.env.COMMUNICATION_PREFERENCES_TOKEN_SECRET;
  return supabaseUrl && serviceRoleKey && tokenSecret
    ? { supabaseUrl, serviceRoleKey, tokenSecret }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export default withObservedRoute({
  route: "/api/bff/communications/preferences",
  domain: "communications",
  surface: "public",
  risk: "validation_mutation",
}, handler);
