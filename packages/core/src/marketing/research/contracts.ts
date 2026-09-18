import { z } from "zod";

/** @beta */
export type MarketingResearchJson =
  | string
  | number
  | boolean
  | null
  | { [key: string]: MarketingResearchJson | undefined }
  | MarketingResearchJson[];

/** @beta */
export const marketingResearchJsonSchema = z.custom<MarketingResearchJson>(
  isMarketingResearchJson,
  { message: "Expected JSON value" },
);

/** @beta */
export const researchSurveyTypeSchema = z.enum(["producer", "consumer"]);

/** @beta */
export const adminSurveyResponsesRequestSchema = z
  .object({
    surveyType: researchSurveyTypeSchema,
    page: z.coerce.number().int().nonnegative().default(0),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .transform(({ limit, pageSize, ...request }) => ({
    ...request,
    pageSize: pageSize ?? Math.min(limit ?? 50, 100),
  }));

/** @beta */
export const adminSurveyResponseRowSchema = z.object({
  id: z.string().min(1),
  created_at: z.string().min(1),
  response_data: marketingResearchJsonSchema,
});

/** @beta */
export const adminSurveyResponsesResponseSchema = z.object({
  rows: z.array(adminSurveyResponseRowSchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
});

/** @beta */
export const researchSurveySubmitRequestSchema = z
  .object({
    surveyType: researchSurveyTypeSchema,
    responseData: z.record(z.string(), marketingResearchJsonSchema),
  })
  .refine((request) => Object.keys(request.responseData).length > 0, {
    message: "responseData must not be empty",
    path: ["responseData"],
  });

/** @beta */
export const researchSurveySubmitResponseSchema = z.object({
  ok: z.boolean(),
  id: z.string().min(1).optional(),
  error: z.string().optional(),
  email_skipped: z.string().optional(),
});

/** @beta */
export type ResearchSurveyType = z.infer<typeof researchSurveyTypeSchema>;
/** @beta */
export type AdminSurveyResponsesRequest = z.infer<typeof adminSurveyResponsesRequestSchema>;
/** @beta */
export type AdminSurveyResponseRow = z.infer<typeof adminSurveyResponseRowSchema>;
/** @beta */
export type AdminSurveyResponsesResponse = z.infer<typeof adminSurveyResponsesResponseSchema>;
/** @beta */
export type ResearchSurveySubmitRequest = z.infer<typeof researchSurveySubmitRequestSchema>;
/** @beta */
export type ResearchSurveySubmitResponse = z.infer<typeof researchSurveySubmitResponseSchema>;

function isMarketingResearchJson(value: unknown): value is MarketingResearchJson {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isMarketingResearchJson);
  if (typeof value !== "object") return false;

  return Object.values(value as Record<string, unknown>).every(
    (entry) => entry === undefined || isMarketingResearchJson(entry),
  );
}
