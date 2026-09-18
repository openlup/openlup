import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import {
  starterPackPlanSchema,
  type StarterPackPlan,
} from "../../../src/domains/commerce/starterOfferContracts.js";
import {
  STARTER_DELIVERY2_DISCOUNT_BPS,
  STARTER_MIN_CANS,
  starterAggregateBySku,
  starterDelivery2DiscountMinor,
  starterRescaleBasket,
  starterTermsFromCoverage,
} from "../../../src/domains/commerce/starterOfferPolicy.js";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";

/**
 * Checkout-side gate for the starter-pack acquisition offer.
 *
 * The client ASKS (`intent.starterOffer`); this module decides. Nothing it sent
 * is trusted: interval, steady cadence, steady basket size and the delivery-2
 * rate are all recomputed from the SERVER quote of the real basket, and any
 * disagreement is a rejection. The happy path returns the frozen plan that
 * `subscription_create_provisional_for_checkout` stores as the immutable
 * `subscriptions.starter_pack` marker — validated here first, so a plan the
 * migration would reject fails while the order is still a draft.
 *
 * ⛔ Fail-closed everywhere: a branch that cannot prove the offer is owed
 * rejects, never degrades to "no marker, charge them anyway".
 */

export type StarterOfferGuardResult =
  /** No starter offer in play — today's path, byte-identical output. */
  | { kind: "absent" }
  /** The ask cannot be honoured. `reason` is diagnostic, never customer copy. */
  | { kind: "rejected"; reason: StarterOfferRejectionReason }
  | { kind: "minted"; plan: StarterPackPlan };

export type StarterOfferRejectionReason =
  | "starter_offer_disabled"
  | "starter_offer_wrong_mode"
  | "starter_offer_not_first_order"
  | "starter_offer_basket_too_small"
  | "starter_offer_ration_unknown"
  | "starter_offer_terms_drifted"
  | "starter_offer_uncollectable_delivery_2"
  | "starter_offer_steady_quote_failed"
  | "starter_offer_plan_invalid";

/**
 * The template version `subscription_create_provisional_for_checkout` writes
 * literally on acquisition (wave-1 pgTAP drives a marker declaring 99 and
 * asserts 1 is stored), so freezing it keeps the marker's "not graduated yet"
 * signal true from cycle one.
 */
const ACQUISITION_TEMPLATE_VERSION = 1;

export interface StarterOfferGuardInput {
  /** `COMMERCE_STARTER_PACK_ENABLED`. */
  flagEnabled: boolean;
  intent: ConfiguratorIntent;
  provisioned: { clientId: string | null; petId: string | null };
  /** The server's own quote of the checkout basket, already accepted. */
  authoritativeQuote: CreateQuoteResponse;
  quotePort: CommerceQuotePort;
  /**
   * Server-authoritative first-order re-check, on the same paid-order counts the
   * eligibility endpoint and the promo engine use. Omitted means "cannot prove
   * it" and the offer is refused.
   */
  isFirstOrderEligible?: () => Promise<boolean>;
}

export async function resolveStarterOfferGuard(
  input: StarterOfferGuardInput,
): Promise<StarterOfferGuardResult> {
  const declared = input.intent.starterOffer;
  // Flag OFF and nothing declared is the overwhelmingly common case and must do
  // exactly zero work — no quote, no read, no allocation.
  if (!declared) return { kind: "absent" };
  if (!input.flagEnabled) return { kind: "rejected", reason: "starter_offer_disabled" };
  if (input.intent.mode !== "subscription") {
    return { kind: "rejected", reason: "starter_offer_wrong_mode" };
  }

  const cans = input.intent.selectedVariants.reduce((total, variant) => total + variant.qty, 0);
  if (cans < STARTER_MIN_CANS) {
    return { kind: "rejected", reason: "starter_offer_basket_too_small" };
  }

  // ONE derivation, shared verbatim with `buildCheckoutIntent` and the price on
  // screen. What the customer is shown, what the client asks for and what is
  // checked here are the same function of the same two numbers, so "terms
  // drifted" can no longer mean "the two sides rounded differently".
  const terms = starterTermsFromCoverage(
    cans,
    input.authoritativeQuote.quote.context?.feedingCoverageDays,
  );
  if (terms === null) {
    return { kind: "rejected", reason: "starter_offer_ration_unknown" };
  }
  const { intervalDays, cadenceDays, effectiveDailyGrams, steadyCans } = terms;
  if (
    declared.intervalDays !== intervalDays ||
    declared.delivery2DiscountBps !== STARTER_DELIVERY2_DISCOUNT_BPS ||
    declared.steady.cadenceDays !== cadenceDays ||
    declared.steady.cans !== steadyCans
  ) {
    return { kind: "rejected", reason: "starter_offer_terms_drifted" };
  }

  if (!(await input.isFirstOrderEligible?.())) {
    return { kind: "rejected", reason: "starter_offer_not_first_order" };
  }

  const bandSubtotalMinor = input.authoritativeQuote.quote.subtotalGross.amountMinor;
  const discountMinor = starterDelivery2DiscountMinor({
    bandSubtotalMinor,
    listAnchorTotalMinor: listAnchorTotalMinor(input.authoritativeQuote),
  });
  if (discountMinor === null) {
    return { kind: "rejected", reason: "starter_offer_uncollectable_delivery_2" };
  }

  const steadyQuote = await quoteSteadyPackage(input, steadyCans, cadenceDays);
  if (steadyQuote === null) {
    return { kind: "rejected", reason: "starter_offer_steady_quote_failed" };
  }

  const parsed = starterPackPlanSchema.safeParse({
    schemaVersion: "1",
    starterIntervalDays: intervalDays,
    basisTemplateVersion: ACQUISITION_TEMPLATE_VERSION,
    delivery2: {
      discountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
      discountMinor,
      basisSubtotalMinor: bandSubtotalMinor,
    },
    graduation: {
      cadenceDays,
      sizeConstraint: { kind: "unit_count", value: steadyCans },
      lines: steadyQuote.quote.lines.map((line, index) => ({
        sku: line.sku,
        qty: line.quantity,
        sortOrder: index,
        // Addons are never part of a graduation basket; the RPC deletes only
        // non-addon template lines, so an existing addon survives untouched.
        isAddon: false,
        quoteLine: frozenQuoteLine(line),
      })),
    },
  });
  if (!parsed.success) return { kind: "rejected", reason: "starter_offer_plan_invalid" };
  return { kind: "minted", plan: parsed.data };
}

/**
 * Injects the frozen plan into the quote snapshot the finalize RPC receives.
 * Pure and total: the input snapshot is never mutated, and `null` returns it
 * unchanged so the no-offer path stays byte-identical.
 */
export function withStarterPackContext(
  snapshot: CreateQuoteResponse,
  plan: StarterPackPlan | null,
): CreateQuoteResponse {
  if (!plan || !snapshot.quote.context) return snapshot;
  return {
    ...snapshot,
    quote: { ...snapshot.quote, context: { ...snapshot.quote.context, starterPack: plan } },
  };
}

/**
 * Catalog LIST anchor of the checkout lines, from the `base_unit` components
 * (order-scoped when present, per line otherwise; already line-extended).
 * Mirrors the configurator's `quotePerUnitAnchorMinor`.
 */
function listAnchorTotalMinor(snapshot: CreateQuoteResponse): number {
  const orderScoped = sumBaseUnit(snapshot.quote.pricingComponents);
  if (orderScoped > 0) return orderScoped;
  return snapshot.quote.lines.reduce(
    (total, line) => total + sumBaseUnit(line.pricingComponents),
    0,
  );
}

function sumBaseUnit(
  components: ReadonlyArray<{ componentType: string; amountMinor: number }> | undefined,
): number {
  if (!components) return 0;
  return components
    .filter((component) => component.componentType === "base_unit")
    .reduce((total, component) => total + component.amountMinor, 0);
}

/**
 * The line shape frozen into the marker (matching
 * `subscription_lines.line_metadata.productSnapshot.quoteLine`): the quote line
 * WITHOUT `pricingComponents`, which `extractQuoteLine` deletes on read-back.
 */
function frozenQuoteLine(line: CreateQuoteResponse["quote"]["lines"][number]): Record<string, unknown> {
  const { pricingComponents: _dropped, ...rest } = line;
  return { ...rest } as Record<string, unknown>;
}

/**
 * Prices the steady package at the steady cadence, in subscription mode, on the
 * same quote port. Promo codes are dropped on purpose: the frozen lines must be
 * the plain BAND prices delivery 3 onwards will be charged.
 */
async function quoteSteadyPackage(
  input: StarterOfferGuardInput,
  steadyCans: number,
  cadenceDays: 14 | 28,
): Promise<CreateQuoteResponse | null> {
  const steadyVariants = starterRescaleBasket(
    starterAggregateBySku(input.intent.selectedVariants),
    steadyCans,
  );
  // Fail closed on an unrepresentable basket (more distinct flavours than cans).
  // Quoting it would mint a marker whose lines contradict the size it promises.
  if (steadyVariants.reduce((total, v) => total + v.qty, 0) !== steadyCans) return null;
  const steadyIntent: ConfiguratorIntent = {
    ...input.intent,
    cadenceDays,
    promoCodes: [],
    sizeConstraint: { ...input.intent.sizeConstraint, kind: "unit_count", value: steadyCans },
    selectedVariants: steadyVariants,
  };
  try {
    const quoted = await input.quotePort.createQuote(
      buildQuoteRequest(steadyIntent, input.provisioned),
      input.provisioned.clientId ? { clientId: input.provisioned.clientId } : {},
    );
    return quoted.quote.lines.length > 0 ? quoted : null;
  } catch {
    return null;
  }
}
