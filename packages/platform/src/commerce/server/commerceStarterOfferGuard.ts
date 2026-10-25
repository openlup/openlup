import type { z } from "zod";
import type { ConfiguratorIntent } from "../contracts/index.js";
import type { CommerceQuotePort } from "../ports.js";
import type { StarterTermsPort, StarterTermsRefusal } from "./starterTermsPort.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
export interface StarterDeclaration {
  intervalDays: number; delivery2DiscountBps: number;
  acquisitionTerms?: { revision: string; delivery2DiscountBps: number };
  steady: { cadenceDays: number; units: number };
}
export type StarterOfferGuardResult<Plan> = { kind: "absent" } | { kind: "rejected"; reason: string } | { kind: "minted"; plan: Plan };
export function withStarterPackContext<Snapshot extends CheckoutQuoteSnapshot, Plan>(snapshot: Snapshot, plan: Plan | null): Snapshot {
  if (!plan || !snapshot.quote.context) return snapshot;
  return { ...snapshot, quote: { ...snapshot.quote, context: { ...snapshot.quote.context, starterPack: plan } } };
}
export function createStarterOfferGuard<Intent extends ConfiguratorIntent, Provisioned extends { clientId: string | null }, Request, Snapshot extends CheckoutQuoteSnapshot, Plan>(bindings: {
  declaration(intent: Intent): StarterDeclaration | undefined;
  defaultTermsPort: StarterTermsPort<Intent, Snapshot>;
  defaultDiscountBps: number;
  discountMinor(input: { bandSubtotalMinor: number; listAnchorTotalMinor: number; discountBps: number }): number | null;
  planSchema: z.ZodType<Plan>;
  aggregateBySku(entries: Intent["selectedVariants"]): Intent["selectedVariants"];
  rescaleBasket(entries: Intent["selectedVariants"], units: number): Intent["selectedVariants"];
  steadyIntent(intent: Intent, cadenceDays: number, units: number, variants: Intent["selectedVariants"]): Intent;
  buildQuoteRequest(intent: Intent, provisioned: Provisioned): Request;
}) {
  type CreateQuoteResponse = Snapshot;
  type StarterPackPlan = Plan;
  type StarterOfferGuardInput = {
    flagEnabled: boolean; intent: Intent; provisioned: Provisioned;
    authoritativeQuote: Snapshot; quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>;
    isFirstOrderEligible?: () => Promise<boolean>;
    termsPort?: StarterTermsPort<Intent, Snapshot>; offerVersion?: string;
  }


type StarterOfferRejectionReason =
  | "starter_offer_disabled"
  | "starter_offer_wrong_mode"
  | "starter_offer_not_first_order"
  | "starter_offer_basket_too_small"
  | "starter_offer_basket_not_admitted"
  | "starter_offer_demand_unknown"
  | "starter_offer_terms_drifted"
  | "starter_offer_uncollectable_delivery_2"
  | "starter_offer_steady_quote_failed"
  | "starter_offer_plan_invalid";

const TERMS_REFUSALS: Record<StarterTermsRefusal, StarterOfferRejectionReason> = {
  basket_too_small: "starter_offer_basket_too_small",
  basket_not_admitted: "starter_offer_basket_not_admitted",
  demand_unknown: "starter_offer_demand_unknown",
};

const ACQUISITION_TEMPLATE_VERSION = 1;

async function resolveStarterOfferGuard(
  input: StarterOfferGuardInput,
): Promise<StarterOfferGuardResult<Plan>> {
  const declared = bindings.declaration(input.intent);
  // Flag OFF and nothing declared is the overwhelmingly common case and must do
  // exactly zero work — no quote, no read, no allocation.
  if (!declared) return { kind: "absent" };
  if (!input.flagEnabled) return { kind: "rejected", reason: "starter_offer_disabled" };
  if (input.intent.mode !== "subscription") {
    return { kind: "rejected", reason: "starter_offer_wrong_mode" };
  }

  // The terms of the effective basket, from the server's own quote. The default
  // port is the arithmetic the client asks with (see `defaultStarterTermsPort`),
  // so any disagreement below is a drifted ask, never a rounding difference.
  const resolution = await (input.termsPort ?? bindings.defaultTermsPort).resolve({
    intent: input.intent,
    authoritativeQuote: input.authoritativeQuote,
    ...(input.offerVersion ? { offerVersion: input.offerVersion } : {}),
  });
  if (resolution.kind === "refused") {
    return { kind: "rejected", reason: TERMS_REFUSALS[resolution.reason] };
  }
  const {
    intervalDays,
    steadyCadenceDays: cadenceDays,
    steadyUnits: steadyUnits,
    graduationSizeConstraint,
  } = resolution.terms;
  const acquisition = input.authoritativeQuote.quote.context?.acquisitionTerms;
  const delivery2DiscountBps = acquisition?.delivery2DiscountBps ?? bindings.defaultDiscountBps;
  if (
    (acquisition !== undefined && (declared.acquisitionTerms?.revision !== acquisition.revision ||
      declared.acquisitionTerms.delivery2DiscountBps !== delivery2DiscountBps)) ||
    declared.intervalDays !== intervalDays ||
    declared.delivery2DiscountBps !== delivery2DiscountBps ||
    declared.steady.cadenceDays !== cadenceDays ||
    declared.steady.units !== steadyUnits
  ) {
    return { kind: "rejected", reason: "starter_offer_terms_drifted" };
  }

  if (!(await input.isFirstOrderEligible?.())) {
    return { kind: "rejected", reason: "starter_offer_not_first_order" };
  }

  const bandSubtotalMinor = input.authoritativeQuote.quote.subtotalGross.amountMinor;
  const discountMinor = bindings.discountMinor({
    bandSubtotalMinor,
    listAnchorTotalMinor: listAnchorTotalMinor(input.authoritativeQuote),
    discountBps: delivery2DiscountBps,
  });
  if (discountMinor === null) {
    return { kind: "rejected", reason: "starter_offer_uncollectable_delivery_2" };
  }

  const steadyQuote = await quoteSteadyPackage(input, steadyUnits, cadenceDays);
  if (steadyQuote === null) {
    return { kind: "rejected", reason: "starter_offer_steady_quote_failed" };
  }

  const parsed = bindings.planSchema.safeParse({
    schemaVersion: "1",
    starterIntervalDays: intervalDays,
    basisTemplateVersion: ACQUISITION_TEMPLATE_VERSION,
    delivery2: {
      discountBps: delivery2DiscountBps,
      discountMinor,
      basisSubtotalMinor: bandSubtotalMinor,
    },
    graduation: {
      cadenceDays,
      sizeConstraint: graduationSizeConstraint ?? { kind: "unit_count", value: steadyUnits },
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

function frozenQuoteLine(line: CreateQuoteResponse["quote"]["lines"][number]): Record<string, unknown> {
  const { pricingComponents: _dropped, ...rest } = line;
  return { ...rest } as Record<string, unknown>;
}

async function quoteSteadyPackage(
  input: StarterOfferGuardInput,
  steadyUnits: number,
  cadenceDays: number,
): Promise<CreateQuoteResponse | null> {
  const steadyVariants = bindings.rescaleBasket(
    bindings.aggregateBySku(input.intent.selectedVariants),
    steadyUnits,
  );
  // Fail closed on an unrepresentable basket (more distinct variants than units).
  // Quoting it would mint a marker whose lines contradict the size it promises.
  if (steadyVariants.reduce((total, v) => total + v.qty, 0) !== steadyUnits) return null;
  const steadyIntent = bindings.steadyIntent(input.intent, cadenceDays, steadyUnits, steadyVariants);
  try {
    // A bound offer prices its steady basket from its own list, like the checkout quote.
    const quoted = await input.quotePort.createQuote(
      bindings.buildQuoteRequest(steadyIntent, input.provisioned),
      {
        ...(input.provisioned.clientId ? { clientId: input.provisioned.clientId } : {}),
        ...(input.offerVersion ? { offerVersion: input.offerVersion } : {}),
        ...(input.authoritativeQuote.quote.context?.pricingPolicy
          ? { pricingPolicy: input.authoritativeQuote.quote.context.pricingPolicy } : {}),
      },
    );
    return quoted.quote.lines.length > 0 ? quoted : null;
  } catch {
    return null;
  }
}

return { resolveStarterOfferGuard };
}
