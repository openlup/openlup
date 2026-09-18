import { z } from "../../lib/validation/zod.js";

export const CLIENTS_CONTRACT_VERSION = "2026-05-29.app-3a";
export const adminClientLifecycleStageSchema = z.enum([
  "lead", "waitlist", "tester", "customer", "inactive",
]);

const nullableTrimmedStringSchema = z.string().trim().nullable();
const nullableDateTimeStringSchema = z.string().datetime({ offset: true }).nullable();

export const adminClientsSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().nonnegative().max(2_147_483_647).default(0),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  lifecycleStage: z.union([z.literal("all"), adminClientLifecycleStageSchema]).default("all"),
}).strict();

export const adminClientsSearchCandidateSchema = z.object({
  clientId: z.string().min(1).nullable(),
  displayName: nullableTrimmedStringSchema,
  email: nullableTrimmedStringSchema,
  phone: nullableTrimmedStringSchema,
  lifecycleStage: adminClientLifecycleStageSchema.nullable(),
  sources: z.array(z.enum(["physical_client", "tester", "waitlist"])).min(1),
  testerId: z.string().min(1).nullable(),
  testerStatus: nullableTrimmedStringSchema,
  waitlistId: z.string().min(1).nullable(),
  latestOrderId: z.string().min(1).nullable(),
  latestOrderNumber: nullableTrimmedStringSchema,
  latestOrderStatus: nullableTrimmedStringSchema,
  createdAt: nullableDateTimeStringSchema,
  lastActivityAt: nullableDateTimeStringSchema,
  matchReason: z.enum(["id", "email", "phone", "name", "order", "subscription", "text"]),
  confidence: z.enum(["exact", "high", "medium"]),
}).strict();

export const adminClientsSearchResponseSchema = z.object({
  contractVersion: z.literal(CLIENTS_CONTRACT_VERSION),
  candidates: z.array(adminClientsSearchCandidateSchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
});

export type AdminClientsSearchRequest = z.infer<typeof adminClientsSearchRequestSchema>;
export type AdminClientsSearchCandidate = z.infer<typeof adminClientsSearchCandidateSchema>;
export type AdminClientsSearchResponse = z.infer<typeof adminClientsSearchResponseSchema>;
