// Abandoned-cart reminder handler (marketing). Distinct from the transactional
// order-draft handler: this is consent-gated, carries the RODO unsubscribe
// footer, and sends through the generic marketing Resend port. ONE factory
// builds a handler for either reminder event (24h / 72h) — the eventType +
// templateSlug are injected so the registry can wire both with the same code.
//
// handle() flow: parse the minimal payload -> resolve recipient (skip when the
// draft has no client) -> evaluate marketing consent (skip when blocked) ->
// dedupe on the email_sends ledger -> build the signed unsubscribe URL -> render
// the branded email -> send -> map the provider outcome to a worker outcome.

import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import {
  APP_EMAIL_BRAND,
  APP_EMAIL_TEAM_SIGNOFF,
  appEmailBrandForOrigin,
} from "../../../src/lib/brand/appBrand.js";
import { emailRouteUrl } from "../../../src/domains/communications/email/links.js";
import { abandonedCartEmailContent } from "../../../src/domains/commerce/emails/abandonedCart.js";
import type {
  ConsentEvaluatorPort,
  MarketingEmailPort,
  OrderConversionStatusPort,
  UnsubscribeUrlBuilder,
} from "./marketingEmailPorts.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import type { OrderRecipientPort } from "./outboxOrderDraftEmailPorts.js";

const HANDLER_TIMEOUT_MS = 10_000;
const MARKETING_PURPOSE = "marketing_newsletter";

// Frozen minimal parse: validate ONLY what this handler consumes. orderUuid is
// load-bearing (recipient lookup); reminderHours degrades to 24 if absent so a
// producer tweak never retro-DLQs an in-flight reminder.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    reminderHours: z.union([z.literal(1), z.literal(24), z.literal(72)]).optional(),
  })
  .passthrough();

export function abandonedCartTemplateSlug(reminderHours: 1 | 24 | 72): string {
  if (reminderHours === 72) return "commerce-abandoned-cart-72h";
  if (reminderHours === 1) return "commerce-abandoned-cart-1h";
  return "commerce-abandoned-cart-24h";
}

export function createOutboxAbandonedCartEmailHandler(deps: {
  recipientPort: OrderRecipientPort;
  /** Send-time recheck: skip if the draft converted (paid) since enqueue. */
  conversionPort: OrderConversionStatusPort;
  consentEvaluator: ConsentEvaluatorPort;
  marketingEmailPort: MarketingEmailPort;
  /** Public site origin for the configurator CTA. */
  baseUrl: string;
  /**
   * Builds the absolute, signed unsubscribe URL for the RODO footer. Injected by
   * the composition root so the handler never touches the HMAC secret or the
   * functions-base origin (keeps it free of api/infra + communications imports).
   */
  buildUnsubscribeUrl: UnsubscribeUrlBuilder;
  /** Which reminder event this handler claims (1h, 24h or 72h). */
  eventType: string;
  /** Tone discriminator; also picks the dedupe template slug. */
  reminderHours: 1 | 24 | 72;
}): OutboxHandler {
  const templateSlug = abandonedCartTemplateSlug(deps.reminderHours);

  return {
    eventType: deps.eventType,
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
        // Anonymous draft (no client attached) — nothing to send, never retry,
        // but also not a delivery/DLQ failure for preview schedule drains.
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      // The enqueue scan filtered on draft + no-payment, but the customer can pay
      // (possibly via a different draft) during the 24h/72h window. Re-ask at send
      // time so a converted customer never gets a "you left items" nudge.
      const converted = await deps.conversionPort.isConverted(parsed.data.orderUuid, signal);
      if (converted) {
        return { kind: "processed", detail: { skipped: "converted" } };
      }

      const locale = resolveLocale(recipient.country ?? null);

      const consent = await deps.consentEvaluator.evaluate({
        email: recipient.email,
        purpose: MARKETING_PURPOSE,
        recipientKind: "customer",
        sourceTable: "clients",
      });
      if (!consent.allowed) {
        // Consent withheld/suppressed: ack the event, never send. Recorded so the
        // observability surface can tell "blocked" from "delivered".
        return { kind: "processed", detail: { skipped: "consent", reason: consent.reason } };
      }

      const alreadySent = await deps.marketingEmailPort.findExistingSend(templateSlug, row.id);
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const unsubscribeUrl = await deps.buildUnsubscribeUrl({
        email: recipient.email,
        purpose: MARKETING_PURPOSE,
        locale,
      });

      const content = abandonedCartEmailContent(locale, {
        firstName: recipient.firstName,
        brandName: APP_EMAIL_BRAND.copyBrandNameCased ?? APP_EMAIL_BRAND.copyBrandName,
        reminderHours: deps.reminderHours,
        ctaUrl: emailRouteUrl(deps.baseUrl, "configurator", locale),
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
        templateSlug,
        outboxEventId: row.id,
        decisionId: consent.decisionId,
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}
