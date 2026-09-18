import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminClientsPortableSearchResponseSchema,
  type AdminClientsPortableSearchRequest,
  type AdminClientsPortableSearchResponse,
} from "./portableContracts";

/**
 * Look up customer subjects by free text.
 *
 * This is a search, not a browse: the contract requires a non-empty `query`, so
 * callers must not issue a request before the operator has typed something.
 */
export function searchAdminClients(
  accessToken: string,
  request: AdminClientsPortableSearchRequest,
  options: BffRequestOptions = {},
): Promise<AdminClientsPortableSearchResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(
    `/api/bff/admin/clients/search?${queryString(request)}`,
    adminClientsPortableSearchResponseSchema,
    { ...options, method: "GET", headers },
  );
}

function queryString(request: AdminClientsPortableSearchRequest): string {
  return new URLSearchParams({
    query: request.query,
    page: String(request.page),
    pageSize: String(request.pageSize),
    lifecycleStage: request.lifecycleStage,
  }).toString();
}
