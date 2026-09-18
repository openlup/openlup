import { z } from "../../lib/validation/zod.js";
import { isValidPolishNip, normalizePolishNip } from "../../lib/schemas/fields/taxId.js";

const uuidSchema = z.guid();
const idempotencyKeySchema = z.string().trim().min(8).max(180);

const customerAddressUpsertBaseSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    addressId: uuidSchema.optional(),
    kind: z.enum(["shipping", "billing", "both"]),
    label: z.string().trim().max(120).nullable().optional(),
    recipientName: z.string().trim().max(200).nullable().optional(),
    contactPhone: z.string().trim().max(64).nullable().optional(),
    companyName: z.string().trim().max(200).nullable().optional(),
    taxId: z.string().trim().max(64).nullable().optional(),
    line1: z.string().trim().min(1).max(240),
    line2: z.string().trim().max(240).nullable().optional(),
    city: z.string().trim().min(1).max(160),
    postalCode: z.string().trim().min(1).max(24),
    country: z.string().trim().min(2).max(80).default("PL"),
    isDefault: z.boolean().optional(),
    deliveryNotes: z.string().trim().max(500).nullable().optional(),
    courierInstructions: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const customerAddressUpsertRequestSchema = customerAddressUpsertBaseSchema
  .superRefine((value, ctx) => {
    const country = normalizeAddressCountry(value.country);
    const phone = normalizeAddressPhone(value.contactPhone ?? null, country);
    const postalCode = normalizeAddressPostalCode(value.postalCode, country);
    const recipientName = normalizeAddressText(value.recipientName ?? null);

    if (recipientName && (recipientName.length < 2 || /https?:\/\/|www\./i.test(recipientName))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientName"], message: "forms:fields.name.invalid" });
    }
    if (!country) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["country"], message: "forms:fields.country.invalid" });
    }
    if (value.contactPhone && !phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contactPhone"], message: "forms:fields.phone.invalid" });
    }
    if (!postalCode || !isSupportedAddressPostalCode(postalCode, country)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["postalCode"], message: "forms:fields.postalCode.invalid" });
    }

    if (value.kind !== "shipping") {
      const normalizedTaxId = normalizePolishNip(value.taxId ?? null);
      if (normalizedTaxId && !isValidPolishNip(normalizedTaxId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taxId"],
          message: "forms:fields.taxId.invalid",
        });
      }
    }
  })
  .transform((value) => {
    const country = normalizeAddressCountry(value.country) || value.country.trim().toUpperCase();
    const contactPhone = normalizeAddressPhone(value.contactPhone ?? null, country);
    const postalCode = normalizeAddressPostalCode(value.postalCode, country);
    const taxId = value.kind === "shipping" ? null : normalizePolishNip(value.taxId ?? null);
    return {
      ...value,
      recipientName: normalizeAddressText(value.recipientName ?? null) || null,
      contactPhone,
      companyName: value.kind === "shipping" ? null : value.companyName ?? null,
      taxId,
      postalCode,
      country,
    };
  });

export type CustomerAddressUpsertRequest = z.input<typeof customerAddressUpsertRequestSchema>;

function normalizeAddressText(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeAddressCountry(value: string): string | null {
  const normalized = normalizeAddressText(value).toLowerCase();
  if (!normalized) return null;
  if (normalized === "pl" || normalized === "polska" || normalized === "poland") return "PL";
  if (/^[a-z]{2}$/i.test(normalized)) return normalized.toUpperCase();
  return null;
}

function normalizeAddressPostalCode(value: string, country: string | null): string {
  const normalized = normalizeAddressText(value).toUpperCase();
  if (country === "PL") {
    const digits = normalized.replace(/\D/g, "");
    if (digits.length === 5) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }
  return normalized;
}

function isSupportedAddressPostalCode(value: string, country: string | null): boolean {
  if (country === "PL") return /^\d{2}-\d{3}$/.test(value);
  return /^[A-Z0-9][A-Z0-9 -]{1,18}[A-Z0-9]$/.test(value);
}

function normalizeAddressPhone(value: string | null, country: string | null): string | null {
  const raw = normalizeAddressText(value);
  if (!raw) return null;
  if (country !== "PL") return raw.length >= 6 && raw.length <= 32 ? raw : null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return `+48${digits}`;
  if (digits.length === 11 && digits.startsWith("48")) return `+${digits}`;
  return null;
}
