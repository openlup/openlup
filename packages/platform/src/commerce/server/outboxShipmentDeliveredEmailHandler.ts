import type { CommerceEmailRuntime } from "./emailRuntime.js";
import { z } from "zod";
import { COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE } from "../outboxEventSchemas.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "../outboxDispatchContracts.js";
import {
  OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "../outboxOrderDraftEmailPorts.js";

export { OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

export const outboxShipmentDeliveredEmailDescriptor = Object.freeze({
  eventType: COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS,
});

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

export function createOutboxShipmentDeliveredEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "mapSendOutcome" | "parseOutboxPayload" | "providerOwnsDeliveredNotification" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
  // When provided, suppress OUR delivered email for carrier-owned providers.
  providerKindReader?: DeliveredEmailProviderKindReader;
}): OutboxHandler {
  return {
    ...outboxShipmentDeliveredEmailDescriptor,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = deps.runtime.parseOutboxPayload(payloadSubsetSchema, row.payload);
      if (parsed.ok === false) {
        return parsed.outcome;
      }

      // Provider-aware suppression: the carrier (via the 3PL) owns the delivered notice
      // for these providers, so sending ours would duplicate it. Recorded as processed
      // (not discarded) so the event settles and never retries.
      if (deps.providerKindReader) {
        const providerKind = await deps.providerKindReader.readSelectedProviderKind(parsed.data.orderUuid);
        if (providerKind && deps.runtime.providerOwnsDeliveredNotification(providerKind)) {
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
        contextName: recipient.contextName ?? null,
        orderId: parsed.data.orderId,
        outboxEventId: row.id,
        locale: deps.runtime.resolveLocale(recipient.country ?? null),
        signal,
      });

      return deps.runtime.mapSendOutcome(outcome);
    },
  };
}
