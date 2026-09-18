import { z } from "../../../../lib/validation/zod.js";

import { isValidPolishNip, normalizePolishNip } from "@/lib/schemas/fields";

export const ACCOUNT_DEFAULT_COUNTRY = "PL" as const;

export const nullableText = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normalizedText = (value: unknown): string => String(value ?? "").trim().replace(/\s+/g, " ");

export const optionalLabelSchema = z.string().trim().max(120).default("");
export const optionalLongTextSchema = z.string().trim().max(500).default("");
export const optionalLine2Schema = z.string().trim().max(240).default("");

export const taxIdFormSchema = z
  .string()
  .trim()
  .max(64)
  .transform((value) => normalizePolishNip(value))
  .superRefine((value, ctx) => {
    if (value && !isValidPolishNip(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forms:fields.taxId.invalid" });
    }
  });
