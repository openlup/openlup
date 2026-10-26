import type { CommerceEmailRuntime } from "./emailRuntime.js";
import { z } from "zod";
import {
  COMMERCE_RETURN_APPROVED_EVENT_TYPE,
  COMMERCE_RETURN_REJECTED_EVENT_TYPE,
} from "../outboxEventSchemas.js";
import type { OutboxHandler } from "../outboxDispatchContracts.js";
import {
  OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG,
  OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type ReturnDecisionEmailInput,
  type TransactionalEmailPort,
  type TransactionalEmailSendOutcome,
} from "../outboxOrderDraftEmailPorts.js";

export { OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG, OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

export function describeOutboxReturnEmail(eventType: string) {
  return { eventType, timeoutMs: HANDLER_TIMEOUT_MS };
}

export const outboxReturnApprovedEmailDescriptor = Object.freeze(describeOutboxReturnEmail(COMMERCE_RETURN_APPROVED_EVENT_TYPE));
export const outboxReturnRejectedEmailDescriptor = Object.freeze(describeOutboxReturnEmail(COMMERCE_RETURN_REJECTED_EVENT_TYPE));

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
  })
  .passthrough();

// Both return-decision emails (approved / rejected) share the same payload, dedupe,
// recipient resolution, and snooze/retry/discard ladder as the order-refunded email;
// they differ only in event type, template slug, and which port method sends them.
function createReturnDecisionEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "createTransactionalEmailHandler" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
  eventType: string;
  templateSlug: string;
  send: (
    port: TransactionalEmailPort<Locale>,
    input: ReturnDecisionEmailInput<Locale>,
  ) => Promise<TransactionalEmailSendOutcome>;
}): OutboxHandler {
  return deps.runtime.createTransactionalEmailHandler({
    ...describeOutboxReturnEmail(deps.eventType),
    templateSlug: deps.templateSlug,
    schema: payloadSubsetSchema,
    resolveKey: (payload) => payload.orderUuid,
    recipientPort: deps.recipientPort,
    findExistingSend: (slug, id) => deps.emailPort.findExistingSend(slug, id),
    send: ({ payload, recipient, row, signal }) =>
      deps.send(deps.emailPort, {
        to: recipient.email,
        firstName: recipient.firstName,
        orderId: payload.orderId,
        outboxEventId: row.id,
        locale: deps.runtime.resolveLocale(recipient.country ?? null),
        signal,
      }),
  });
}

export function createOutboxReturnApprovedEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "createTransactionalEmailHandler" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return createReturnDecisionEmailHandler({
    ...deps,
    ...outboxReturnApprovedEmailDescriptor,
    templateSlug: OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG,
    send: (port, input) => port.sendReturnApprovedNotice(input),
  });
}

export function createOutboxReturnRejectedEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "createTransactionalEmailHandler" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
}): OutboxHandler {
  return createReturnDecisionEmailHandler({
    ...deps,
    ...outboxReturnRejectedEmailDescriptor,
    templateSlug: OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG,
    send: (port, input) => port.sendReturnRejectedNotice(input),
  });
}
