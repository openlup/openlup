import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import type { SubscriptionRenewalUpcomingCopy } from "./subscriptionEmailContent.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface SubscriptionRenewalUpcomingEmailVars {
  firstName: string | null;
  /** Pre-formatted renewal CHARGE date (locale-formatted by the worker). */
  renewalDateLabel: string | null;
  /** Pre-formatted estimated delivery window, or null when unavailable. */
  deliveryWindowLabel?: string | null;
  /** Localized holiday caveat; present ONLY when a holiday moved the window. */
  holidayNote?: string | null;
  /**
   * Pre-formatted composition edit deadline. Null when unknown OR when the
   * deadline has already passed at send time — see the module header.
   */
  editCutoffLabel?: string | null;
  /** Formatted gross amount of the upcoming charge, e.g. "129,99 zł", or null. */
  amountLabel: string | null;
  /**
   * Starter-pack acquisition stage of the delivery being announced, or null for
   * an ordinary renewal. `"graduation"` means the NEXT delivery switches to the
   * steady package — a size and rhythm change the customer agreed to at checkout
   * but has not seen since, so it gets its own paragraph rather than a detail
   * line. `"delivery2"` only marks the discounted repeat; its amount already
   * rides on `amountLabel`.
   */
  starterStage?: "delivery2" | "graduation" | null;
  /** Units per delivery from the graduation on; renders only with `"graduation"`. */
  starterSteadyUnitCount?: number | null;
  /** Days between deliveries from the graduation on; renders only with `"graduation"`. */
  starterSteadyCadenceDays?: number | null;
  /** Adopter-formatted steady package, already localized; renders only with `"graduation"`. */
  starterSteadyDetail?: string | null;
  /** Absolute "manage subscription" URL; null/absent → no button. */
  ctaUrl?: string | null;
  /** Optional consumer context label; absent/null uses the selected pack's fallback. */
  contextName?: string | null;
}

export interface SubscriptionRenewalUpcomingEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionRenewalUpcomingContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "renewalUpcoming">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionRenewalUpcomingEmailContent(
    locale: Locale,
    vars: SubscriptionRenewalUpcomingEmailVars,
    signoff: string,
  ): SubscriptionRenewalUpcomingEmailContent {
    const copy: SubscriptionRenewalUpcomingCopy = subscriptionEmailContent.renewalUpcoming[locale];
    const details: string[] = [
      vars.renewalDateLabel ? copy.dateLine(vars.renewalDateLabel) : copy.noDateLine,
    ];
    if (vars.deliveryWindowLabel) details.push(copy.deliveryLine(vars.deliveryWindowLabel));
    if (vars.holidayNote) details.push(vars.holidayNote);
    if (vars.amountLabel) details.push(copy.amountLine(vars.amountLabel));
    // Null when already past — the caller, not this renderer, owns that decision.
    if (vars.editCutoffLabel) details.push(copy.editCutoffLine(vars.editCutoffLabel));

    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(vars.contextName ?? null)),
      accentBox(details, { label: copy.detailsLabel }),
    ];

    // The package-size change is the one thing in this email a customer could be
    // surprised by, so it gets its own paragraph ABOVE the generic self-service
    // line, and it names moving the delivery first.
    if (vars.starterStage === "graduation" && vars.starterSteadyUnitCount && vars.starterSteadyCadenceDays) {
      blocks.push(paragraph(copy.starterGraduationLine(vars.starterSteadyUnitCount, vars.starterSteadyCadenceDays, vars.starterSteadyDetail)));
    }
    blocks.push(paragraph(copy.manageLine));

    if (vars.ctaUrl) {
      blocks.push(button(copy.cta, vars.ctaUrl));
    }

    blocks.push(paragraph(signoff));

    return {
      subject: copy.subject,
      preheader: copy.preheader,
      blocks,
    };
  }
  return { subscriptionRenewalUpcomingEmailContent };
}
