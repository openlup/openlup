// Checkout-recovery email – content (the "what to say"), owned by commerce.
// Sent when a checkout started but the first payment was never completed (order
// stays `pending_payment`). TRANSACTIONAL (not marketing): no unsubscribe footer,
// no consent gate. The CTA is a signed deep-link straight to "Dokończ płatność"
// for the SAME order. Two tones by reminderHours (1 = first nudge, 20 = final),
// and mode-aware copy (subscription first cycle vs one-time order).
// Chrome/transport live in communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import { button, heading, paragraph, type EmailBlock } from "../../communications/email/blocks.js";

export type CheckoutRecoveryReminderHours = 1 | 20;
export type CheckoutRecoveryMode = "subscription_cycle" | "one_time";

export interface CheckoutRecoveryEmailVars {
  firstName: string | null;
  brandName: string;
  reminderHours: CheckoutRecoveryReminderHours;
  mode: CheckoutRecoveryMode;
  /** Absolute signed deep-link to complete payment for this order. */
  recoveryUrl: string;
  /** Optional deployment-specific context consumed by the selected copy pack. */
  contextName?: string | null;
}

export interface CheckoutRecoveryEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function checkoutRecoveryEmailContent(
  locale: Locale,
  vars: CheckoutRecoveryEmailVars,
  signoff: string,
): CheckoutRecoveryEmailContent {
  const copy = commerceEmailContent.checkoutRecovery[locale];
  const isFinal = vars.reminderHours === 20;
  // The optional selected-pack context note runs only on the first nudge (1h).
  // The final reminder (20h) stays businesslike, so it never sits next to the
  // "order will be canceled" note.
  const showCheer = !isFinal;
  const isSubscription = vars.mode === "subscription_cycle";
  const intro = isSubscription
    ? copy.introSubscription
    : showCheer
      ? `${copy.introOneTime} ${copy.contextCheer(vars.contextName ?? null)}`
      : copy.introOneTime;

  const blocks: EmailBlock[] = [
    heading(isFinal ? copy.headingFinal : copy.headingFirst),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(intro),
    button(copy.cta, vars.recoveryUrl),
  ];
  if (isSubscription && showCheer) {
    blocks.push(paragraph(copy.subscriptionCheer(vars.contextName ?? null, vars.brandName)));
  }
  if (isFinal) blocks.push(paragraph(copy.finalNote));
  blocks.push(paragraph(signoff));

  return {
    subject: isFinal ? copy.subjectFinal : copy.subjectFirst,
    preheader: copy.preheader,
    blocks,
  };
}
