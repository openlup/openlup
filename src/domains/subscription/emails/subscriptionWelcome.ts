// Subscription welcome / activation – content (the "what to say"), owned by the
// subscription domain. Sent on subscription creation. Onboarding, NOT a receipt:
// states the cadence, the next charge with its ESTIMATED delivery window, the
// composition edit deadline, and offers a "manage subscription" link.
// Chrome/transport live in communications + the Resend port.
//
// ⚠️ `chargeDateLabel` is the renewal CHARGE date (`subscriptions.next_cycle_at`),
// never a delivery promise. The delivery window is a separate, explicitly
// estimated label. This module is a pure renderer: every date arrives
// pre-formatted from the handler.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionWelcomeEmailVars {
  firstName: string | null;
  cadenceDays: number | null;
  /** Pre-formatted renewal CHARGE date (locale-formatted by the handler), or null. */
  chargeDateLabel: string | null;
  /** Pre-formatted estimated delivery window, e.g. "04.08.2026 – 05.08.2026", or null. */
  deliveryWindowLabel: string | null;
  /** Pre-formatted composition edit deadline, or null when unknown/already passed. */
  editCutoffLabel?: string | null;
  /**
   * Localized holiday caveat, supplied by the handler ONLY when a public holiday
   * actually moved the estimated window. Null/absent is the normal case and must
   * render nothing — a standing "we account for holidays" line is noise.
   */
  holidayNote?: string | null;
  /** Absolute "manage subscription" URL; null/absent → no button. */
  ctaUrl?: string | null;
  /**
   * Starter-pack acquisition facts, present only for a subscription that carries
   * an acquisition marker. `starterAmountLabel` is the DELIVERY-2 amount — the
   * discounted repeat that lands on the date already stated above — and the
   * steady pair describes what delivery 3 onwards looks like. The whole block is
   * dropped when any of it is unknown; a half-stated plan is worse than none.
   */
  starterAmountLabel?: string | null;
  starterSteadyUnitCount?: number | null;
  starterSteadyCadenceDays?: number | null;
}

export interface SubscriptionWelcomeEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionWelcomeEmailContent(
  locale: Locale,
  vars: SubscriptionWelcomeEmailVars,
  signoff: string,
): SubscriptionWelcomeEmailContent {
  const copy = subscriptionEmailContent.welcome[locale];
  const details: string[] = [];
  if (vars.cadenceDays && vars.cadenceDays > 0) details.push(copy.cadenceLine(vars.cadenceDays));
  // Both labels are derived from the same `next_cycle_at`, so they are present or
  // absent together; the fallback keeps the pre-existing "we'll confirm" promise.
  details.push(
    vars.chargeDateLabel && vars.deliveryWindowLabel
      ? copy.deliveryLine(vars.deliveryWindowLabel, vars.chargeDateLabel)
      : copy.fallbackLine,
  );
  if (vars.holidayNote) details.push(vars.holidayNote);
  // Acquisition plan: the delivery-2 amount and the steady rhythm, stated once at
  // the only moment the customer is actually reading about their plan.
  if (vars.starterAmountLabel) details.push(copy.starterDelivery2Line(vars.starterAmountLabel));
  if (vars.starterSteadyUnitCount && vars.starterSteadyCadenceDays) {
    details.push(copy.starterSteadyLine(vars.starterSteadyUnitCount, vars.starterSteadyCadenceDays));
  }
  if (vars.editCutoffLabel) details.push(copy.editCutoffLine(vars.editCutoffLabel));

  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
    accentBox(details, { label: copy.detailsLabel }),
  ];

  blocks.push(paragraph(copy.manageLine));

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
