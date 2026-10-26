import type { CommerceEmailRuntime } from "./emailRuntime.js";
import { z } from "zod";
import { COMMERCE_ORDER_REFUNDED_EVENT_TYPE } from "../outboxEventSchemas.js";
import type { OutboxHandler } from "../outboxDispatchContracts.js";
import {
  OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "../outboxOrderDraftEmailPorts.js";

export { OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

export const outboxOrderRefundedEmailDescriptor = Object.freeze({
  eventType: COMMERCE_ORDER_REFUNDED_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS,
});

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    refundCents: z.number().int().nonnegative().optional(),
    refundEvidenceVersion: z.string().optional(),
    currency: z.string().trim().min(1).optional(),
  })
  .passthrough();

export function createOutboxOrderRefundedEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "createTransactionalEmailHandler" | "formatMoney" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return deps.runtime.createTransactionalEmailHandler({
    ...outboxOrderRefundedEmailDescriptor,
    templateSlug: OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG,
    schema: payloadSubsetSchema,
    resolveKey: (payload) => payload.orderUuid,
    recipientPort: deps.recipientPort,
    findExistingSend: (slug, id) => deps.emailPort.findExistingSend(slug, id),
    send: ({ payload, recipient, row, signal }) => {
      const amountCents = payload.refundEvidenceVersion === "provider-refund.v2" ? payload.refundCents : undefined;
      const amountLabel =
        amountCents !== undefined && payload.currency !== undefined
          ? deps.runtime.formatMoney(amountCents, payload.currency)
          : null;
      return deps.emailPort.sendOrderRefundedNotice({
        to: recipient.email,
        firstName: recipient.firstName,
        orderId: payload.orderId,
        amountLabel,
        outboxEventId: row.id,
        locale: deps.runtime.resolveLocale(recipient.country ?? null),
        signal,
      });
    },
  });
}
