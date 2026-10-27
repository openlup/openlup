import { createOperationsClients } from "@openlup/platform/operations";
import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminPipelineDhlTrackingRefreshResponseSchema,
  type AdminPipelineDhlTrackingRefreshResponse,
} from "./contracts";

const REFRESH_PATH = "/api/bff/admin/platform/pipeline/dhl-tracking-refresh";

export const getAdminPipeline = createOperationsClients(requestBff).getAdminPipeline;

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
