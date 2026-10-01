import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import type { StarterPackMarker } from "./starterPackCycle.js";
import { resolveStarterUpcomingCharge, starterGraduationTotals } from "./starterPackCharge.js";

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
 * An email that cannot prove an amount omits it; it never guesses. Every amount
 * is the renewal engine's own (`./starterPackCharge.ts`), priced on the lines on
 * file, so a moved `template_version` changes the amount rather than silencing
 * it; only an unreadable line subtotal on a moved template drops the fields.
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
  /** Adopter-formatted detail of the steady plan, already localized. */
  starterSteadyDetail?: string | null;
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
  /** Current cadence; the graduation phase depends on it. */
  cadenceDays: number;
  /**
   * Band subtotal and catalog list total of the lines on file; either is null
   * when it could not be read, and the amount is then omitted or taken from
   * the frozen basis only when the template is still that basis.
   */
  currentLines: { subtotalMinor: number | null; listAnchorMinor: number | null };
  /** Cycle number of the delivery this email is announcing (`upcomingCycle`). */
  upcomingCycleNumber: number;
  /**
   * For an open (re-driven) cycle, the delivery-2 discount its first attempt
   * stored, which the engine keeps on retry; null or absent otherwise.
   */
  retriedCycleDiscountMinor?: number | null;
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
 * The amount comes from `resolveStarterUpcomingCharge`, the SAME computation the
 * renewal engine charges with, so the email and the charge cannot disagree:
 * delivery 2 is priced on the lines actually on file (a reactivation or an edit
 * no longer silences the amount), and the graduation states the frozen steady
 * package. A cycle the starter pack does not price says nothing.
 */
export function starterRenewalEmailFields(
  context: SubscriptionStarterPackContext | null,
  moneyLabel: StarterMoneyLabelFormatter,
): StarterPackEmailFields {
  if (!context) return EMPTY;
  const charge = upcomingCharge(context, context.upcomingCycleNumber, context.retriedCycleDiscountMinor ?? null);
  if (!charge) return EMPTY;
  if (charge.stage === "delivery2") {
    return {
      starterStage: "delivery2",
      starterAmountLabel: moneyLabel(charge.totalMinor, context.currency),
    };
  }
  const totals = starterGraduationTotals(context.marker);
  if (totals === null) return EMPTY;
  return {
    starterStage: "graduation",
    starterAmountLabel: moneyLabel(charge.totalMinor, context.currency),
    starterSteadyUnitCount: totals.units,
    starterSteadyCadenceDays: context.marker.graduation.cadenceDays,
  };
}

/**
 * Facts for the welcome email, sent the moment the acquisition subscription goes
 * active. The payload's `nextCycleAt` is already the delivery-2 date (paid + I,
 * written by the creation RPC), so only the amount and the steady plan are
 * missing. An outbox row can be delayed past a customer edit; the amount is
 * therefore priced on the lines on file, exactly as the engine will charge it.
 */
export function starterWelcomeEmailFields(
  context: SubscriptionStarterPackContext | null,
  moneyLabel: StarterMoneyLabelFormatter,
): StarterPackEmailFields {
  if (!context) return EMPTY;
  const charge = upcomingCharge(context, 2);
  if (!charge) return EMPTY;
  const totals = starterGraduationTotals(context.marker);
  return {
    starterStage: "delivery2",
    starterAmountLabel: moneyLabel(charge.totalMinor, context.currency),
    starterSteadyUnitCount: totals?.units ?? null,
    starterSteadyCadenceDays: context.marker.graduation.cadenceDays,
  };
}

/**
 * The engine's amount for `cycleNumber`. Without a readable line subtotal the
 * email only speaks when the template is still the frozen basis, whose subtotal
 * the marker itself records; otherwise it omits the amount rather than guess.
 */
function upcomingCharge(
  context: SubscriptionStarterPackContext,
  cycleNumber: number,
  retriedCycleDiscountMinor: number | null = null,
) {
  const { marker, templateVersion } = context;
  const subtotalMinor =
    context.currentLines.subtotalMinor ??
    (templateVersion === marker.basisTemplateVersion ? marker.delivery2.basisSubtotalMinor : null);
  if (subtotalMinor === null) return null;
  return resolveStarterUpcomingCharge({
    marker,
    templateVersion,
    cadenceDays: context.cadenceDays,
    cycleNumber,
    currentLines: { subtotalMinor, listAnchorMinor: context.currentLines.listAnchorMinor },
    retriedCycleDiscountMinor,
  });
}
