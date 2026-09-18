// Subscription package-changed confirmation — content, owned by the subscription
// domain. Sent when the customer edits the box via self-service (swap recipe,
// add/remove/adjust add-on, plan length, portion mode) — all mapped to
// subscription.package_changed. Neutral confirmation that the requested box edit
// applies from the next cycle. Chrome/transport live in
// communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import type { SubscriptionPackageChangedCopy } from "./subscriptionEmailContent.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionPackageChangedEmailVars {
  firstName: string | null;
  action?: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionPackageChangedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionPackageChangedEmailContent(
  locale: Locale,
  vars: SubscriptionPackageChangedEmailVars,
  signoff: string,
): SubscriptionPackageChangedEmailContent {
  const copy: SubscriptionPackageChangedCopy = subscriptionEmailContent.packageChanged[locale];
  const actionLabel = vars.action ? copy.actionLabels[vars.action] ?? null : null;
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(actionLabel)),
    accentBox(copy.reassurance),
  ];

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
