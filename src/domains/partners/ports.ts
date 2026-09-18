import type {
  PartnerAcquisitionCase,
  PartnerAcquisitionListRequest,
  PartnerAcquisitionListResponse,
  PartnerAcquisitionTransitionRequest,
  PartnersB2BInquiryListRequest,
  PartnersB2BInquiryListResponse,
  PartnersB2BInquirySubmitRequest,
} from "./contracts.js";
import type { PartnersB2BInquiryStatusUpdatePort } from "@openlup/core/partners";

export type PartnersB2BInquiryRequestHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

export interface PartnersB2BInquirySubmitResult {
  success: boolean;
  id?: string;
  skipped?: string;
  error?: string;
  code?: string;
  status?: number;
}

export interface PartnersB2BInquirySubmitPort {
  submitB2BInquiry(
    request: PartnersB2BInquirySubmitRequest,
    context?: { headers?: PartnersB2BInquiryRequestHeaders },
  ): Promise<PartnersB2BInquirySubmitResult>;
}

export interface PartnersB2BInquiryAdminPort extends PartnersB2BInquiryStatusUpdatePort {
  listB2BInquiries(
    request: PartnersB2BInquiryListRequest,
  ): Promise<PartnersB2BInquiryListResponse>;
}

export type PartnerAcquisitionFailureKind =
  | "invalid"
  | "conflict"
  | "rate_limited"
  | "not_found"
  | "unavailable";

export type PartnerAcquisitionResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; error: { kind: PartnerAcquisitionFailureKind } };

export interface PartnerAcquisitionPort {
  submit(command: {
    idempotencyKey: string;
    requesterKey: string;
    policyVersion: string;
    sourcePath: "/partners/b2b-inquiries";
    acceptedAt: string;
    request: PartnersB2BInquirySubmitRequest;
  }): Promise<PartnerAcquisitionResult<PartnerAcquisitionCase>>;
  list(query: PartnerAcquisitionListRequest & { actorRef: string }): Promise<
    PartnerAcquisitionResult<PartnerAcquisitionListResponse>
  >;
  transition(command: {
    actorRef: string;
    idempotencyKey: string;
    request: PartnerAcquisitionTransitionRequest;
  }): Promise<PartnerAcquisitionResult<PartnerAcquisitionCase>>;
  close(): Promise<void>;
}
