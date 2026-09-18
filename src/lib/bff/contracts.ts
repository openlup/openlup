import { z } from "../validation/zod.js";

export const BFF_REQUEST_REFERENCE_HEADER = "x-request-id";
export const bffRequestReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export function isBffRequestReference(value: unknown): value is string {
  return bffRequestReferenceSchema.safeParse(value).success;
}

export const bffErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
  "INVALID_RESPONSE",
]);

export const bffMetaSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    contractVersion: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

export const bffErrorSchema = z.object({
  code: bffErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
});

export function bffSuccessSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
    meta: bffMetaSchema.optional(),
  });
}

export const bffErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: bffErrorSchema,
  meta: bffMetaSchema.optional(),
});

export function bffResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.union([bffSuccessSchema(dataSchema), bffErrorResponseSchema]);
}

export type BffErrorCode = z.infer<typeof bffErrorCodeSchema>;
export type BffMeta = z.infer<typeof bffMetaSchema>;
export type BffError = z.infer<typeof bffErrorSchema>;

export type BffSuccessResponse<T> = {
  ok: true;
  data: T;
  meta?: BffMeta;
};

export type BffErrorResponse = {
  ok: false;
  error: BffError;
  meta?: BffMeta;
};

export type BffResponse<T> = BffSuccessResponse<T> | BffErrorResponse;
