import type { CustomerAddressUpsertRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import type {
  CustomerAddress,
  CustomerOrdererProfile,
} from "../../../src/domains/customers/contracts.js";
import { canonicalAddressKey } from "../../../src/domains/customers/addressCanonical.js";

type Row = Record<string, unknown>;

export interface CustomerAddressReadStore {
  readAddresses(clientId: string): Promise<Row[]>;
  readOrdererProfiles(clientId: string): Promise<Row[]>;
  addressUsedByActiveSubscription(clientId: string, addressId: string): Promise<boolean>;
  findCanonicalAddressId(clientId: string, canonicalKey: string): Promise<string | null>;
  clearDefaultAddress(clientId: string, kind: string, updatedAt: string): Promise<void>;
}

export async function readAddresses(store: CustomerAddressReadStore, clientId: string): Promise<CustomerAddress[]> {
  return (await store.readAddresses(clientId)).map((row) => ({
    addressId: text(row.id),
    kind: text(row.kind) as CustomerAddress["kind"],
    label: nullableText(row.label),
    recipientName: nullableText(row.recipient_name),
    contactPhone: nullableText(row.contact_phone),
    companyName: nullableText(row.company_name),
    taxId: nullableText(row.tax_id),
    line1: text(row.line1),
    line2: nullableText(row.line2),
    city: text(row.city),
    postalCode: text(row.postal_code),
    country: text(row.country),
    isDefault: Boolean(row.is_default),
    deliveryNotes: nullableText(row.delivery_notes),
    courierInstructions: nullableText(row.courier_instructions),
    lastUsedAt: nullableText(row.last_used_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }));
}

export async function readOrdererProfiles(
  store: CustomerAddressReadStore,
  clientId: string,
): Promise<CustomerOrdererProfile[]> {
  return (await store.readOrdererProfiles(clientId)).map((row) => ({
    profileId: text(row.id),
    label: nullableText(row.label),
    fullName: text(row.full_name),
    email: text(row.email),
    phone: nullableText(row.phone),
    companyName: nullableText(row.company_name),
    taxId: nullableText(row.tax_id),
    companyVerificationLevel: companyVerificationLevel(row.company_verification_level),
    companyIdentitySource: nullableText(row.company_identity_source),
    companyIdentityEvidenceHash: nullableText(row.company_identity_evidence_hash),
    isDefault: Boolean(row.is_default),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }));
}

export async function addressUsedByActiveSubscription(
  store: CustomerAddressReadStore,
  clientId: string,
  addressId: string,
) {
  return store.addressUsedByActiveSubscription(clientId, addressId);
}

export function addressRow(clientId: string, input: CustomerAddressUpsertRequest) {
  return {
    client_id: clientId,
    kind: input.kind,
    label: input.label ?? null,
    recipient_name: input.recipientName ?? null,
    contact_phone: input.contactPhone ?? null,
    company_name: input.companyName ?? null,
    tax_id: input.taxId ?? null,
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    postal_code: input.postalCode,
    country: input.country,
    is_default: input.isDefault ?? false,
    delivery_notes: input.deliveryNotes ?? null,
    courier_instructions: input.courierInstructions ?? null,
    canonical_key: canonicalAddressKey({
      clientId,
      kind: input.kind,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      postalCode: input.postalCode,
      country: input.country,
    }),
    source: "customer_account",
    updated_at: new Date().toISOString(),
  };
}

export async function findCanonicalAddressId(
  store: CustomerAddressReadStore,
  clientId: string,
  input: CustomerAddressUpsertRequest,
): Promise<string | null> {
  const key = canonicalAddressKey({
    clientId,
    kind: input.kind,
    line1: input.line1,
    line2: input.line2,
    city: input.city,
    postalCode: input.postalCode,
    country: input.country,
  });
  return store.findCanonicalAddressId(clientId, key);
}

export async function clearDefaultAddress(store: CustomerAddressReadStore, clientId: string, kind: string) {
  await store.clearDefaultAddress(clientId, kind, new Date().toISOString());
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function companyVerificationLevel(value: unknown): CustomerOrdererProfile["companyVerificationLevel"] {
  return value === "registry_verified" ||
    value === "provider_verified" ||
    value === "manual_unverified" ||
    value === "invalid"
    ? value
    : null;
}
