import type { Page } from "@playwright/test";

/**
 * Typed test data for the checkout E2E matrix.
 *
 * Field shapes mirror the configurator form store + step components so the flow
 * helpers can drive them by data-testid without re-deriving slugs:
 *  - dog age/activity/bcs use the canonical enums (publicPetAgeValues,
 *    ACTIVITY_LEVELS, BCS_VALUES);
 *  - allergens/flavors use the configurator slug lists (ALLERGEN_SLUGS minus
 *    chicken for flavors, per FLAVOR_SLUGS);
 *  - NIPs reuse the valid registry-style fixture (7770001450) plus an invalid
 *    control so the b2b-invoice branch can be exercised both ways.
 */

export type PetAge = "puppy" | "young" | "adult" | "senior";
export type ActivityLevel = "low" | "normal" | "high";
export type BcsValue = "thin" | "ideal" | "overweight";

export interface Dog {
  /** Pet display name (also the hero gate value). */
  name: string;
  /** Free-text breed typed into the DogBreedCombobox native input. */
  breed: string;
  /** Weight in kg as the user types it (string — matches the native input). */
  weightKg: string;
  age: PetAge;
  activity: ActivityLevel;
  bcs: BcsValue;
}

export interface Owner {
  firstName: string;
  lastName: string;
  email: string;
  /** Phone in a PL-dialable form (libphonenumber accepts national or +48 E.164). */
  phone: string;
}

export interface Address {
  street: string;
  postalCode: string;
  city: string;
  /** Country select value — the only option rendered is "Polska". */
  country: string;
  /** Preferred delivery method for this address fixture. */
  delivery: "courier" | "parcel-locker";
  /** Static pickup-point id (WAW01A | KRK02B) when delivery is parcel-locker. */
  pickupPointId?: "WAW01A" | "KRK02B";
}

export type Invoice =
  | { kind: "none" }
  | { kind: "b2b"; nip: string; valid: boolean };

export interface Consents {
  gdpr: boolean;
  terms: boolean;
  marketing: boolean;
}

export const DOGS = {
  // Small adult (not a 2kg puppy): the recommendation engine returns
  // `manual_review` for very small/young dogs, which hides the shipping form and
  // blocks checkout. A 5kg adult resolves to a clean `ready_to_buy` package (the
  // smallest real can count, ~14), keeping inventory pressure low across the suite.
  smallPuppy: {
    name: "Fistaszek",
    breed: "Chihuahua",
    weightKg: "5",
    age: "adult",
    activity: "normal",
    bcs: "ideal",
  },
  largeAdult: {
    name: "Rex",
    breed: "Owczarek niemiecki",
    weightKg: "30",
    age: "adult",
    activity: "high",
    bcs: "ideal",
  },
  mixedSenior: {
    name: "Burek",
    breed: "Kundelek",
    weightKg: "12",
    age: "senior",
    activity: "normal",
    bcs: "overweight",
  },
} satisfies Record<string, Dog>;

export const OWNERS = {
  /**
   * Identity template — name and phone. Its `email` is the BASE mailbox, not an
   * address any journey should type: see {@link ownerFor}, which is what every
   * call site uses.
   */
  valid: {
    firstName: "Jan",
    lastName: "Kowalski",
    email: "jan.kowalski+checkout-e2e@example.com",
    phone: "+48512345678",
  },
} satisfies Record<string, Owner>;

/**
 * The tag every mailbox this suite types carries, in the local part.
 *
 * It is the cleanup handle: `isPreviewTestEmail` in
 * `scripts/cleanup-hidden-preview-commerce-state.ts` keys on this exact
 * substring, so the per-test client rows below are sweepable. Change it in both
 * places or `fixtures.test.ts` fails.
 */
export const CHECKOUT_E2E_MAILBOX_TAG = "checkout-e2e";

/**
 * Base mailboxes the suite aliases off. Every address is on `example.com`
 * (RFC 2606 reserved: it resolves nowhere, so no generated order can reach a
 * real inbox), and every base is chosen for the PURCHASE HISTORY it carries,
 * because that is what the offer shape keys on:
 *
 *  - `returning` accumulates paid orders. Aliases plus-normalize back to it
 *    (`server/adapters/supabase/quoteCustomerEligibility.ts` strips `+tag` for
 *    first-order anti-farming), so a journey that needs a NON-first-order
 *    customer keeps getting one while each alias still gets its own
 *    rate-limit key.
 *  - `firstOrder` and `starter` never place an order, so every alias of them is
 *    first-order eligible — which is the subject of the unpinned and
 *    starter-pack journeys.
 */
export const MAILBOXES = {
  returning: OWNERS.valid.email,
  firstOrder: "unpinned.e2e@example.com",
  starter: "starter.e2e@example.com",
  promo: "promo.e2e@example.com",
} as const;

/**
 * Unique per PROCESS, so nothing inside one run can collide either.
 *
 * The pid is not decoration: Playwright runs each spec file in its own worker,
 * several of which start inside the same millisecond, and each worker's
 * sequence counter starts at 1. A timestamp alone would let two workers mint
 * the same address and put two journeys back in one rate-limit bucket — the
 * exact failure this module exists to prevent, at a rate low enough to read as
 * a flake. The pid is unique among live processes by definition, and the clock
 * separates a re-used pid from a later run.
 */
const MAILBOX_RUN_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
let mailboxSequence = 0;

/**
 * A `+tag` alias of `mailbox`, unique on every call.
 *
 * ⛔ The two systems this straddles disagree ON PURPOSE, and that disagreement
 * is the whole point:
 *
 *  - `hashCheckoutRateLimitKey` (the fail-closed public-checkout limiter) hashes
 *    the FULL address. Every alias is therefore its own quota bucket, so the
 *    per-email cap of 5/hour stops being the binding constraint and the shared
 *    per-IP cap of 10/hour is all that is left.
 *  - `resolveQuoteCustomerEligibility` falls back to a plus-normalized match, so
 *    the alias still resolves to `mailbox`'s client and inherits its paid-order
 *    history. The offer shape a journey sees does not move.
 *
 * An existing `+tag` on the input is dropped rather than stacked, so the
 * normalized base is `mailbox`'s base whatever the caller passes (including an
 * operator-supplied `STARTER_PACK_KNOWN_EMAIL` that already carries one).
 */
export function aliasMailbox(mailbox: string): string {
  const at = mailbox.lastIndexOf("@");
  if (at <= 0) return mailbox;
  const base = mailbox.slice(0, at).replace(/\+.*/, "");
  mailboxSequence += 1;
  return `${base}+${CHECKOUT_E2E_MAILBOX_TAG}-${MAILBOX_RUN_ID}-${mailboxSequence}@${mailbox.slice(at + 1)}`;
}

/** The standard owner identity, typing a fresh alias of `mailbox`. */
export function ownerFor(mailbox: string = MAILBOXES.returning): Owner {
  return { ...OWNERS.valid, email: aliasMailbox(mailbox) };
}

/**
 * A brand-new BASE mailbox — unique even after plus normalization.
 *
 * For the one case an alias cannot serve: per-customer promotion redemption
 * resolves a `+tag` back to the base customer (deliberately, to stop coupon
 * farming), so a once-per-customer code needs an identity the server has never
 * seen at all rather than an alias of one it has.
 */
export function freshMailbox(prefix: string): string {
  mailboxSequence += 1;
  return `${prefix}-${CHECKOUT_E2E_MAILBOX_TAG}-${MAILBOX_RUN_ID}-${mailboxSequence}@example.com`;
}

export const ADDRESSES = {
  warszawaCourier: {
    street: "Prosta 20",
    postalCode: "00-001",
    city: "Warszawa",
    country: "Polska",
    delivery: "courier",
  },
  krakowParcelLocker: {
    street: "Karmelicka 10",
    postalCode: "30-001",
    city: "Kraków",
    country: "Polska",
    delivery: "parcel-locker",
    pickupPointId: "KRK02B",
  },
} satisfies Record<string, Address>;

export const INVOICES = {
  none: { kind: "none" },
  // Registry-verified NIP on the preview's company-identity lookup (resolves to a
  // real legal entity). 7770001450 reads back as "invalid", so the lookup never
  // surfaces a company and the b2b branch can't be exercised.
  b2bValid: { kind: "b2b", nip: "5260250274", valid: true },
  b2bInvalid: { kind: "b2b", nip: "1234567890", valid: false },
} satisfies Record<string, Invoice>;

export const CONSENTS = {
  /** Required-only: GDPR + terms accepted, marketing left off. */
  required: { gdpr: true, terms: true, marketing: false },
  /** Everything accepted, including optional marketing. */
  all: { gdpr: true, terms: true, marketing: true },
} satisfies Record<string, Consents>;

/** Allergen slugs (Step2 chips) — keep in sync with ALLERGEN_SLUGS. */
export const ALLERGEN_SLUGS = [
  "chicken",
  "beef",
  "lamb",
  "pork",
  "turkey",
  "salmon",
  "venison",
  "yeast",
] as const;
export type AllergenSlug = (typeof ALLERGEN_SLUGS)[number];

/** Flavor slugs sold by the configurator (Step3 cards) — note: no chicken. */
export const FLAVOR_SLUGS = [
  "lamb",
  "venison",
  "beef",
  "turkey",
  "salmon",
  "pork",
] as const;
export type FlavorSlug = (typeof FLAVOR_SLUGS)[number];

/** Nominal length presets surfaced as length-<days> tiles (not all guaranteed present). */
export const LENGTH_DAYS = [14, 21, 28] as const;
export type LengthDays = (typeof LENGTH_DAYS)[number];

/**
 * Seed the cookie-consent localStorage entry before the app boots so the
 * consent banner never intercepts clicks. Copied from the admin-oms preview
 * spec's `seedCookieConsent` so both suites use an identical shape.
 */
export async function seedCookieConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "cookie-consent",
      JSON.stringify({
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
      }),
    );
  });
}
