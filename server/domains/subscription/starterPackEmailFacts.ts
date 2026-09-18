import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import {
  resolveDelivery2DiscountMinor,
  type StarterPackMarker,
} from "./starterPackCycle.js";

/**
 * What the lifecycle emails need to know about a starter-pack acquisition.
 *
 * The two customer-facing surprises of the offer are (a) delivery 2 costs a
 * different amount than delivery 1 and (b) delivery 3 changes the package size
 * and the rhythm. Both are stated in the marker frozen at checkout, so this
 * module reads it and turns it into pre-formatted copy facts. It renders no
 * sentence and formats no money itself — the wording lives with the content
 * modules, and the money label arrives through an injected formatter.
 *
 * ⛔ Best-effort by design, unlike the renewal ENGINE's read of the same marker.
 * An email that cannot prove an amount omits it; it never guesses. Whenever
 * `template_version` has moved away from the marker's basis, the frozen numbers
 * no longer describe the template the customer will actually be charged for, so
 * every field is dropped and the email renders exactly as it did before this
 * wave.
 */

/** Additive optional block mixed into the renewal and welcome email inputs. */
export interface StarterPackEmailFields {
  /** Which starter delivery this email is about; null for everything else. */
  starterStage?: "delivery2" | "graduation" | null;
  /** Pre-formatted gross amount of the starter delivery being announced. */
  starterAmountLabel?: string | null;
  /** Units per delivery from the graduation on. */
  starterSteadyUnitCount?: number | null;
  /** Days between deliveries from the graduation on (14 or 28). */
  starterSteadyCadenceDays?: number | null;
}

/**
 * Turns a minor-unit amount into the label the email prints. Injected, so no
 * currency or locale decision is taken in this domain: the managed composition
 * supplies its own formatter (see
 * `server/adapters/supabase/subscription/starterPackContext.ts`).
 */
export type StarterMoneyLabelFormatter = (amountMinor: number, currency: string | null) => string | null;

export interface SubscriptionStarterPackContext {
  marker: StarterPackMarker;
  templateVersion: number;
  /** Cycle number of the delivery this email is announcing (`max + 1`). */
  upcomingCycleNumber: number;
  /**
   * The subscription's own currency, read alongside the marker. Carried rather
   * than assumed: the amount below is money a customer will be charged, and a
   * module that names one merchant's currency prints the wrong figure for every
   * other merchant. Null only when the read could not prove one, in which case
   * the amount is omitted — the same best-effort rule the whole module follows.
   */
  currency: string | null;
}

export interface SubscriptionStarterPackPort {
  /**
   * Marker + template version + upcoming cycle number, or null when the
   * subscription carries no marker (the overwhelmingly common case, answered by
   * ONE `subscriptions` read). Never throws: a starter-aware email that cannot
   * read state degrades to the ordinary email rather than blocking the send.
   */
  read(
    subscriptionId: string,
    signal: AbortSignal,
  ): Promise<SubscriptionStarterPackContext | null>;
}

/**
 * What a composition must supply for an email to state starter-pack amounts:
 * the state read and the money label that renders them. Paired on purpose —
 * a reader without a formatter could only print an amount this domain is not
 * allowed to format.
 */
export interface SubscriptionStarterPackComposition {
  port: SubscriptionStarterPackPort;
  moneyLabel: (locale: Locale) => StarterMoneyLabelFormatter;
}

const EMPTY: StarterPackEmailFields = {};

/**
 * Facts for the "your renewal is coming up" reminder.
 *
 * Cycle 2 is the discounted repeat of the acquisition template, so the amount is
 * the frozen basis minus the frozen delivery-2 discount — resolved through the
 * SAME function the renewal engine charges with, so the email and the charge
 * cannot disagree.
 *
 * Cycle 3 is the graduation: the subscription is about to switch to the steady
 * package, so the amount and the unit count come from the frozen graduation
 * lines rather than from the current (still-acquisition) template.
 */
export function starterRenewalEmailFields(
  context: SubscriptionStarterPackContext | null,
  moneyLabel: StarterMoneyLabelFormatter,
): StarterPackEmailFields {
  if (!context) return EMPTY;
  const { marker, templateVersion, upcomingCycleNumber } = context;
  // A moved template means a customer edit landed; the frozen numbers describe a
  // basket that no longer exists, so say nothing rather than something wrong.
  if (templateVersion !== marker.basisTemplateVersion) return EMPTY;

  if (upcomingCycleNumber === 2) {
    const subtotalMinor = marker.delivery2.basisSubtotalMinor;
    const discountMinor = resolveDelivery2DiscountMinor({
      marker,
      templateVersion,
      subtotalMinor,
    });
    return {
      starterStage: "delivery2",
      starterAmountLabel: moneyLabel(subtotalMinor - discountMinor, context.currency),
    };
  }

  if (upcomingCycleNumber === 3) {
    const totals = graduationTotals(marker);
    if (totals === null) return EMPTY;
    return {
      starterStage: "graduation",
      starterAmountLabel: moneyLabel(totals.subtotalMinor, context.currency),
      starterSteadyUnitCount: totals.units,
      starterSteadyCadenceDays: marker.graduation.cadenceDays,
    };
  }

  return EMPTY;
}

/**
 * Facts for the welcome email, sent the moment the acquisition subscription goes
 * active. The payload's `nextCycleAt` is already the delivery-2 date (paid + I,
 * written by the creation RPC), so only the amount and the steady plan are
 * missing.
 *
 * Takes the whole context, not just the marker: an outbox row can be delayed or
 * retried, so the send can land AFTER a customer edit. When `template_version`
 * has moved off the frozen basis, every frozen number describes a package that
 * no longer exists, and this degrades to the ordinary welcome e-mail rather than
 * quoting an amount the customer will never be charged. Same guard the renewal
 * reminder next door applies, for the same reason.
 */
export function starterWelcomeEmailFields(
  context: SubscriptionStarterPackContext | null,
  moneyLabel: StarterMoneyLabelFormatter,
): StarterPackEmailFields {
  if (!context) return EMPTY;
  const { marker, templateVersion } = context;
  if (templateVersion !== marker.basisTemplateVersion) return EMPTY;
  const totals = graduationTotals(marker);
  const discountMinor = resolveDelivery2DiscountMinor({
    marker,
    templateVersion: marker.basisTemplateVersion,
    subtotalMinor: marker.delivery2.basisSubtotalMinor,
  });
  return {
    starterStage: "delivery2",
    starterAmountLabel: moneyLabel(marker.delivery2.basisSubtotalMinor - discountMinor, context.currency),
    starterSteadyUnitCount: totals?.units ?? null,
    starterSteadyCadenceDays: marker.graduation.cadenceDays,
  };
}

function graduationTotals(
  marker: StarterPackMarker,
): { units: number; subtotalMinor: number } | null {
  let units = 0;
  let subtotalMinor = 0;
  for (const line of marker.graduation.lines) {
    units += line.qty;
    const amount = lineSubtotalMinor(line.quoteLine);
    if (amount === null) return null;
    subtotalMinor += amount;
  }
  return { units, subtotalMinor };
}

function lineSubtotalMinor(quoteLine: Record<string, unknown>): number | null {
  const subtotal = quoteLine.lineSubtotalGross;
  if (!subtotal || typeof subtotal !== "object") return null;
  const amount = (subtotal as Record<string, unknown>).amountMinor;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}
