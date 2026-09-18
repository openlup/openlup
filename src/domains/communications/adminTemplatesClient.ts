import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminEmailTemplatesResponseSchema,
  updateAdminEmailTemplateActiveResponseSchema,
  updateAdminEmailTemplateContentResponseSchema,
  type AdminEmailTemplatesResponse,
  type UpdateAdminEmailTemplateActiveRequest,
  type UpdateAdminEmailTemplateActiveResponse,
  type UpdateAdminEmailTemplateContentRequest,
  type UpdateAdminEmailTemplateContentResponse,
} from "./contracts";

const TEMPLATES_PATH = "/api/bff/admin/communications/templates";
const TEMPLATE_ACTIVE_PATH = "/api/bff/admin/communications/templates/active";
const TEMPLATE_CONTENT_PATH = "/api/bff/admin/communications/templates/content";

export function getAdminEmailTemplates(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminEmailTemplatesResponse> {
  return requestBff(TEMPLATES_PATH, adminEmailTemplatesResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function updateAdminEmailTemplateActive(
  accessToken: string,
  request: UpdateAdminEmailTemplateActiveRequest,
  options: BffRequestOptions = {},
): Promise<UpdateAdminEmailTemplateActiveResponse> {
  return requestBff(TEMPLATE_ACTIVE_PATH, updateAdminEmailTemplateActiveResponseSchema, {
    ...options,
    method: "PATCH",
    body: request,
    headers: authHeaders(accessToken, options),
  });
}

export function updateAdminEmailTemplateContent(
  accessToken: string,
  request: UpdateAdminEmailTemplateContentRequest,
  options: BffRequestOptions = {},
): Promise<UpdateAdminEmailTemplateContentResponse> {
  return requestBff(TEMPLATE_CONTENT_PATH, updateAdminEmailTemplateContentResponseSchema, {
    ...options,
    method: "PATCH",
    body: request,
    headers: authHeaders(accessToken, options),
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
