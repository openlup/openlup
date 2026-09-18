import type {
  AdminSurveyResponsesRequest,
  AdminSurveyResponsesResponse,
  ResearchSurveySubmitRequest,
  ResearchSurveySubmitResponse,
} from "./contracts.js";

/** @beta */
export interface MarketingResearchSurveyResponsesReadPort {
  getAdminSurveyResponses(
    request: AdminSurveyResponsesRequest,
  ): Promise<AdminSurveyResponsesResponse>;
}

/** @beta */
export interface MarketingResearchSurveyRequestHeaders {
  forEach(callbackfn: (value: string, key: string) => void): void;
}

/** @beta */
export interface MarketingResearchSurveySubmitPort {
  submitSurveyResponse(
    request: ResearchSurveySubmitRequest,
    context?: { headers?: MarketingResearchSurveyRequestHeaders },
  ): Promise<ResearchSurveySubmitResponse>;
}
