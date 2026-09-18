import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  companyIdentityLookupRequestSchema,
  companyIdentityLookupResponseSchema,
  type CompanyIdentityLookupRequest,
  type CompanyIdentityLookupResponse,
} from "./companyIdentityContracts";

export function lookupCompanyIdentity(
  request: CompanyIdentityLookupRequest,
  options: BffRequestOptions = {},
): Promise<CompanyIdentityLookupResponse> {
  return requestBff(
    "/api/bff/company-identity/lookup",
    companyIdentityLookupResponseSchema,
    {
      ...options,
      method: "POST",
      body: companyIdentityLookupRequestSchema.parse(request),
    },
  );
}
