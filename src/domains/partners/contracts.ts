import { z } from "../../lib/validation/zod.js";
import { partnersB2BInquiryStatusSchema } from "@openlup/core/partners";

export {
  partnersB2BInquiryStatusUpdateRequestSchema,
  partnersB2BInquiryStatusUpdateResponseSchema,
} from "@openlup/core/partners";
export { partnersB2BInquiryStatusSchema };
export type {
  PartnersB2BInquiryStatus,
  PartnersB2BInquiryStatusUpdateRequest,
  PartnersB2BInquiryStatusUpdateResponse,
} from "@openlup/core/partners";

const nullableString = z.string().nullable();

export const partnersB2BInquirySchema = z.object({
  id: z.string().min(1),
  created_at: z.string().min(1),
  company: z.string().min(1),
  website: nullableString,
  country: z.string().min(1),
  company_type: nullableString,
  revenue_bucket: nullableString,
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  business_email: z.string().email(),
  phone: nullableString,
  interests: z.array(z.string()).nullable(),
  notes: nullableString,
  ip_hash: nullableString,
  pipedrive_deal_id: z.number().int().nullable(),
  status: z.string().min(1),
});

export const partnersB2BInquiryListRequestSchema = z.object({
  status: z.string().trim().min(1).max(50).default("all"),
  search: z.string().trim().max(120).default(""),
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const partnersB2BInquiryListResponseSchema = z.object({
  inquiries: z.array(partnersB2BInquirySchema),
  totalCount: z.number().int().min(0),
  newCount: z.number().int().min(0),
});

export {
  PARTNER_ACQUISITION_VIEW,
  PARTNER_ACQUISITION_CONTRACT_VERSION,
  partnerAcquisitionCaseSchema,
  partnerAcquisitionListRequestSchema,
  partnerAcquisitionListResponseSchema,
  partnerAcquisitionTransitionRequestSchema,
  partnerAcquisitionTransitionResponseSchema,
  partnerAcquisitionIdempotencyKeySchema,
  partnersB2BInquirySubmitRequestSchema,
  partnersB2BInquirySubmitResponseSchema,
} from "@openlup/platform/marketing";
export type {
  PartnerAcquisitionCase,
  PartnerAcquisitionListRequest,
  PartnerAcquisitionListResponse,
  PartnerAcquisitionTransitionRequest,
  PartnerAcquisitionTransitionResponse,
  PartnersB2BInquirySubmitRequest,
  PartnersB2BInquirySubmitResponse,
} from "@openlup/platform/marketing/contracts";

export type PartnersB2BInquiry = z.infer<typeof partnersB2BInquirySchema>;
export type PartnersB2BInquiryListRequest = z.infer<typeof partnersB2BInquiryListRequestSchema>;
export type PartnersB2BInquiryListResponse = z.infer<typeof partnersB2BInquiryListResponseSchema>;
