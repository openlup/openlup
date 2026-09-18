import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  partnersB2BInquirySubmitResponseSchema,
  type PartnersB2BInquirySubmitRequest,
  type PartnersB2BInquirySubmitResponse,
} from "./contracts";

export function submitPublicB2BInquiry(
  request: PartnersB2BInquirySubmitRequest,
  options: BffRequestOptions = {},
): Promise<PartnersB2BInquirySubmitResponse> {
  return requestBff(
    "/api/bff/partners/b2b-inquiries",
    partnersB2BInquirySubmitResponseSchema,
    {
      ...options,
      method: "POST",
      body: request,
    },
  );
}

/**
 * One key per mounted inquiry form. Minted during render, so an environment
 * without `crypto.randomUUID` (insecure HTTP context, Safari/iOS below 15.4)
 * must degrade to a deterministic fallback rather than throw and blank the
 * whole public route. The server treats the key as an opaque bounded string.
 */
export function createPartnerInquiryIdempotencyKey(): string {
  const value =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `partner-${value}`;
}
