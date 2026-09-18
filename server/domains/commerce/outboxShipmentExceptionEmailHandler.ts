import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";

export { OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    customerNotification: z.literal("shipment_exception").optional(),
  })
  .passthrough();

export function createOutboxShipmentExceptionEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return {
    eventType: COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      if (parsed.data.customerNotification !== "shipment_exception") {
        return { kind: "processed", detail: { skipped: "internal_fulfillment_hold" } };
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const outcome = await deps.emailPort.sendShipmentExceptionNotice({
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
