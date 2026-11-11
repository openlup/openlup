import { z } from 'zod';
import type { CustomerAddressUpsertRequest, CustomerAddressDeleteRequest } from './contracts/address.js';
type RequestSchema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } };
export interface CustomerSavedAddressRequestSchemas {
  customerAddressUpsertRequestSchema: RequestSchema<CustomerAddressUpsertRequest>;
  customerAddressDeleteRequestSchema: RequestSchema<CustomerAddressDeleteRequest>;
}
export interface CustomerSavedAddressValidationPolicy {
  /** ISO code and aliases for the local address policy; the code is also the default. */
  country: string;
  countryAliases: readonly string[];
  phonePrefix: string;
  normalizeTaxId(value: string | null): string | null;
  isValidTaxId(value: string): boolean;
  messages: { name: string; country: string; phone: string; postalCode: string; taxId: string };
}
const text = (value: string | null) => (value ?? '').trim().replace(/\s+/g, ' ');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const key = z.string().trim().min(8).max(180);
/** Fixed reference bounds and normalization order; local formats and copy are host policy. */
export function createCustomerSavedAddressRequestSchemas(policy: CustomerSavedAddressValidationPolicy): CustomerSavedAddressRequestSchemas {
  const country = z.string().regex(/^[A-Z]{2}$/).parse(policy.country);
  const prefix = z.string().regex(/^[0-9]{1,4}$/).parse(policy.phonePrefix);
  const aliases = policy.countryAliases.map(value => z.string().trim().min(1).max(80).parse(value).toLowerCase());
  if (typeof policy.normalizeTaxId !== 'function' || typeof policy.isValidTaxId !== 'function'
    || Object.values(policy.messages).some(value => typeof value !== 'string' || !value.trim())) throw new Error('saved_address_policy_invalid');
  const normalizeCountry = (value: string): string | null => {
    const normalized = text(value).toLowerCase();
    if (normalized === country.toLowerCase() || aliases.includes(normalized)) return country;
    return /^[a-z]{2}$/i.test(normalized) ? normalized.toUpperCase() : null;
  };
  const postal = (value: string, selectedCountry: string | null) => {
    const normalized = text(value).toUpperCase(), digits = normalized.replace(/\D/g, '');
    return selectedCountry === country && digits.length === 5 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : normalized;
  };
  const phone = (value: string | null, selectedCountry: string | null): string | null => {
    const raw = text(value);
    if (!raw) return null;
    if (selectedCountry !== country) return raw.length >= 6 && raw.length <= 32 ? raw : null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 9) return `+${prefix}${digits}`;
    return digits.length === 9 + prefix.length && digits.startsWith(prefix) ? `+${digits}` : null;
  };
  const upsert = z.object({ idempotencyKey: key, addressId: z.guid().optional(), kind: z.enum(['shipping','billing','both']),
    label: optionalText(120), recipientName: optionalText(200), contactPhone: optionalText(64), companyName: optionalText(200), taxId: optionalText(64),
    line1: z.string().trim().min(1).max(240), line2: optionalText(240), city: z.string().trim().min(1).max(160), postalCode: z.string().trim().min(1).max(24),
    country: z.string().trim().min(2).max(80).default(country), isDefault: z.boolean().optional(), deliveryNotes: optionalText(500), courierInstructions: optionalText(500) }).strict()
    .superRefine((value, context) => {
      const selectedCountry = normalizeCountry(value.country), normalizedPostal = postal(value.postalCode, selectedCountry), recipient = text(value.recipientName ?? null);
      const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
      if (recipient && (recipient.length < 2 || /https?:\/\/|www\./i.test(recipient))) issue('recipientName', policy.messages.name);
      if (!selectedCountry) issue('country', policy.messages.country);
      if (value.contactPhone && !phone(value.contactPhone, selectedCountry)) issue('contactPhone', policy.messages.phone);
      if (!normalizedPostal || !(selectedCountry === country ? /^\d{2}-\d{3}$/.test(normalizedPostal) : /^[A-Z0-9][A-Z0-9 -]{1,18}[A-Z0-9]$/.test(normalizedPostal))) issue('postalCode', policy.messages.postalCode);
      if (value.kind !== 'shipping') { const tax = policy.normalizeTaxId(value.taxId ?? null); if (tax && !policy.isValidTaxId(tax)) issue('taxId', policy.messages.taxId); }
    }).transform(value => {
      const selectedCountry = normalizeCountry(value.country) || value.country.trim().toUpperCase();
      return { ...value, recipientName: text(value.recipientName ?? null) || null,
        contactPhone: phone(value.contactPhone ?? null, selectedCountry), postalCode: postal(value.postalCode, selectedCountry), country: selectedCountry,
        companyName: value.kind === 'shipping' ? null : value.companyName ?? null,
        taxId: value.kind === 'shipping' ? null : policy.normalizeTaxId(value.taxId ?? null) };
    });
  return { customerAddressUpsertRequestSchema: upsert,
    customerAddressDeleteRequestSchema: z.object({ idempotencyKey: key, addressId: z.guid() }).strict() };
}
