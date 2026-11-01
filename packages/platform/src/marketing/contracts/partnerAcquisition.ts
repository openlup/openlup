import type { PartnersB2BInquiryStatus } from "@openlup/core/partners";

/** A captured inquiry contact is not a customer identity or marketing permission. */
export interface PartnerAcquisitionCase {
  contractVersion: "partner_acquisition_v1";
  caseRef: string;
  contactRef: string;
  organization: { name: string; country: string };
  contact: { firstName: string; lastName: string; email: string; phone: string | null };
  notes: string | null;
  status: PartnersB2BInquiryStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface PartnerAcquisitionListRequest {
  view: "partner_acquisition_v1";
  cursor?: string | undefined;
  limit: number;
}
export interface PartnerAcquisitionListResponse {
  contractVersion: "partner_acquisition_v1";
  cases: PartnerAcquisitionCase[];
  nextCursor: string | null;
}
export interface PartnerAcquisitionTransitionRequest {
  id: string;
  expectedVersion: number;
  status: Exclude<PartnersB2BInquiryStatus, "new">;
}
export interface PartnerAcquisitionTransitionResponse {
  updated: true;
  acquisitionCase: PartnerAcquisitionCase;
  replayed: boolean;
}
export type PartnerAcquisitionIdempotencyKey = string;
export interface PartnersB2BInquirySubmitRequest {
  company: string;
  country: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null | undefined;
  notes?: string | null | undefined;
  openlupInternalCheck?: string | undefined;
}
export interface PartnersB2BInquirySubmitResponse {
  success: true;
  id?: string | undefined;
  skipped?: string | undefined;
}
export type PartnerAcquisitionFailureKind = "invalid" | "conflict" | "rate_limited" | "not_found" | "unavailable";
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
  list(query: PartnerAcquisitionListRequest & { actorRef: string }): Promise<PartnerAcquisitionResult<PartnerAcquisitionListResponse>>;
  transition(command: {
    actorRef: string;
    idempotencyKey: string;
    request: PartnerAcquisitionTransitionRequest;
  }): Promise<PartnerAcquisitionResult<PartnerAcquisitionCase>>;
  close(): Promise<void>;
}
