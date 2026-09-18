import { z } from "../../../../lib/validation/zod.js";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { customerBillingProfileUpsertRequestSchema } from "@/domains/customers/accountV2Contracts";
import { customerAddressUpsertRequestSchema } from "@/domains/customers/selfServiceContracts";
import {
  companyFieldSchema,
  countryFieldSchema,
  emailFieldSchema,
  formatPostalCodeForCountry,
  isValidPolishNip,
  nameFieldSchema,
  normalizePhoneToE164,
  normalizePolishNip,
  phoneFieldSchema,
  validatePhoneField,
  validatePostalCodeField,
} from "@/lib/schemas/fields";
import {
  ACCOUNT_DEFAULT_COUNTRY,
  normalizedText,
  nullableText,
  optionalLabelSchema,
  optionalLine2Schema,
  optionalLongTextSchema,
  taxIdFormSchema,
} from "./accountFormSchemaUtils";

type AccountAddress = CustomerAccountV2Response["addresses"][number];
type AccountBillingProfile = CustomerAccountV2Response["billingProfiles"][number];

const addressKindSchema = z.enum(["shipping", "billing", "both"]);

export const accountAddressFormSchema = z
  .object({
    kind: addressKindSchema,
    label: optionalLabelSchema,
    recipientName: nameFieldSchema({ required: false }),
    contactPhone: z.string().trim().max(64),
    companyName: z.string().trim().max(200),
    taxId: z.string().trim().max(64),
    line1: z.string().trim().min(1, "account:dashboard.workspace.forms.errors.street").max(240),
    line2: optionalLine2Schema,
    city: z.string().trim().min(1, "account:dashboard.workspace.forms.errors.city").max(160),
    postalCode: z.string().trim().min(1, "forms:fields.postalCode.required").max(24),
    country: countryFieldSchema({ required: true }),
    isDefault: z.boolean(),
    deliveryNotes: optionalLongTextSchema,
    courierInstructions: optionalLongTextSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const phone = validatePhoneField(value.contactPhone, { country: value.country, required: false });
    if (phone.errors.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contactPhone"], message: "forms:fields.phone.invalid" });
    }

    const postal = validatePostalCodeField(value.postalCode, { country: value.country, required: true });
    if (postal.errors.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postalCode"],
        message: postal.errors[0]?.messageKey ?? "forms:fields.postalCode.invalid",
      });
    }

    if (value.kind === "shipping") return;
    const company = companyFieldSchema({ required: false }).safeParse(value.companyName);
    if (!company.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["companyName"],
        message: company.error.issues[0]?.message ?? "forms:fields.company.invalid",
      });
    }
    const taxId = normalizePolishNip(value.taxId);
    if (taxId && !isValidPolishNip(taxId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["taxId"], message: "forms:fields.taxId.invalid" });
    }
  })
  .transform((value) => ({
    ...value,
    label: normalizedText(value.label),
    recipientName: normalizedText(value.recipientName),
    contactPhone: normalizePhoneToE164(value.contactPhone, value.country) ?? normalizedText(value.contactPhone),
    companyName: value.kind === "shipping" ? "" : normalizedText(value.companyName),
    taxId: value.kind === "shipping" ? null : normalizePolishNip(value.taxId),
    line1: normalizedText(value.line1),
    line2: normalizedText(value.line2),
    city: normalizedText(value.city),
    postalCode: formatPostalCodeForCountry(value.postalCode, value.country),
    deliveryNotes: normalizedText(value.deliveryNotes),
    courierInstructions: normalizedText(value.courierInstructions),
  }));

export type AccountAddressFormInput = z.input<typeof accountAddressFormSchema>;
export type AccountAddressFormValues = z.output<typeof accountAddressFormSchema>;

export function seedAddressForm(
  account: CustomerAccountV2Response,
  address: AccountAddress | null,
): AccountAddressFormInput {
  return {
    kind: address?.kind ?? "shipping",
    label: address?.label ?? "",
    recipientName: address?.recipientName ?? account.profile?.firstName ?? "",
    contactPhone: address?.contactPhone ?? account.profile?.phone ?? "",
    companyName: address?.companyName ?? "",
    taxId: address?.taxId ?? "",
    line1: address?.line1 ?? "",
    line2: address?.line2 ?? "",
    city: address?.city ?? "",
    postalCode: address?.postalCode ?? "",
    country: address?.country ?? ACCOUNT_DEFAULT_COUNTRY,
    isDefault: address?.isDefault ?? account.addresses.length === 0,
    deliveryNotes: address?.deliveryNotes ?? "",
    courierInstructions: address?.courierInstructions ?? "",
  };
}

export function buildAddressPayload(
  values: AccountAddressFormValues,
  idempotencyKey: string,
  addressId?: string,
) {
  return customerAddressUpsertRequestSchema.parse({
    idempotencyKey,
    ...(addressId ? { addressId } : {}),
    kind: values.kind,
    label: nullableText(values.label),
    recipientName: nullableText(values.recipientName),
    contactPhone: nullableText(values.contactPhone),
    companyName: values.kind === "shipping" ? null : nullableText(values.companyName),
    taxId: values.kind === "shipping" ? null : values.taxId,
    line1: values.line1,
    line2: nullableText(values.line2),
    city: values.city,
    postalCode: values.postalCode,
    country: values.country,
    isDefault: values.isDefault,
    deliveryNotes: nullableText(values.deliveryNotes),
    courierInstructions: nullableText(values.courierInstructions),
  });
}

export const accountBillingProfileFormSchema = z
  .object({
    label: optionalLabelSchema,
    fullName: nameFieldSchema({ required: true }),
    email: emailFieldSchema({ required: true }),
    phone: phoneFieldSchema({ country: ACCOUNT_DEFAULT_COUNTRY, required: false }),
    country: countryFieldSchema({ required: true }).default(ACCOUNT_DEFAULT_COUNTRY),
    companyName: companyFieldSchema({ required: false }),
    taxId: taxIdFormSchema,
    isDefault: z.boolean(),
  })
  .strict();

export type AccountBillingProfileFormInput = z.input<typeof accountBillingProfileFormSchema>;
export type AccountBillingProfileFormValues = z.output<typeof accountBillingProfileFormSchema>;

export function seedBillingProfileForm(
  profile: AccountBillingProfile | null,
  account: CustomerAccountV2Response,
): AccountBillingProfileFormInput {
  return {
    label: profile?.label ?? "",
    fullName: profile?.fullName ?? account.profile?.firstName ?? "",
    email: profile?.email ?? account.profile?.email ?? "",
    phone: profile?.phone ?? account.profile?.phone ?? "",
    country: ACCOUNT_DEFAULT_COUNTRY,
    companyName: profile?.companyName ?? "",
    taxId: profile?.taxId ?? "",
    isDefault: profile?.isDefault ?? account.billingProfiles.length === 0,
  };
}

export function buildBillingProfilePayload(
  values: AccountBillingProfileFormValues,
  idempotencyKey: string,
  profileId?: string,
) {
  return customerBillingProfileUpsertRequestSchema.parse({
    idempotencyKey,
    ...(profileId ? { profileId } : {}),
    label: nullableText(values.label),
    fullName: values.fullName,
    email: values.email,
    phone: nullableText(values.phone),
    companyName: nullableText(values.companyName),
    taxId: values.taxId,
    isDefault: values.isDefault,
  });
}
