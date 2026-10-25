/** Neutral configurator state. Profiles, sizing policy and provider evidence are host extensions. */
export interface ConfiguratorIntent {
  version: "commerce.configurator_intent.v1";
  idempotencyKey: string;
  mode: "one_time" | "subscription";
  cadenceDays: number | null;
  promoCodes: string[];
  visitorId?: string;
  contact: { firstName: string; lastName: string; email: string; phone: string };
  address: { street: string; postalCode: string; city: string; country: string };
  selectedVariants: Array<{ variantId: string; sku: string; qty: number }>;
  offerVersion?: string;
  minimumUnits?: number;
}

export interface ConfiguratorIntentPersistenceResponse {
  contractVersion: "commerce.configurator_intent_persistence.v1";
  intentVersion: "commerce.configurator_intent.v1";
  idempotencyKey: string;
  clientId: string;
  addressId: string;
  clientMatchReason?: "client_created" | "client_match_exact_email" | "client_match_plus_normalized_fallback";
  replayed: boolean;
}

export interface CheckoutResumeDraftState<Completion, RedactedField extends string> {
  version: "commerce.checkout_resume.v1";
  mode: "one_time" | "subscription" | null;
  cadenceDays: number | null;
  cart: { items: Array<{ sku: string; productSlug: string | null; variantId: string | null; quantity: number }> };
  completion: Completion;
  redactedFields: RedactedField[];
}

export interface CheckoutResumeDraft<Section extends string, State> {
  id: string;
  contractVersion: "commerce.checkout_resume.v1";
  lastSectionId: Section;
  draftState: State;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  replayed: boolean;
}

export interface CommerceCustomerDefaultsSnapshot<Scope, Method> {
  version: "commerce.customer_defaults_snapshot.v1";
  clientId: string;
  payment: { available: boolean; scope: Scope | null; methodKind: Method | null; source: "customer_payment_preferences"; applied: false };
  addresses: {
    hasDefaultShippingAddress: boolean; defaultShippingAddressId: string | null;
    hasDefaultBillingAddress: boolean; defaultBillingAddressId: string | null;
    hasDefaultOrdererProfile: boolean; defaultOrdererProfileId: string | null;
    hasDeliveryNotes: boolean; hasCourierInstructions: boolean;
    source: "customer_address_profiles"; applied: false;
  };
  redactedFields: Array<"contact" | "orderer_profile" | "shipping_address" | "billing_address" | "delivery_notes" | "courier_instructions" | "payment_provider" | "payment_secret">;
}
