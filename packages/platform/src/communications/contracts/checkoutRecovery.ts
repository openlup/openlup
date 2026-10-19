import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import { button, heading, paragraph, type EmailBlock } from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createCheckoutRecoveryContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "checkoutRecovery">;
}) {
  const { commerceEmailContent } = input;

  function checkoutRecoveryEmailContent(
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
  return { checkoutRecoveryEmailContent };
}
