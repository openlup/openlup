import { z } from "zod";
import { COMMERCE_ORDER_CANCELED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type { OutboxHandler } from "./outboxDispatchContracts.js";
import {
  OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { formatMoney } from "./orderEmailLines.js";
import { createTransactionalEmailHandler } from "../../shared/transactionalEmailHandler.js";

export { OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    totalCents: z.number().int().nonnegative().optional(),
    currency: z.string().trim().min(1).optional(),
  })
  .passthrough();

export function createOutboxOrderCanceledEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return createTransactionalEmailHandler({
    eventType: COMMERCE_ORDER_CANCELED_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    templateSlug: OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG,
    schema: payloadSubsetSchema,
    resolveKey: (payload) => payload.orderUuid,
    recipientPort: deps.recipientPort,
    findExistingSend: (slug, id) => deps.emailPort.findExistingSend(slug, id),
    send: ({ payload, recipient, row, signal }) => {
      const amountLabel =
        payload.totalCents !== undefined && payload.currency !== undefined
          ? formatMoney(payload.totalCents, payload.currency)
          : null;
      return deps.emailPort.sendOrderCanceledNotice({
        to: recipient.email,
        firstName: recipient.firstName,
        orderId: payload.orderId,
        amountLabel,
        outboxEventId: row.id,
        locale: resolveLocale(recipient.country ?? null),
        signal,
      });
    },
  });
}
