import type {
  ShipmentDispatchedEmailInput,
  ShipmentDeliveredEmailInput,
  ShipmentExceptionEmailInput,
  ReturnDecisionEmailInput,
} from "../../domains/commerce/outboxOrderDraftEmailPorts.js";
import { shipmentDispatchedEmailContent } from "../../../src/domains/commerce/emails/shipmentDispatched.js";
import { shipmentDeliveredEmailContent } from "../../../src/domains/commerce/emails/shipmentDelivered.js";
import { shipmentExceptionEmailContent } from "../../../src/domains/commerce/emails/shipmentException.js";
import {
  returnApprovedEmailContent,
  returnRejectedEmailContent,
} from "../../../src/domains/commerce/emails/returnEmails.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import { emailPresentation as defaultEmailPresentation } from "../../../src/domains/communications/email/exampleEmailPresentation.js";
import type { EmailPresentation } from "../../../src/domains/communications/email/presentation.js";
import { emailRouteUrl } from "../../../src/domains/communications/email/links.js";
import type { RenderedEmail } from "./transactionalEmailRenderers.js";

export function renderShipmentDispatched(
  input: ShipmentDispatchedEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Dispatched notice; carrier tracking is primary, the account guide is the button.
  const locale = input.locale ?? "pl";
  const content = shipmentDispatchedEmailContent(
    locale,
    {
      firstName: input.firstName,
      petName: input.petName ?? null,
      orderId: input.orderId,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl,
      siteOrigin: baseUrl,
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

export function renderShipmentException(
  input: ShipmentExceptionEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Reassurance-only exception notice; CTA to the customer's order/account page.
  const locale = input.locale ?? "pl";
  const content = shipmentExceptionEmailContent(
    locale,
    {
      firstName: input.firstName,
      orderId: input.orderId,
      ctaUrl: emailRouteUrl(baseUrl, "customerDashboard", locale),
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

export function renderShipmentDelivered(
  input: ShipmentDeliveredEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Delivered notice; the getting-started guide is the one CTA.
  const locale = input.locale ?? "pl";
  const content = shipmentDeliveredEmailContent(locale, {
    firstName: input.firstName,
    petName: input.petName ?? null,
    orderId: input.orderId,
    siteOrigin: baseUrl,
  }, presentation.emailTeamSignoff[locale]);
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderReturnApproved(
  input: ReturnDecisionEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Return approved; CTA to the public step-by-step returns guide.
  const locale = input.locale ?? "pl";
  const content = returnApprovedEmailContent(locale, {
    firstName: input.firstName,
    orderId: input.orderId,
    ctaUrl: emailRouteUrl(baseUrl, "returnsGuide", locale),
  }, presentation.emailTeamSignoff[locale]);
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}

export function renderReturnRejected(
  input: ReturnDecisionEmailInput,
  baseUrl: string,
  presentation: EmailPresentation = defaultEmailPresentation,
): RenderedEmail {
  // Return rejected; CTA to the customer account orders view.
  const locale = input.locale ?? "pl";
  const content = returnRejectedEmailContent(locale, {
    firstName: input.firstName,
    orderId: input.orderId,
    ctaUrl: emailRouteUrl(baseUrl, "customerDashboard", locale),
  }, presentation.emailTeamSignoff[locale]);
  return renderEmail({
    brand: presentation.emailBrandForOrigin(baseUrl),
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}
