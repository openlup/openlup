// Evaluate the browser configuration before the package constructs any schemas.
import "../../../lib/validation/zod.js";

export {
  ACQUISITION_SURVEY_VERSION,
  ACQUISITION_NEWSLETTER_VERSION,
  acquisitionSurveySubmitSchema,
  acquisitionSurveyEvidenceSchema,
  acquisitionSurveySubmitResponseSchema,
  acquisitionSurveyListQuerySchema,
  acquisitionSurveyListResponseSchema,
  acquisitionNewsletterConsentEventSchema,
  acquisitionNewsletterConsentResponseSchema,
} from "@openlup/platform/marketing";
export type {
  AcquisitionSurveySubmit,
  AcquisitionSurveyEvidence,
  AcquisitionSurveySubmitResponse,
  AcquisitionSurveyListQuery,
  AcquisitionSurveyListResponse,
  AcquisitionNewsletterConsentEvent,
  AcquisitionNewsletterConsentResponse,
} from "@openlup/platform/marketing/contracts";
