import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { providerOwnsDeliveredNotification } from "../../../src/domains/fulfillment/contracts.js";

export { OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

// Provider-aware notification policy (W6, folded into the kernel capability map in W8):
// for providers whose carrier owns the delivery-progress notifications (incl. the
// "delivered" notice), WE do not send our own "delivered" email — it would duplicate the
// carrier's. We still own order-paid, invoice, exception, and the one branded "shipped"
// (dispatched) email. The policy is read from the fulfillment capability map via the
// shared `providerOwnsDeliveredNotification` helper (single source of truth).

// Reads the order's normalized delivery providerKind (shared resolver, W2). Runtime
// composition injects this for transactional email so provider-owned notices suppress ours.
export interface DeliveredEmailProviderKindReader {
  readSelectedProviderKind(orderUuid: string): Promise<string | null>;
}

const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
  })
  .passthrough();

export function createOutboxShipmentDeliveredEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  // When provided, suppress OUR delivered email for carrier-owned providers.
  providerKindReader?: DeliveredEmailProviderKindReader;
}): OutboxHandler {
  return {
    eventType: COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      // Provider-aware suppression: the carrier (via the 3PL) owns the delivered notice
      // for these providers, so sending ours would duplicate it. Recorded as processed
      // (not discarded) so the event settles and never retries.
      if (deps.providerKindReader) {
        const providerKind = await deps.providerKindReader.readSelectedProviderKind(parsed.data.orderUuid);
        if (providerKind && providerOwnsDeliveredNotification(providerKind)) {
          return { kind: "processed", detail: { skipped: `carrier_owns_delivered:${providerKind}` } };
        }
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const outcome = await deps.emailPort.sendShipmentDeliveredNotice({
        to: recipient.email,
        firstName: recipient.firstName,
        petName: recipient.petName ?? null,
        orderId: parsed.data.orderId,
        outboxEventId: row.id,
        locale: resolveLocale(recipient.country ?? null),
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}
