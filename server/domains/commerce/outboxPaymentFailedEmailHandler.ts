import { z } from "zod";
import { COMMERCE_PAYMENT_FAILED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerExecutionContext,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG,
  type OrderPaymentLifecyclePort,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { formatMoney } from "./orderEmailLines.js";
import { shouldSkipPaymentFailedNotice } from "./orderEmailEligibility.js";

export { OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

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

export function createOutboxPaymentFailedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}): OutboxHandler {
  return {
    eventType: COMMERCE_PAYMENT_FAILED_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(
      row: OutboxEventRow,
      signal: AbortSignal,
      execution?: OutboxHandlerExecutionContext,
    ): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
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
          ? formatMoney(payload.totalCents, payload.currency)
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
        locale: resolveLocale(recipient.country ?? null),
        signal,
      });
      return mapResendOutcome(outcome);
    },
  };
}
