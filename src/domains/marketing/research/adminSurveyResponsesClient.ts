import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminSurveyResponsesResponseSchema,
  type AdminSurveyResponsesResponse,
  type ResearchSurveyType,
} from "./contracts";

const PATH = "/api/bff/admin/marketing/research/survey-responses";

export interface GetAdminSurveyResponsesRequest {
  surveyType: ResearchSurveyType;
  page?: number;
  pageSize?: number;
}

export function getAdminSurveyResponses(
  accessToken: string,
  request: GetAdminSurveyResponsesRequest,
  options: BffRequestOptions = {},
): Promise<AdminSurveyResponsesResponse> {
  const params = new URLSearchParams({
    surveyType: request.surveyType,
    page: String(request.page ?? 0),
    pageSize: String(request.pageSize ?? 50),
  });

  return requestBff(`${PATH}?${params}`, adminSurveyResponsesResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
