import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminPrelaunchLeadDetailResponseSchema,
  adminPrelaunchLeadsResponseSchema,
  type AdminPrelaunchLeadDetailResponse,
  type AdminPrelaunchLeadsRequest,
  type AdminPrelaunchLeadsResponse,
  type PrelaunchLeadSourceRef,
} from "./contracts";

const LIST_PATH = "/api/bff/admin/marketing/prelaunch/leads";

export function getAdminMarketingPrelaunchLeads(
  accessToken: string,
  request: Partial<AdminPrelaunchLeadsRequest> = {},
  options: BffRequestOptions = {},
): Promise<AdminPrelaunchLeadsResponse> {
  const params = new URLSearchParams({
    page: String(request.page ?? 0),
    pageSize: String(request.pageSize ?? 50),
  });
  if (request.query) params.set("query", request.query);
  if (request.source) params.set("source", request.source);
  if (request.stage) params.set("stage", request.stage);

  return requestBff(`${LIST_PATH}?${params}`, adminPrelaunchLeadsResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function getAdminMarketingPrelaunchLeadDetail(
  accessToken: string,
  sourceRef: PrelaunchLeadSourceRef,
  options: BffRequestOptions = {},
): Promise<AdminPrelaunchLeadDetailResponse> {
  return requestBff(`${LIST_PATH}/${encodeURIComponent(sourceRef)}`, adminPrelaunchLeadDetailResponseSchema, {
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
