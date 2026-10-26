import type { CommerceEmailRuntime } from "./emailRuntime.js";
import { z } from "zod";
import { COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE } from "../outboxEventSchemas.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "../outboxDispatchContracts.js";
import {
  OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "../outboxOrderDraftEmailPorts.js";

export { OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

export const outboxShipmentExceptionEmailDescriptor = Object.freeze({
  eventType: COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS,
});

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    customerNotification: z.literal("shipment_exception").optional(),
  })
  .passthrough();

export function createOutboxShipmentExceptionEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "mapSendOutcome" | "parseOutboxPayload" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return {
    ...outboxShipmentExceptionEmailDescriptor,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = deps.runtime.parseOutboxPayload(payloadSubsetSchema, row.payload);
      if (parsed.ok === false) {
        return parsed.outcome;
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
        locale: deps.runtime.resolveLocale(recipient.country ?? null),
        signal,
      });

      return deps.runtime.mapSendOutcome(outcome);
    },
  };
}
