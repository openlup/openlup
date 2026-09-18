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

export const PARTNER_ACQUISITION_VIEW = "partner_acquisition_v1" as const;
export const PARTNER_ACQUISITION_CONTRACT_VERSION = "partner_acquisition_v1" as const;

const partnerCaseReferenceSchema = z.string().regex(/^acquisition-case:[0-9a-f-]{36}$/);
const partnerContactReferenceSchema = z.string().regex(/^acquisition-contact:[0-9a-f-]{36}$/);
const partnerAcquisitionDateTimeSchema = z.string().datetime({ offset: true });

export const partnerAcquisitionCaseSchema = z.object({
  contractVersion: z.literal(PARTNER_ACQUISITION_CONTRACT_VERSION),
  caseRef: partnerCaseReferenceSchema,
  contactRef: partnerContactReferenceSchema,
  organization: z.object({
    name: z.string().trim().min(2).max(100),
    country: z.string().trim().min(2).max(3),
  }).strict(),
  contact: z.object({
    firstName: z.string().trim().min(2).max(50),
    lastName: z.string().trim().min(2).max(50),
    email: z.string().email(),
    phone: z.string().nullable(),
  }).strict(),
  notes: z.string().max(1000).nullable(),
  status: partnersB2BInquiryStatusSchema,
  version: z.number().int().positive(),
  createdAt: partnerAcquisitionDateTimeSchema,
  updatedAt: partnerAcquisitionDateTimeSchema,
}).strict();

export const partnerAcquisitionListRequestSchema = z.object({
  view: z.literal(PARTNER_ACQUISITION_VIEW),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const partnerAcquisitionListResponseSchema = z.object({
  contractVersion: z.literal(PARTNER_ACQUISITION_CONTRACT_VERSION),
  cases: z.array(partnerAcquisitionCaseSchema),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();

export const partnerAcquisitionTransitionRequestSchema = z.object({
  id: partnerCaseReferenceSchema,
  expectedVersion: z.coerce.number().int().positive(),
  status: partnersB2BInquiryStatusSchema.exclude(["new"]),
}).strict();

export const partnerAcquisitionTransitionResponseSchema = z.object({
  updated: z.literal(true),
  acquisitionCase: partnerAcquisitionCaseSchema,
  replayed: z.boolean(),
}).strict();

export const partnerAcquisitionIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);

export const partnersB2BInquirySubmitRequestSchema = z
  .object({
    company: z.string().trim().min(2).max(100),
    country: z.string().trim().min(1),
    firstName: z.string().trim().min(2).max(50),
    lastName: z.string().trim().min(2).max(50),
    email: z.string().trim().email(),
    phone: z.string().trim().max(50).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    openlupInternalCheck: z.string().optional(),
  })
  .strict();

export const partnersB2BInquirySubmitResponseSchema = z
  .object({
    success: z.literal(true),
    id: z.string().min(1).optional(),
    skipped: z.string().min(1).optional(),
  })
  .strict();

export type PartnersB2BInquiry = z.infer<typeof partnersB2BInquirySchema>;
export type PartnersB2BInquiryListRequest = z.infer<typeof partnersB2BInquiryListRequestSchema>;
export type PartnersB2BInquiryListResponse = z.infer<typeof partnersB2BInquiryListResponseSchema>;
export type PartnersB2BInquirySubmitRequest = z.infer<
  typeof partnersB2BInquirySubmitRequestSchema
>;
export type PartnersB2BInquirySubmitResponse = z.infer<
  typeof partnersB2BInquirySubmitResponseSchema
>;
export type PartnerAcquisitionCase = z.infer<typeof partnerAcquisitionCaseSchema>;
export type PartnerAcquisitionListRequest = z.infer<typeof partnerAcquisitionListRequestSchema>;
export type PartnerAcquisitionListResponse = z.infer<typeof partnerAcquisitionListResponseSchema>;
export type PartnerAcquisitionTransitionRequest = z.infer<
  typeof partnerAcquisitionTransitionRequestSchema
>;
export type PartnerAcquisitionTransitionResponse = z.infer<
  typeof partnerAcquisitionTransitionResponseSchema
>;
