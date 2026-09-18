import type {
  ConfiguratorIntent,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type {
  CreateQuoteRequest,
} from "../../../src/domains/commerce/contracts.js";
import type {
  CheckoutInvoicePreference,
  CheckoutKind,
} from "../../../src/domains/commerce/checkoutContracts.js";
import type {
  CommerceCustomerDefaultsSnapshot,
} from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import { buildCheckoutInvoiceBuyerSnapshot } from "./checkoutInvoiceBuyerSnapshot.js";
import {
  OFFER_POLICY_V2_CAPABILITY,
  type PricingPolicySnapshot,
} from "../../../src/domains/commerce/offerPolicyContracts.js";

/**
 * The neutral projection the paid-order saga consumes. The configurator
 * intent and the neutral `CheckoutCommandV1` each map into this one shape, so
 * both run the identical stage, invariant, and compensation sequence instead of
 * maintaining two sagas.
 */
export interface CheckoutJourney {
  idempotencyKey: string;
  contactEmail: string;
  createQuoteRequest: () => CreateQuoteRequest;
  createRuntimeMetadata: (pricingPolicy?: PricingPolicySnapshot) => Record<string, unknown>;
}

export interface OrderDeliveryContactInput {
  recipientName: string;
  contactEmail: string;
  contactPhone: string;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  country: string;
  selectedDelivery?: unknown;
  deliveryInstructions?: string | null;
  courierInstructions?: string | null;
}

/**
 * Complete order-owned delivery authority. Profile and address-book rows can
 * keep serving defaults, but fulfillment must not reconstruct an order's
 * recipient from those mutable records after checkout.
 */
export function buildOrderDeliveryContact(
  input: OrderDeliveryContactInput,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: "checkout_submission",
    revision: 1,
    recipientName: input.recipientName.trim(),
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    postalCode: input.postalCode,
    country: input.country,
    selectedDelivery: input.selectedDelivery ?? null,
    deliveryInstructions: input.deliveryInstructions ?? null,
    courierInstructions: input.courierInstructions ?? null,
  };
}

/** Legacy mapping: configurator intent -> the shared journey projection. */
export function configuratorCheckoutJourney(
  intent: ConfiguratorIntent,
  provisioned: { petId: string | null },
  checkoutKind: CheckoutKind,
  invoicePreference: CheckoutInvoicePreference,
  customerDefaultsSnapshot?: CommerceCustomerDefaultsSnapshot | null,
): CheckoutJourney {
  return {
    idempotencyKey: intent.idempotencyKey,
    contactEmail: intent.contact.email,
    createQuoteRequest: () => buildQuoteRequest(intent, provisioned),
    createRuntimeMetadata: (pricingPolicy) => runtimeMetadata(
      intent,
      checkoutKind,
      invoicePreference,
      customerDefaultsSnapshot,
      pricingPolicy,
    ),
  };
}

export function buildQuoteRequest(
  intent: ConfiguratorIntent,
  provisioned: { petId: string | null },
  pricingPolicy?: PricingPolicySnapshot,
): CreateQuoteRequest {
  const quoteMode = intent.mode === "subscription" ? "subscription" : "one_time";
  return {
    mode: quoteMode,
    lines: intent.selectedVariants.map((variant) => ({
      sku: variant.sku,
      quantity: variant.qty,
      variantId: variant.variantId,
      modeAtLine: quoteMode,
    })),
    sizeConstraint: intent.sizeConstraint,
    cadenceDays: intent.mode === "subscription" ? intent.cadenceDays : null,
    promoCodes: intent.promoCodes,
    ...(provisioned.petId
      ? {
          petId: provisioned.petId,
          petProfileContext: {
            petId: provisioned.petId,
            ageBand: intent.petProfile.ageBand,
            breed: intent.petProfile.breed,
            weightKg: intent.petProfile.weightKg,
            activityLevel: intent.petProfile.activityLevel,
            bcs: intent.petProfile.bcs,
            allergenSlugs: intent.petProfile.allergenSlugs,
            dailyKcalOverride: intent.petProfile.dailyKcalOverride,
          },
        }
      : {}),
    locale: intent.locale,
    visitorId: intent.visitorId,
    ...(pricingPolicy?.pricingPolicyToken
      ? { pricingPolicy: {
          capability: OFFER_POLICY_V2_CAPABILITY,
          token: pricingPolicy.pricingPolicyToken,
        } }
      : {}),
    // Carry the contact email as the eligibility signal so the checkout-time quote
    // resolves first-order eligibility the SAME way the FE preview did (email present
    // → device guard demoted to advisory). Without this the device guard could
    // re-apply at checkout and spuriously flip the price (price_changed). The client
    // id used for paid-order counts still comes from `provisioned.clientId` (resolved
    // from this same email by the persist RPC), so the two stay consistent.
    ...(intent.contact?.email
      ? { customerEligibilityContext: { email: intent.contact.email } }
      : {}),
  };
}

export function runtimeMetadata(
  intent: ConfiguratorIntent,
  checkoutKind: CheckoutKind,
  invoicePreference: CheckoutInvoicePreference,
  customerDefaultsSnapshot?: CommerceCustomerDefaultsSnapshot | null,
  pricingPolicy?: PricingPolicySnapshot,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    checkoutKind,
    checkoutIntent: checkoutKind,
    cadenceDays: intent.mode === "subscription" ? intent.cadenceDays : null,
    requiresReusablePaymentMethod: checkoutKind === "subscription_initial",
    invoiceBuyerSnapshot: buildCheckoutInvoiceBuyerSnapshot(intent, invoicePreference),
    // Pet name rides into the order metadata so the post-checkout recap can greet
    // the customer by their dog's name on any device (the thank-you page no longer
    // depends on the configurator's localStorage snapshot — see order-recap endpoint).
    petName: intent.petProfile.name,
    deliveryContact: buildOrderDeliveryContact({
      recipientName: `${intent.contact.firstName} ${intent.contact.lastName}`,
      contactEmail: intent.contact.email,
      contactPhone: intent.contact.phone,
      line1: intent.address.street,
      city: intent.address.city,
      postalCode: intent.address.postalCode,
      country: intent.address.country,
      selectedDelivery: intent.selectedDelivery,
    }),
  };

  if (pricingPolicy) {
    metadata.offerPolicyVersion = pricingPolicy.offerPolicyVersion;
    metadata.promotionEngineVersion = pricingPolicy.promotionEngineVersion;
  }

  // Device id rides into the order metadata so the redemption trigger can device-key a
  // paid first-order (consumed by commerce_device_first_order_redeemed at quote time).
  if (intent.visitorId) {
    metadata.visitorId = intent.visitorId;
  }

  // KEYSTONE: persist the canonical delivery selection onto the order so the paid-order
  // fulfillment router can read it. This metadata object is nested by the SQL finalize
  // under `runtimeFinalize` (commerce_orders.metadata.runtimeFinalize.*), which is exactly
  // where routingOrderPaidFulfillmentPort.readSelectedProviderKind looks
  // (metadata.selectedDelivery ?? metadata.runtimeFinalize.selectedDelivery). Without this,
  // a real configurator checkout carries no selection and silently falls back to the
  // simulator even when the customer chose an OmniPack carrier. Canonical shape only —
  // {kind,deliveryKind,providerKind,carrierKind,carrierCode,service,serviceCode,pickupPoint,
  // providerRef} — built by the FE (buildCheckoutIntent.deliveryFromSelectedOption) and
  // validated by the intent schema (configuratorIntentContracts selectedDelivery superRefine,
  // which requires carrierCode+serviceCode for providerKind:"omnipack"). Covers the
  // configurator one-time AND subscription_initial paths (both flow through runtimeMetadata);
  // subscription RENEWAL cycle orders are created by a SQL RPC and are handled separately.
  if (intent.selectedDelivery) {
    metadata.selectedDelivery = intent.selectedDelivery;
  }

  if (customerDefaultsSnapshot) {
    metadata.customerDefaults = customerDefaultsSnapshot;
  }

  return metadata;
}

export function uuidFromOrderRef(orderRef: string): string {
  return orderRef.replace(/^order_/, "");
}

export function messageOf(error: unknown, stage: string): string {
  return error instanceof Error ? `${stage}: ${error.message}` : `${stage}: unknown`;
}
