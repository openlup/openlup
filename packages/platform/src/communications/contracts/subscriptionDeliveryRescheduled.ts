import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  dataTable,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface SubscriptionDeliveryRescheduledEmailVars {
  firstName: string | null;
  /** Localized new CHARGE date (the date the customer picked), or null. */
  chargeDateLabel?: string | null;
  /** Localized estimated delivery window derived from the new charge date, or null. */
  deliveryWindowLabel?: string | null;
  /** Localized holiday caveat; present ONLY when a holiday moved the window. */
  holidayNote?: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionDeliveryRescheduledEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionDeliveryRescheduledContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "deliveryRescheduled">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionDeliveryRescheduledEmailContent(
    locale: Locale,
    vars: SubscriptionDeliveryRescheduledEmailVars,
    signoff: string,
  ): SubscriptionDeliveryRescheduledEmailContent {
    const copy = subscriptionEmailContent.deliveryRescheduled[locale];
    const hasSchedule = Boolean(vars.chargeDateLabel && vars.deliveryWindowLabel);
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(hasSchedule ? copy.intro : copy.introWithoutDates),
    ];

    if (locale === "pl" && hasSchedule) {
      blocks.push(dataTable([
        { label: copy.deliveryLabel, value: vars.deliveryWindowLabel! },
        { label: copy.chargeLabel, value: vars.chargeDateLabel! },
      ]));
    }

    const reassurance = [
      ...(locale !== "pl" && hasSchedule
        ? [copy.dateLine(vars.deliveryWindowLabel!, vars.chargeDateLabel!)]
        : []),
      ...(vars.holidayNote ? [vars.holidayNote] : []),
      ...copy.reassurance,
    ];
    blocks.push(accentBox(reassurance));

    if (vars.ctaUrl) {
      blocks.push(button(copy.cta, vars.ctaUrl));
    }

    blocks.push(paragraph(copy.outro));
    blocks.push(paragraph(signoff));

    return {
      subject: hasSchedule ? copy.subject : copy.subjectWithoutDates,
      preheader: copy.preheader,
      blocks,
    };
  }
  return { subscriptionDeliveryRescheduledEmailContent };
}
