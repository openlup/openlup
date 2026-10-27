import type { z } from "zod";
import { adminSettingsReadResponseSchema, adminSettingsUpdateResponseSchema, adminPipelineReadResponseSchema } from "./schemas.js";
import { adminAlertsOverviewResponseSchema } from "./adminAlertsSchemas.js";
import type { AdminSettingsReadResponse, AdminSettingsUpdateRequest, AdminSettingsUpdateResponse, AdminPipelineReadResponse } from "./contracts/admin.js";
import type { AdminAlertsOverviewResponse } from "./contracts/adminAlertsContracts.js";

/** The existing BFF requester owns fetch, envelope validation, cancellation and diagnostics. */
export interface OperationsRequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}
export type OperationsRequestBff = <T>(path: string, schema: z.ZodType<T>, options?: OperationsRequestOptions) => Promise<T>;

/** Bind the existing browser calls without installing an ambient fetch implementation. */
export function createOperationsClients(requestBff: OperationsRequestBff) {
  return {
    getAdminSettings(accessToken: string, options: OperationsRequestOptions = {}): Promise<AdminSettingsReadResponse> {
      return requestBff("/api/bff/admin/platform/settings", adminSettingsReadResponseSchema, {
        ...options, method: "GET", headers: authHeaders(accessToken, options),
      });
    },
    updateAdminSetting(accessToken: string, request: AdminSettingsUpdateRequest, options: OperationsRequestOptions = {}): Promise<AdminSettingsUpdateResponse> {
      return requestBff("/api/bff/admin/platform/settings/update", adminSettingsUpdateResponseSchema, {
        ...options, method: "POST", headers: authHeaders(accessToken, options), body: request,
      });
    },
    getAdminPipeline(accessToken: string, options: OperationsRequestOptions = {}): Promise<AdminPipelineReadResponse> {
      return requestBff("/api/bff/admin/platform/pipeline", adminPipelineReadResponseSchema, {
        ...options, method: "GET", headers: authHeaders(accessToken, options),
      });
    },
    getAdminAlertsOverview(accessToken: string, options: OperationsRequestOptions = {}): Promise<AdminAlertsOverviewResponse> {
      return requestBff("/api/bff/admin/platform/alerts", adminAlertsOverviewResponseSchema, {
        ...options, method: "GET", headers: authHeaders(accessToken, options),
      });
    },
  };
}
function authHeaders(accessToken: string, options: OperationsRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
