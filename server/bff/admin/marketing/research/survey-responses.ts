import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createAdminSurveyResponsesHandler } from "../../../../domains/marketing/research/adminSurveyResponsesHandler.js";
import {
  createSupabaseAdminSurveyResponsesPort,
  type AdminSurveyResponsesSupabaseClient,
} from "../../../../adapters/supabase/marketing/adminSurveyResponsesPort.js";
import {
  handleAcquisitionSurveyList,
  isDirectAcquisitionEvidenceBundle,
} from "../../../marketing/research/acquisitionEvidenceDirect.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../../_lib/admin-domain/auth.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (isDirectAcquisitionEvidenceBundle()) {
    if ((Array.isArray(req.query.view) ? req.query.view[0] : req.query.view) === "acquisition_survey_v1") {
      return handleAcquisitionSurveyList(req, res);
    }
    sendBffError(res, "NOT_FOUND", "Acquisition survey view unavailable");
    return;
  }
  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  return createAdminSurveyResponsesHandler({
    readPort: createSupabaseAdminSurveyResponsesPort(client as unknown as AdminSurveyResponsesSupabaseClient),
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
  route: "/api/bff/admin/marketing/research/survey-responses",
  domain: "marketing",
  surface: "admin",
  risk: "read",
}, handler);
