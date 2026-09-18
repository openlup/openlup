import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import {
  COMMERCE_RETURN_APPROVED_EVENT_TYPE,
  COMMERCE_RETURN_REJECTED_EVENT_TYPE,
} from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG,
  OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type ReturnDecisionEmailInput,
  type TransactionalEmailPort,
  type TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";

export { OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG, OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
  })
  .passthrough();

// Both return-decision emails (approved / rejected) share the same payload, dedupe,
// recipient resolution, and snooze/retry/discard ladder as the order-refunded email;
// they differ only in event type, template slug, and which port method sends them.
function createReturnDecisionEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  eventType: string;
  templateSlug: string;
  send: (
    port: TransactionalEmailPort,
    input: ReturnDecisionEmailInput,
  ) => Promise<TransactionalEmailSendOutcome>;
}): OutboxHandler {
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
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await deps.emailPort.findExistingSend(deps.templateSlug, row.id);
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const outcome = await deps.send(deps.emailPort, {
        to: recipient.email,
        firstName: recipient.firstName,
        orderId: parsed.data.orderId,
        outboxEventId: row.id,
        locale: resolveLocale(recipient.country ?? null),
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}

export function createOutboxReturnApprovedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return createReturnDecisionEmailHandler({
    ...deps,
    eventType: COMMERCE_RETURN_APPROVED_EVENT_TYPE,
    templateSlug: OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG,
    send: (port, input) => port.sendReturnApprovedNotice(input),
  });
}

export function createOutboxReturnRejectedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return createReturnDecisionEmailHandler({
    ...deps,
    eventType: COMMERCE_RETURN_REJECTED_EVENT_TYPE,
    templateSlug: OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG,
    send: (port, input) => port.sendReturnRejectedNotice(input),
  });
}
