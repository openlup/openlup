import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { createResearchSurveySubmitHandler } from "../../../domains/marketing/research/surveyResponseSubmitHandler.js";
import { createSupabaseResearchSurveySubmitPort } from "../../../adapters/supabase/researchSurveySubmitPort.js";
import {
  handleAcquisitionSurveySubmit,
  isAcquisitionSurveyView,
  isDirectAcquisitionEvidenceBundle,
} from "./acquisitionEvidenceDirect.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (isDirectAcquisitionEvidenceBundle()) {
    if (isAcquisitionSurveyView(req)) return handleAcquisitionSurveySubmit(req, res);
    return sendDirectUnavailable(res);
  }
  return createResearchSurveySubmitHandler({
    submitPort: createSupabaseResearchSurveySubmitPort(),
  })(req, res);
}

function sendDirectUnavailable(res: VercelResponse): void {
  res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Acquisition survey view required" } });
}

export default withObservedRoute({
  route: "/api/bff/marketing/research/survey-responses",
  domain: "marketing",
  surface: "public",
  risk: "validation_mutation",
}, handler);
