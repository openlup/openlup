// commerce.order.review_effects handler — the SECOND post-delivery review email
// ("how is your pet doing after at least two weeks?"), MARKETING. Mirrors the
// review-request handler exactly (render in-handler, consent gate, signed
// unsubscribe footer, recipient via the order, dedupe + outcome mapping) — only
// the event type, the content module, and the dedupe template slug differ. The
// review-form token comes from the payload (a distinct kind='effects' token), so
// it links to the same anon feedback page as a separate, second submission.

import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { COMMERCE_ORDER_REVIEW_EFFECTS_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import {
  reviewFormUrl,
} from "../../../src/domains/commerce/emails/reviewRequest.js";
import { reviewEffectsEmailContent } from "../../../src/domains/commerce/emails/reviewEffects.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import {
  APP_EMAIL_BRAND,
  APP_EMAIL_TEAM_SIGNOFF,
  appEmailBrandForOrigin,
} from "../../../src/lib/brand/appBrand.js";
import {
  type ConsentEvaluatorPort,
  type MarketingEmailPort,
  type UnsubscribeUrlBuilder,
} from "./marketingEmailPorts.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import type { OrderRecipientPort } from "./outboxOrderDraftEmailPorts.js";

export const OUTBOX_REVIEW_EFFECTS_TEMPLATE_SLUG = "commerce-order-review-effects";
export const REVIEW_EFFECTS_CONSENT_PURPOSE = "marketing_newsletter";

const HANDLER_TIMEOUT_MS = 10_000;

const payloadSubsetSchema = z
  .object({
    orderUuid: z.string().uuid(),
    orderId: z.string().min(1),
    token: z.string().min(1),
  })
  .passthrough();

export interface ReviewEffectsEmailHandlerDeps {
  marketingEmailPort: MarketingEmailPort;
  recipientPort: OrderRecipientPort;
  consentEvaluator: ConsentEvaluatorPort;
  /** Storefront base URL the review-form CTA links to. */
  baseUrl: string;
  /**
   * Builds the signed, absolute one-click unsubscribe URL for the footer. The
   * cron composes this from the communications unsubscribe-token helpers so the
   * handler stays free of cross-domain imports.
   */
  unsubscribeUrlBuilder: UnsubscribeUrlBuilder;
}

export function createOutboxReviewEffectsEmailHandler(
  deps: ReviewEffectsEmailHandlerDeps,
): OutboxHandler {
  return {
    eventType: COMMERCE_ORDER_REVIEW_EFFECTS_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        // The effect token is already minted on commerce_order_feedback, and a
        // delivered order almost always has a client — so a null is far more likely
        // a transient read (replication lag) than a genuinely client-less order.
        // Retry rather than ack: a transient null recovers next attempt; a true
        // anomaly DLQs (observable) instead of silently orphaning the minted token.
        return { kind: "retry", reason: "recipient_unresolved" };
      }

      const alreadySent = await deps.marketingEmailPort.findExistingSend(
        OUTBOX_REVIEW_EFFECTS_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      // Consent gate — block unless marketing consent is granted; the DB policy
      // is authoritative and the port fails OPEN only on a transient RPC outage.
      const consent = await deps.consentEvaluator.evaluate({
        email: recipient.email,
        purpose: REVIEW_EFFECTS_CONSENT_PURPOSE,
        recipientKind: "customer",
        sourceTable: "clients",
      });
      if (!consent.allowed) {
        return { kind: "processed", detail: { skipped: "consent_blocked", reason: consent.reason } };
      }

      const locale = resolveLocale(recipient.country ?? null);
      const reviewUrl = reviewFormUrl(deps.baseUrl, locale, parsed.data.token);
      const unsubscribeUrl = await deps.unsubscribeUrlBuilder({
        email: recipient.email,
        purpose: REVIEW_EFFECTS_CONSENT_PURPOSE,
        locale,
      });

      const content = reviewEffectsEmailContent(locale, {
        firstName: recipient.firstName,
        contextName: recipient.petName ?? null,
        brandName: APP_EMAIL_BRAND.copyBrandNameCased ?? APP_EMAIL_BRAND.copyBrandName,
        reviewUrl,
        unsubscribeUrl,
      }, APP_EMAIL_TEAM_SIGNOFF[locale]);
      const rendered = renderEmail({
        brand: appEmailBrandForOrigin(deps.baseUrl),
        locale,
        subject: content.subject,
        preheader: content.preheader,
        blocks: content.blocks,
      });

      const outcome = await deps.marketingEmailPort.send({
        to: recipient.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        templateSlug: OUTBOX_REVIEW_EFFECTS_TEMPLATE_SLUG,
        outboxEventId: row.id,
        decisionId: consent.decisionId,
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}
