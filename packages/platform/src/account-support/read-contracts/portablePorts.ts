import type {
  AdminClientsPortableDetailRequest,
  AdminClientsPortableDetailResponse,
  AdminClientsPortableSearchRequest,
  AdminClientsPortableSearchResponse,
  AdminClientsPortableSummaryRequest,
  AdminClientsPortableSummaryResponse,
} from "./portableContracts.js";

/** Provider-neutral customer index used by the portable operator console. */
export interface ClientsPortableAdminReadPort {
  getPortableSummary(
    request: AdminClientsPortableSummaryRequest,
  ): Promise<AdminClientsPortableSummaryResponse>;
  searchPortableClients(
    request: AdminClientsPortableSearchRequest,
  ): Promise<AdminClientsPortableSearchResponse>;
  getPortableClientDetail(
    request: AdminClientsPortableDetailRequest,
  ): Promise<AdminClientsPortableDetailResponse | null>;
}
