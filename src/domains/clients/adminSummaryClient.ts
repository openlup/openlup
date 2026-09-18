import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminClientsPortableSummaryResponseSchema,
  type AdminClientsPortableSummaryResponse,
} from "./portableContracts";

export function getAdminClientsSummary(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminClientsPortableSummaryResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(
    "/api/bff/admin/clients/summary",
    adminClientsPortableSummaryResponseSchema,
    {
      ...options,
      method: "GET",
      headers,
    },
  );
}
