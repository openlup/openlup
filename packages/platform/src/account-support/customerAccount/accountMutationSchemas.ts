import { z } from "zod";
import type { CustomerAccountMutationPolicy, CustomerProfileUpdateRequest, CustomerProfileUpdateResponse, CustomerInvoiceCorrectionRequest, CustomerInvoiceCorrectionResponse } from "../contracts/mutations.js";
z.config({ jitless: true });
export interface CustomerAccountMutationSchemas {
  profileRequest: z.ZodType<CustomerProfileUpdateRequest>;
  profileResponse: z.ZodType<CustomerProfileUpdateResponse>;
  correctionRequest: z.ZodType<CustomerInvoiceCorrectionRequest>;
  correctionResponse: z.ZodType<CustomerInvoiceCorrectionResponse>;
}
/** Phone extraction intentionally uses the configured local-length/prefix rules, including nondigit stripping. */
export function createCustomerAccountMutationSchemas(policy: CustomerAccountMutationPolicy): CustomerAccountMutationSchemas {
  policy = { key: { ...policy.key }, name: { ...policy.name }, phone: { ...policy.phone }, correction: { ...policy.correction } };
  if (!/^[1-9][0-9]*$/.test(policy.phone.callingCode) || !Number.isInteger(policy.phone.localDigits) || policy.phone.localDigits < 1
    || Object.values(policy.key).some(n => !Number.isInteger(n) || n < 1) || policy.key.min > policy.key.max
    || Object.values(policy.name).some(n => !Number.isInteger(n) || n < 1) || policy.name.min > policy.name.max
    || Object.values(policy.correction).some(n => !Number.isInteger(n) || n < 1) || policy.correction.reasonMin > policy.correction.reasonMax) throw new Error("customer_account_policy_invalid");
  const key = z.string().trim().min(policy.key.min).max(policy.key.max);
  const name = z.string().trim().transform(value => value.replace(/\s+/g, " ")).superRefine((value, ctx) => {
    if (value && (value.length < policy.name.min || value.length > policy.name.max || /https?:\/\/|www\./i.test(value))) ctx.addIssue({ code: "custom", message: "customer_account_name_invalid" });
  });
  const phone = z.string().trim().transform((value, ctx) => {
    if (!value) return "";
    const digits = value.replace(/\D/g, ""), prefix = policy.phone.callingCode;
    if (digits.length === policy.phone.localDigits) return `+${prefix}${digits}`;
    if (digits.length === prefix.length + policy.phone.localDigits && digits.startsWith(prefix)) return `+${digits}`;
    if (new RegExp(`^\\+${prefix}\\d{${policy.phone.localDigits}}$`).test(value.replace(/\s/g, ""))) return value.replace(/\s/g, "");
    ctx.addIssue({ code: "custom", message: "customer_account_phone_invalid" }); return z.NEVER;
  });
  const nullable = <T>(schema: z.ZodType<T, unknown>) => z.union([schema, z.null()]).transform(value => value === "" ? null : value).optional();
  const profileRequest = z.object({ idempotencyKey: key, firstName: nullable(name), lastName: nullable(name), phone: nullable(phone) }).strict();
  const correctionRequest = z.object({ idempotencyKey: key, invoiceId: z.guid(),
    reason: z.string().trim().min(policy.correction.reasonMin).max(policy.correction.reasonMax),
    requestedFields: z.array(z.string().trim().min(1).max(policy.correction.fieldMax)).max(policy.correction.fieldsMax).optional(),
    note: z.string().trim().min(1).max(policy.correction.noteMax).nullable().optional() }).strict();
  const profileResponse = z.object({ contractVersion: z.literal("customer.self_service.v1"), profile: z.object({
    clientId: z.guid(), email: z.email(), firstName: z.string().nullable(), lastName: z.string().nullable(), phone: z.string().nullable(),
    lifecycleStage: z.enum(["lead", "tester", "customer", "inactive"]),
  }).strict() }).strict();
  const correctionResponse = z.object({ contractVersion: z.literal("customer.billing.v1"), eventId: z.guid() }).strict();
  return { profileRequest, correctionRequest, profileResponse, correctionResponse };
}
