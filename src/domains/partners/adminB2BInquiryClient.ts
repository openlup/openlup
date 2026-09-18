import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  partnersB2BInquiryListResponseSchema,
  partnersB2BInquiryStatusUpdateResponseSchema,
  type PartnersB2BInquiryListRequest,
  type PartnersB2BInquiryListResponse,
  type PartnersB2BInquiryStatusUpdateRequest,
  type PartnersB2BInquiryStatusUpdateResponse,
} from "./contracts";

const LIST_PATH = "/api/bff/admin/partners/b2b-inquiries";
const STATUS_PATH = "/api/bff/admin/partners/b2b-inquiries/status";

export function getAdminB2BInquiries(
  accessToken: string,
  request: PartnersB2BInquiryListRequest,
  options: BffRequestOptions = {},
): Promise<PartnersB2BInquiryListResponse> {
  return requestBff(`${LIST_PATH}?${listParams(request)}`, partnersB2BInquiryListResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function updateAdminB2BInquiryStatus(
  accessToken: string,
  request: PartnersB2BInquiryStatusUpdateRequest,
  options: BffRequestOptions = {},
): Promise<PartnersB2BInquiryStatusUpdateResponse> {
  return requestBff(STATUS_PATH, partnersB2BInquiryStatusUpdateResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

function listParams(request: PartnersB2BInquiryListRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set("status", request.status);
  params.set("search", request.search);
  params.set("page", String(request.page));
  params.set("pageSize", String(request.pageSize));
  return params;
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
