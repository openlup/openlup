import {
  checkoutCommandV1Schema,
  CHECKOUT_COMMAND_V1,
  type CheckoutCommandV1,
} from "@/domains/commerce/checkoutCommandContracts";
import type {
  SellableCatalogItem,
  SellableCatalogProfile,
} from "@/domains/catalog/contracts";

/**
 * The neutral subscribe entry, expressed as a pure function of what the deployment
 * already publishes.
 *
 * This module is the platform's answer to the a1 gap
 * (`docs/plan/oss-subscription-axis-audit.md` §1.6): line γ published the checkout
 * machine at `src/checkout/{machine,adapters,composer}` and left it with no reachable
 * front door, because the only entry that exists is the vertical's own composer under
 * `src/pages/skomponuj-pakiet/**`, which stays in the overlay by `D31`.
 *
 * ⛔ This is deliberately NOT a second composer. It reads no subject profile, no ration,
 * no recommendation and no vertical vocabulary. It composes exactly the two neutral
 * contracts the platform already ships:
 *
 * - `SellableCatalogListResponse` (`/api/bff/catalog/items`) — the deployment's own
 *   sellable rows, so the adopter brings the data and nothing is authored here.
 * - `checkoutCommandV1Schema` (`/api/bff/commerce/checkouts`) — the neutral checkout
 *   command, whose `mode: "subscription"` + `cadenceDays` arm has shipped published
 *   since the reference rail landed and has never had a caller.
 *
 * The canon test for this file: a second vertical must be able to sell a subscription
 * through it without editing it. Nothing below reads what an item *is*, only whether
 * the deployment permits subscribing to it.
 */

/**
 * The recurrence choices the neutral entry offers, in days.
 *
 * Calendar-neutral on purpose: a weekly, fortnightly, monthly or quarterly refill is a
 * shape every vertical recognises. ⛔ These are scaffolding, not policy — an adopter
 * whose cadence is a business rule replaces this entry rather than editing the list,
 * and the machine takes the number, never the label.
 */
export const SUBSCRIBE_ENTRY_CADENCE_DAYS = [7, 14, 30, 90] as const;

export type SubscribeEntryCadenceDays = (typeof SUBSCRIBE_ENTRY_CADENCE_DAYS)[number];

export const SUBSCRIBE_ENTRY_DEFAULT_CADENCE_DAYS: SubscribeEntryCadenceDays = 30;

/** The customer-entered half of the entry. Field-for-field the command's own shape. */
export interface SubscribeEntryContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
}

export interface SubscribeEntrySelection {
  sku: string;
  quantity: number;
  cadenceDays: number;
}

export type SubscribeEntryRefusal =
  | "no_subscribable_offer"
  | "offer_not_subscribable"
  | "details_incomplete";

/**
 * ⛔ Discriminated on a STRING, not on a boolean `ok`. `tsconfig.app.json` runs with
 * `strict: false`, where a `true`/`false` discriminant does not narrow and the refusal
 * branch silently type-checks as the success branch.
 */
export type SubscribeEntryCommandResult =
  | { status: "ready"; command: CheckoutCommandV1 }
  | { status: "refused"; reason: SubscribeEntryRefusal };

/**
 * The offers this deployment permits subscribing to.
 *
 * `permittedPurchaseModes` is the deployment's own declaration, so a deployment that
 * sells nothing on a recurring basis yields an empty list and the entry says so — it
 * does not invent an offer, and it does not need a flag to stay quiet.
 */
export function subscribableOffers(
  items: readonly SellableCatalogItem[],
): SellableCatalogItem[] {
  return items.filter((item) => item.permittedPurchaseModes.includes("subscription"));
}

/** Whether every field the checkout command demands has been supplied. */
export function isContactComplete(contact: SubscribeEntryContact): boolean {
  return Object.values(contact).every((value) => value.trim().length > 0);
}

/**
 * Compose the subscription checkout command, or refuse.
 *
 * ⛔ The result is validated by the published schema itself rather than by a re-derived
 * copy of its rules. A shape this entry could build but the BFF would reject is a 400
 * the customer sees at the end of the funnel; parsing here turns it into a refusal
 * before any money path is entered.
 */
export function buildSubscribeEntryCommand(input: {
  offers: readonly SellableCatalogItem[];
  profile: SellableCatalogProfile;
  selection: SubscribeEntrySelection;
  contact: SubscribeEntryContact;
  idempotencyKey: string;
}): SubscribeEntryCommandResult {
  const offers = subscribableOffers(input.offers);
  if (offers.length === 0) return { status: "refused", reason: "no_subscribable_offer" };

  const offer = offers.find((candidate) => candidate.sku === input.selection.sku);
  if (!offer) return { status: "refused", reason: "offer_not_subscribable" };

  if (!isContactComplete(input.contact)) return { status: "refused", reason: "details_incomplete" };

  const candidate = {
    version: CHECKOUT_COMMAND_V1,
    idempotencyKey: input.idempotencyKey,
    mode: "subscription" as const,
    lines: [{ sku: offer.sku, quantity: input.selection.quantity }],
    customer: {
      firstName: input.contact.firstName.trim(),
      lastName: input.contact.lastName.trim(),
      email: input.contact.email.trim(),
      phone: input.contact.phone.trim(),
    },
    shippingAddress: {
      street: input.contact.street.trim(),
      postalCode: input.contact.postalCode.trim(),
      city: input.contact.city.trim(),
      country: input.profile.country.toUpperCase(),
    },
    // The offer's own currency, never the profile's: an item priced outside the
    // profile default must not be re-labelled on its way to the money path.
    currency: offer.unitPrice.currency,
    cadenceDays: input.selection.cadenceDays,
  };

  const parsed = checkoutCommandV1Schema.safeParse(candidate);
  return parsed.success
    ? { status: "ready", command: parsed.data }
    : { status: "refused", reason: "details_incomplete" };
}

/** A blank entry form. */
export const EMPTY_SUBSCRIBE_CONTACT: SubscribeEntryContact = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  street: "",
  postalCode: "",
  city: "",
};

/** The command's own address fields, in the order the entry asks for them. */
export const SUBSCRIBE_CONTACT_FIELDS: ReadonlyArray<{
  key: keyof SubscribeEntryContact;
  label: string;
  type?: string;
}> = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "street", label: "Street and number" },
  { key: "postalCode", label: "Postal code" },
  { key: "city", label: "City" },
];

export interface SubscribeEntryPaths {
  /** The published payment-status page this entry hands the customer to. */
  payment: string;
  /** Where a refused checkout lands. */
  paymentFailed: string;
}

export const DEFAULT_SUBSCRIBE_ENTRY_PATHS: SubscribeEntryPaths = {
  payment: "/subscribe/payment",
  paymentFailed: "/subscribe/payment-failed",
};

/**
 * The offer price as the deployment's own locale renders it. A deployment may publish a
 * locale `Intl` cannot resolve; a price the customer can still read beats a page that
 * throws on the way to the money path.
 */
export function formatOfferPrice(
  profile: SellableCatalogProfile,
  item: SellableCatalogItem,
): string {
  const major = item.unitPrice.amountMinor / 100;
  try {
    return new Intl.NumberFormat(profile.locale, {
      style: "currency",
      currency: item.unitPrice.currency,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${item.unitPrice.currency}`;
  }
}
