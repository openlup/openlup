import { requestBff, type BffRequestOptions } from "../../lib/bff/client";
import {
  adminRiskCaseDecisionResponseSchema,
  adminRiskCaseDetailResponseSchema,
  adminRiskCasesListResponseSchema,
  type AdminRiskCaseDecisionRequest,
  type AdminRiskCaseDecisionResponse,
  type AdminRiskCaseDetailResponse,
  type AdminRiskCasesListRequest,
  type AdminRiskCasesListResponse,
} from "./contracts";

export function getAdminRiskCases(
  accessToken: string,
  request: AdminRiskCasesListRequest,
  options: BffRequestOptions = {},
): Promise<AdminRiskCasesListResponse> {
  return requestBff(
    `/api/bff/admin/risk/cases?${new URLSearchParams(toQuery(request))}`,
    adminRiskCasesListResponseSchema,
    { ...options, headers: authHeaders(accessToken, options.headers) },
  );
}

export function getAdminRiskCaseDetail(
  accessToken: string,
  caseId: string,
  options: BffRequestOptions = {},
): Promise<AdminRiskCaseDetailResponse> {
  return requestBff(
    `/api/bff/admin/risk/cases/detail?${new URLSearchParams({ caseId })}`,
    adminRiskCaseDetailResponseSchema,
    { ...options, headers: authHeaders(accessToken, options.headers) },
  );
}

export function decideAdminRiskCase(
  accessToken: string,
  request: AdminRiskCaseDecisionRequest,
  options: BffRequestOptions = {},
): Promise<AdminRiskCaseDecisionResponse> {
  return requestBff("/api/bff/admin/risk/cases/decision", adminRiskCaseDecisionResponseSchema, {
    ...options,
    method: "POST",
    body: request,
    headers: authHeaders(accessToken, options.headers),
  });
}

function toQuery(request: AdminRiskCasesListRequest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

function authHeaders(accessToken: string, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}
