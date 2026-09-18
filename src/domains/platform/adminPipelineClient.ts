import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminPipelineDhlTrackingRefreshResponseSchema,
  adminPipelineReadResponseSchema,
  type AdminPipelineDhlTrackingRefreshResponse,
  type AdminPipelineReadResponse,
} from "./contracts";

const READ_PATH = "/api/bff/admin/platform/pipeline";
const REFRESH_PATH = "/api/bff/admin/platform/pipeline/dhl-tracking-refresh";

export function getAdminPipeline(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminPipelineReadResponse> {
  return requestBff(READ_PATH, adminPipelineReadResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function refreshAdminPipelineDhlTracking(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminPipelineDhlTrackingRefreshResponse> {
  return requestBff(REFRESH_PATH, adminPipelineDhlTrackingRefreshResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: {},
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
