import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

/** 1 = light same-session nudge, 24 = gentle nudge, 72 = final last-nudge. */
export type AbandonedCartReminderHours = 1 | 24 | 72;

export interface AbandonedCartEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  reminderHours: AbandonedCartReminderHours;
  /** Absolute CTA URL back to the configurator. */
  ctaUrl: string;
  /** Absolute signed unsubscribe URL (purpose 'marketing_newsletter'). */
  unsubscribeUrl: string;
}

export interface AbandonedCartEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createAbandonedCartContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "abandonedCart">;
  marketingUnsubscribeFooter: (locale: Locale, unsubscribeUrl: string) => EmailBlock[];
}) {
  const { commerceEmailContent, marketingUnsubscribeFooter } = input;

  function abandonedCartEmailContent(
    locale: Locale,
    vars: AbandonedCartEmailVars,
    signoff: string,
  ): AbandonedCartEmailContent {
    const copy = commerceEmailContent.abandonedCart[locale];
    const tone =
      vars.reminderHours === 72 ? copy.last : vars.reminderHours === 1 ? copy.first : copy.gentle;
    const withBrand = (text: string) => text.split("{{brand}}").join(vars.brandName);

    const blocks: EmailBlock[] = [
      heading(withBrand(tone.heading)),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(withBrand(tone.intro)),
      paragraph(withBrand(tone.body)),
      button(tone.cta, vars.ctaUrl),
      paragraph(signoff),
      ...marketingUnsubscribeFooter(locale, vars.unsubscribeUrl),
    ];

    return {
      subject: withBrand(tone.subject),
      preheader: withBrand(tone.preheader),
      blocks,
    };
  }
  return { abandonedCartEmailContent };
}
