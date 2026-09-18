// Render functions for the commerce transactional emails: each maps a send input
// to {subject, html, text} by composing a commerce content module (the copy) with
// the shared branded renderer (the chrome) and a localized CTA URL. Kept separate
// from the Resend adapter (transactionalEmailPort.ts) so the execution port
// stays small as more email types are added.

import type {
  OrderConfirmationEmailInput,
  OrderPaidConfirmationEmailInput,
  CheckoutExpiredEmailInput,
  PaymentFailedEmailInput,
  OrderCanceledEmailInput,
  OrderRefundedEmailInput,
  CheckoutRecoveryEmailInput,
} from "../../domains/commerce/outboxOrderDraftEmailPorts.js";
import { orderDraftEmailContent } from "../../../src/domains/commerce/emails/orderDraft.js";
import { checkoutRecoveryEmailContent } from "../../../src/domains/commerce/emails/checkoutRecovery.js";
import { orderPaidEmailContent } from "../../../src/domains/commerce/emails/orderPaid.js";
import { paymentFailedEmailContent } from "../../../src/domains/commerce/emails/paymentFailed.js";
import { checkoutExpiredEmailContent } from "../../../src/domains/commerce/emails/checkoutExpired.js";
import { orderCanceledEmailContent } from "../../../src/domains/commerce/emails/orderCanceled.js";
import { orderRefundedEmailContent } from "../../../src/domains/commerce/emails/orderRefunded.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import { emailPresentation as defaultEmailPresentation } from "../../../src/domains/communications/email/exampleEmailPresentation.js";
import {
  emailCopyBrandName,
  type EmailPresentation,
} from "../../../src/domains/communications/email/presentation.js";
import {
  emailRouteUrl,
  emailRouteUrlForRecoveryDestination,
} from "../../../src/domains/communications/email/links.js";
import { resolveRecoveryDestination } from "../../../src/domains/commerce/ports.js";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export {
  renderReturnApproved,
  renderReturnRejected,
  renderShipmentDelivered,
  renderShipmentDispatched,
  renderShipmentException,
} from "./transactionalFulfillmentEmailRenderers.js";

export function renderOrderConfirmation(
  input: OrderConfirmationEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Order-DRAFT resume nudge. "Finish your mix" CTA back to the configurator (the
  // draft event carries no resume token). Locale defaults to PL for pre-locale callers.
  const locale = input.locale ?? "pl";
  const content = orderDraftEmailContent(
    locale,
    {
      firstName: input.firstName,
      petName: input.petName ?? null,
      orderId: input.orderId,
      items: input.items,
      totals: input.totals,
      ctaUrl: emailRouteUrl(baseUrl, "configurator", locale),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderCheckoutRecovery(
  input: CheckoutRecoveryEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Transactional "finish your payment" nudge. Builds the signed deep-link from
  // the raw recovery token, locale-aware. Locale defaults to PL pre-locale.
  const locale = input.locale ?? "pl";
  const recoveryDestination = resolveRecoverableCheckoutDestination(input.mode);
  const content = checkoutRecoveryEmailContent(
    locale,
    {
      firstName: input.firstName,
      brandName: emailCopyBrandName(presentation),
      contextName: input.petName ?? null,
      reminderHours: input.reminderHours === 20 ? 20 : 1,
      mode:
        input.mode === "subscription_cycle" ? "subscription_cycle" : "one_time",
      // `src=hatch` rides only on the buyer's own escape-hatch link, so the
      // landing page can count an arrival that came off a stuck payment step
      // separately from a cron nudge. Every other producer sends no `linkSource`
      // and its URL is byte-identical to what it was.
      recoveryUrl: emailRouteUrlForRecoveryDestination(baseUrl, recoveryDestination, locale, {
        token: input.recoveryToken,
        ...(input.linkSource === "buyer_hatch" ? { src: "hatch" } : {}),
      }),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderOrderPaidConfirmation(
  input: OrderPaidConfirmationEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Paid-order receipt; CTA to the account, intro varies by mode (one-time vs cycle).
  const locale = input.locale ?? "pl";
  const content = orderPaidEmailContent(
    locale,
    {
      firstName: input.firstName,
      petName: input.petName ?? null,
      orderId: input.orderId,
      mode: input.mode,
      items: input.items,
      totals: input.totals,
      ctaUrl: emailRouteUrl(baseUrl, "customerDashboard", locale, { sekcja: "orders" }),
      termsUrl: emailRouteUrl(baseUrl, "terms", locale),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderPaymentFailed(
  input: PaymentFailedEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Recoverable decline notice; always links to the same order context under
  // /konto so subscription customers never land in a fresh cart.
  const locale = input.locale ?? "pl";
  const recoveryDestination = resolveRecoverableCheckoutDestination(input.mode);
  const content = paymentFailedEmailContent(
    locale,
    {
      firstName: input.firstName,
      orderId: input.orderId,
      amountLabel: input.amountLabel,
      mode: input.mode === "subscription_cycle" ? "subscription_cycle" : "one_time",
      recoveryUrl: emailRouteUrlForRecoveryDestination(baseUrl, recoveryDestination, locale, {
        token: input.recoveryToken,
      }),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

function resolveRecoverableCheckoutDestination(mode: string) {
  return resolveRecoveryDestination({
    state: "recoverable",
    source: "checkout_recovery",
    orderMode: mode === "subscription_cycle" ? "subscription_cycle" : "one_time_order",
    hasOrderSubscription: mode === "subscription_cycle",
  });
}

export function renderCheckoutExpired(
  input: CheckoutExpiredEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  const locale = input.locale ?? "pl";
  const recoveryToken = typeof input.recoveryToken === "string"
    ? input.recoveryToken.trim()
    : "";
  const hasRecoveryToken = recoveryToken.length > 0;
  const content = checkoutExpiredEmailContent(
    locale,
    {
      firstName: input.firstName,
      orderId: input.orderId,
      amountLabel: input.amountLabel,
      ctaKind: hasRecoveryToken ? "recovery" : "compose",
      ctaUrl: hasRecoveryToken
        ? emailRouteUrl(baseUrl, "checkoutRecovery", locale, { token: recoveryToken })
        : emailRouteUrl(baseUrl, "configurator", locale),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderOrderCanceled(
  input: OrderCanceledEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Cancellation notice; CTA back to the shop (configurator) to re-order.
  const locale = input.locale ?? "pl";
  const content = orderCanceledEmailContent(
    locale,
    {
      firstName: input.firstName,
      orderId: input.orderId,
      amountLabel: input.amountLabel,
      ctaUrl: emailRouteUrl(baseUrl, "configurator", locale),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderOrderRefunded(
  input: OrderRefundedEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Refund confirmation; CTA back to the shop (configurator).
  const locale = input.locale ?? "pl";
  const content = orderRefundedEmailContent(
    locale,
    {
      firstName: input.firstName,
      brandName: emailCopyBrandName(presentation),
      orderId: input.orderId,
      amountLabel: input.amountLabel,
      ctaUrl: emailRouteUrl(baseUrl, "configurator", locale),
    },
    presentation.emailTeamSignoff[locale],
  );
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}
