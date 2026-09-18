import { z } from "zod";
import { COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG,
  type OrderPaymentLifecyclePort,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { formatMoney } from "./orderEmailLines.js";
import { shouldSkipCheckoutExpired } from "./orderEmailEligibility.js";

export { OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    totalCents: z.number().int().nonnegative().optional(),
    currency: z.string().trim().min(1).optional(),
    recoveryToken: z.string().trim().min(1).optional(),
  })
  .passthrough();

export function createOutboxCheckoutExpiredEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}): OutboxHandler {
  return {
    eventType: COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      const lifecycle = await deps.lifecyclePort.read(parsed.data.orderUuid, signal);
      const skipReason = shouldSkipCheckoutExpired(lifecycle);
      if (skipReason) {
        return { kind: "processed", detail: { skipped: skipReason } };
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG,
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
      const outcome = await deps.emailPort.sendCheckoutExpiredNotice({
        to: recipient.email,
        firstName: recipient.firstName,
        orderId: payload.orderId,
        amountLabel,
        recoveryToken: payload.recoveryToken ?? null,
        outboxEventId: row.id,
        locale: resolveLocale(recipient.country ?? null),
        signal,
      });
      return mapResendOutcome(outcome);
    },
  };
}
