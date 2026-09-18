import { z } from "../../lib/validation/zod.js";

export const optionalNullableField = <T>(schema: z.ZodType<T, unknown>) =>
  z
    .union([schema, z.null()])
    .transform((value): T | null => (value === "" ? null : value))
    .optional();

export const canonicalActivityLevelSchema = z.enum(["low", "normal", "high"]);
export const canonicalBodyConditionSchema = z.enum(["thin", "ideal", "overweight"]);
export const canonicalPetAgeSchema = z.enum(["puppy", "young", "adult", "senior"], {
  error: "forms:fields.petAge.invalid",
});

const urlLikePattern = /https?:\/\/|www\./i;

export const normalizedOptionalNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .superRefine((value, ctx) => {
    if (!value) return;
    if (value.length < 2 || value.length > 80 || urlLikePattern.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forms:fields.name.invalid" });
    }
  });

export const normalizedPetNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .superRefine((value, ctx) => {
    if (!value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forms:fields.petName.required" });
    } else if (value.length > 80) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forms:fields.petName.tooLong" });
    }
  });

export const normalizedDogBreedSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .superRefine((value, ctx) => {
    if (value.length > 120) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forms:fields.dogBreed.tooLong" });
    }
  });

export const normalizedPolishPhoneSchema = z
  .string()
  .trim()
  .transform((value, ctx): string => {
    if (!value) return "";
    const digits = value.replace(/\D/g, "");
    if (digits.length === 9) return `+48${digits}`;
    if (digits.length === 11 && digits.startsWith("48")) return `+${digits}`;
    if (/^\+48\d{9}$/.test(value.replace(/\s/g, ""))) return value.replace(/\s/g, "");
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forms:fields.phone.invalid" });
    return z.NEVER;
  });

export const canonicalPetWeightKgSchema = z.coerce.number().positive().max(120).nullable().optional();
