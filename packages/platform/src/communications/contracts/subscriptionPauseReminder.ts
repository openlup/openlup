import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface SubscriptionPauseReminderEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** Pre-formatted resume date, or null when unknown. */
  resumeDateLabel: string | null;
  /** Absolute CTA URL to manage the subscription. */
  ctaUrl: string;
}

export interface SubscriptionPauseReminderEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionPauseReminderContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "pauseReminder">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionPauseReminderEmailContent(
    locale: Locale,
    vars: SubscriptionPauseReminderEmailVars,
    signoff: string,
  ): SubscriptionPauseReminderEmailContent {
    const copy = subscriptionEmailContent.pauseReminder[locale];
    const resumeDate = vars.resumeDateLabel
      ? locale === "en"
        ? ` on ${vars.resumeDateLabel}`
        : ` ${vars.resumeDateLabel}`
      : "";

    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(vars.brandName)),
      paragraph(copy.resume(resumeDate)),
      accentBox(copy.reassurance),
      button(copy.cta, vars.ctaUrl),
      paragraph(copy.outro),
      paragraph(signoff),
    ];

    return {
      subject: copy.subject,
      preheader: copy.preheader,
      blocks,
    };
  }
  return { subscriptionPauseReminderEmailContent };
}
