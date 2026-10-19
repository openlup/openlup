import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface ReorderReminderEmailVars {
  firstName: string | null;
  /** Brand label used in body copy; callers must inject the app/tenant label. */
  brandName: string;
  /** Absolute CTA URL back to the configurator (compose/reorder the next box). */
  ctaUrl: string;
  /** Absolute signed unsubscribe URL (purpose 'marketing_newsletter'). */
  unsubscribeUrl: string;
}

export interface ReorderReminderEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createReorderReminderContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "reorderReminder">;
  marketingUnsubscribeFooter: (locale: Locale, unsubscribeUrl: string) => EmailBlock[];
}) {
  const { commerceEmailContent, marketingUnsubscribeFooter } = input;

  function reorderReminderEmailContent(
    locale: Locale,
    vars: ReorderReminderEmailVars,
    signoff: string,
  ): ReorderReminderEmailContent {
    const copy = commerceEmailContent.reorderReminder[locale];

    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(vars.brandName)),
      paragraph(copy.consistencyNote),
      accentBox(copy.upsellLines, { label: copy.upsellLabel }),
      button(copy.cta, vars.ctaUrl),
      paragraph(signoff),
      ...marketingUnsubscribeFooter(locale, vars.unsubscribeUrl),
    ];

    return {
      subject: copy.subject,
      preheader: copy.preheader,
      blocks,
    };
  }
  return { reorderReminderEmailContent };
}
