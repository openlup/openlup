import type { CommerceEmailRuntime } from "./emailRuntime.js";
import { z } from "zod";
import { COMMERCE_PAYMENT_FAILED_EVENT_TYPE } from "../outboxEventSchemas.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerExecutionContext,
  OutboxHandlerOutcome,
} from "../outboxDispatchContracts.js";
import {
  OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG,
  type OrderPaymentLifecyclePort,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "../outboxOrderDraftEmailPorts.js";
import { shouldSkipPaymentFailedNotice } from "../orderEmailEligibility.js";

export { OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

export const outboxPaymentFailedEmailDescriptor = Object.freeze({
  eventType: COMMERCE_PAYMENT_FAILED_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS,
});

// Frozen minimal parse: only orderUuid/orderId are required; the amount fields
// degrade the copy (no amount line) but never fail the event.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    recoveryToken: z.string().trim().min(1),
    mode: z.string().optional(),
    totalCents: z.number().int().nonnegative().optional(),
    currency: z.string().trim().min(1).optional(),
  })
  .passthrough();

export function createOutboxPaymentFailedEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "formatMoney" | "mapSendOutcome" | "parseOutboxPayload" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}): OutboxHandler {
  return {
    ...outboxPaymentFailedEmailDescriptor,
    async handle(
      row: OutboxEventRow,
      signal: AbortSignal,
      execution?: OutboxHandlerExecutionContext,
    ): Promise<OutboxHandlerOutcome> {
      const parsed = deps.runtime.parseOutboxPayload(payloadSubsetSchema, row.payload);
      if (parsed.ok === false) {
        return parsed.outcome;
      }

      execution?.setPhase("lifecycle");
      const lifecycle = await deps.lifecyclePort.read(parsed.data.orderUuid, signal);
      const skipReason = shouldSkipPaymentFailedNotice(lifecycle);
      if (skipReason) {
        return { kind: "processed", detail: { skipped: skipReason } };
      }

      execution?.setPhase("recipient");
      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      execution?.setPhase("dedupe");
      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const payload = parsed.data;
      const amountLabel =
        payload.totalCents !== undefined && payload.currency !== undefined
          ? deps.runtime.formatMoney(payload.totalCents, payload.currency)
          : null;
      execution?.setPhase("email_send");
      const outcome = await deps.emailPort.sendPaymentFailedNotice({
        to: recipient.email,
        firstName: recipient.firstName,
        orderId: payload.orderId,
        amountLabel,
        recoveryToken: payload.recoveryToken,
        mode: payload.mode ?? "one_time",
        outboxEventId: row.id,
        locale: deps.runtime.resolveLocale(recipient.country ?? null),
        signal,
      });
      return deps.runtime.mapSendOutcome(outcome);
    },
  };
}
