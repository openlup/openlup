import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminAlertsOverviewResponseSchema,
  type AdminAlertsOverviewResponse,
} from "./adminAlertsContracts";

export function getAdminAlertsOverview(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminAlertsOverviewResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return requestBff("/api/bff/admin/platform/alerts", adminAlertsOverviewResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}
