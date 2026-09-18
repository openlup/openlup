import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminShipmentsOverviewResponseSchema,
  type AdminShipmentsOverviewRequest,
  type AdminShipmentsOverviewResponse,
} from "./contracts";

const PATH = "/api/bff/admin/fulfillment/shipments-overview";

export function getAdminShipmentsOverview(
  accessToken: string,
  request: AdminShipmentsOverviewRequest,
  options: BffRequestOptions = {},
): Promise<AdminShipmentsOverviewResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(`${PATH}?${queryString(request)}`, adminShipmentsOverviewResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}

function queryString(request: AdminShipmentsOverviewRequest): string {
  const params = new URLSearchParams();
  params.set("shippedFilter", request.shippedFilter);
  return params.toString();
}
