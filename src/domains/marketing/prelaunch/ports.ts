import type {
  AdminPrelaunchLeadDetailRequest,
  AdminPrelaunchLeadDetailResponse,
  AdminPrelaunchLeadsRequest,
  AdminPrelaunchLeadsResponse,
} from "./contracts.js";

export interface MarketingPrelaunchReadPort {
  listPrelaunchLeads(request: AdminPrelaunchLeadsRequest): Promise<AdminPrelaunchLeadsResponse>;
  getPrelaunchLead(request: AdminPrelaunchLeadDetailRequest): Promise<AdminPrelaunchLeadDetailResponse>;
}
