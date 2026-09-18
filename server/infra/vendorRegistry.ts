export interface VendorAdapterRegistration {
  providerKind: "tpay" | "stripe" | "fakturownia" | "omnipack" | "supabase";
  folder: string;
  role: "payment" | "accounting" | "fulfillment" | "auth";
  activationFlag: string;
  liveCallsEnabled: false;
  sandboxCallsEnabled?: boolean;
}

/** Customer auth provider kinds — the OSS swap seam (only `supabase` ships today). */
export type CustomerAuthProviderKind = "supabase";

/**
 * Selects the customer auth provider from env. Pure (no imports) so it stays
 * within the import-inert `server/infra` boundary; the BFF composes the chosen
 * adapter. Defaults to `supabase`; an OSS adopter overrides via
 * `COMMERCE_AUTH_PROVIDER_KIND`.
 */
export function readCustomerAuthProviderKind(
  env: Record<string, string | undefined>,
): CustomerAuthProviderKind {
  const explicit = env.COMMERCE_AUTH_PROVIDER_KIND?.trim().toLowerCase();
  if (explicit === "supabase") return "supabase";
  return "supabase";
}

export class UnknownVendorAdapterError extends Error {
  constructor(providerKind: string) {
    super(`Unknown vendor adapter: ${providerKind}`);
    this.name = "UnknownVendorAdapterError";
  }
}

export const VENDOR_ADAPTER_REGISTRY: VendorAdapterRegistration[] = [
  {
    providerKind: "tpay",
    folder: "api/infra/tpay",
    role: "payment",
    activationFlag: "COMMERCE_PAYMENT_PROVIDER_EXECUTION_ENABLED",
    liveCallsEnabled: false,
    sandboxCallsEnabled: true,
  },
  {
    providerKind: "stripe",
    folder: "api/infra/stripe",
    role: "payment",
    activationFlag: "COMMERCE_PAYMENT_PROVIDER_EXECUTION_ENABLED",
    liveCallsEnabled: false,
    sandboxCallsEnabled: true,
  },
  {
    providerKind: "fakturownia",
    folder: "api/infra/fakturownia",
    role: "accounting",
    activationFlag: "COMMERCE_ACCOUNTING_MUTATIONS_ENABLED",
    liveCallsEnabled: false,
  },
  {
    providerKind: "omnipack",
    folder: "api/infra/omnipack",
    role: "fulfillment",
    activationFlag: "COMMERCE_OMNIPACK_DISPATCH_ENABLED",
    liveCallsEnabled: false,
  },
  {
    providerKind: "supabase",
    folder: "server/adapters/supabase",
    role: "auth",
    activationFlag: "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
    liveCallsEnabled: false,
    sandboxCallsEnabled: true,
  },
];

export function getVendorAdapterRegistration(providerKind: string): VendorAdapterRegistration {
  const registration = VENDOR_ADAPTER_REGISTRY.find((entry) => entry.providerKind === providerKind);
  if (!registration) throw new UnknownVendorAdapterError(providerKind);
  return registration;
}
