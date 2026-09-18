// Reorder-reminder handler (marketing). Sent ~30 days after a one-time order is
// delivered, to a customer who hasn't reordered or subscribed. Like the
// abandoned-cart handler it is consent-gated, carries the RODO unsubscribe
// footer, and sends through the generic marketing Resend port.
//
// handle() flow: parse the minimal payload -> resolve recipient (discard when the
// order has no client) -> evaluate marketing consent (skip when blocked) ->
// dedupe on the email_sends ledger -> build the signed unsubscribe URL -> render
// the branded email -> send -> map the provider outcome to a worker outcome.

import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { resolveLocale, type Locale } from "../../../src/lib/i18n/resolveLocale.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import type { EmailBrand } from "../../../src/lib/brand/brandConfig.js";
import { emailRouteUrl } from "../../../src/domains/communications/email/links.js";
import { reorderReminderEmailContent } from "../../../src/domains/commerce/emails/reorderReminder.js";
import { COMMERCE_ORDER_REORDER_REMINDER_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type {
  ConsentEvaluatorPort,
  MarketingEmailPort,
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

export const REORDER_REMINDER_TEMPLATE_SLUG = "commerce-reorder-reminder";

// Frozen minimal parse: validate ONLY what this handler consumes. orderUuid is
// load-bearing (recipient lookup); everything else is ignored so a producer
// tweak never retro-DLQs an in-flight reminder.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
  })
  .passthrough();

export function createOutboxReorderReminderEmailHandler(deps: {
  recipientPort: OrderRecipientPort;
  consentEvaluator: ConsentEvaluatorPort;
  marketingEmailPort: MarketingEmailPort;
  /** Public site origin for the configurator CTA. */
  baseUrl: string;
  emailConfig: {
    brand: EmailBrand;
    signoff: Record<Locale, string>;
    copyBrandName: string;
  };
  /**
   * Builds the absolute, signed unsubscribe URL for the RODO footer. Injected by
   * the composition root so the handler never touches the HMAC secret or the
   * functions-base origin (keeps it free of api/infra + communications imports).
   */
  buildUnsubscribeUrl: UnsubscribeUrlBuilder;
}): OutboxHandler {
  return {
    eventType: COMMERCE_ORDER_REORDER_REMINDER_EVENT_TYPE,
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
        // Order with no client attached — nothing to send, never retry.
        return { kind: "discard", reason: "recipient_unresolved" };
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

      const alreadySent = await deps.marketingEmailPort.findExistingSend(
        REORDER_REMINDER_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const unsubscribeUrl = await deps.buildUnsubscribeUrl({
        email: recipient.email,
        purpose: MARKETING_PURPOSE,
        locale,
      });

      const content = reorderReminderEmailContent(locale, {
        firstName: recipient.firstName,
        brandName: deps.emailConfig.copyBrandName,
        ctaUrl: emailRouteUrl(deps.baseUrl, "configurator", locale),
        unsubscribeUrl,
      }, deps.emailConfig.signoff[locale]);

      const rendered = renderEmail({
        brand: deps.emailConfig.brand,
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
        templateSlug: REORDER_REMINDER_TEMPLATE_SLUG,
        outboxEventId: row.id,
        decisionId: consent.decisionId,
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}
