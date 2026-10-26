import type { ZodType } from "zod";
import type { OutboxEventRow, OutboxHandler, OutboxHandlerOutcome } from "../outboxDispatchContracts.js";
import type { OrderEmailTotals, OrderPaidRawData, TransactionalEmailSendOutcome } from "../outboxOrderDraftEmailPorts.js";
import type { OrderEmailLinePresentation } from "../orderEmailLines.js";

export interface TransactionalEmailHandlerSpec<Payload, Recipient> {
  eventType: string;
  timeoutMs: number;
  templateSlug: string;
  schema: ZodType<Payload>;
  resolveKey(payload: Payload): string;
  recipientPort: { resolve(key: string, signal: AbortSignal): Promise<Recipient | null> };
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  send(ctx: { row: OutboxEventRow; payload: Payload; recipient: Recipient; signal: AbortSignal }): Promise<TransactionalEmailSendOutcome>;
}

/** Host bindings to the communications owner and presentation/provider policy. */
export interface CommerceEmailRuntime<Locale extends string = string> extends OrderEmailLinePresentation<Locale> {
  parseOutboxPayload<Payload>(schema: ZodType<Payload>, payload: unknown):
    { ok: true; data: Payload } | { ok: false; outcome: OutboxHandlerOutcome };
  mapSendOutcome(outcome: TransactionalEmailSendOutcome): OutboxHandlerOutcome;
  createTransactionalEmailHandler<Payload, Recipient>(spec: TransactionalEmailHandlerSpec<Payload, Recipient>): OutboxHandler;
  resolveLocale(country: string | null | undefined): Locale;
  /** null preserves ordinary totals and item prices; a presentation suppresses item prices. */
  presentPaidOrder(data: OrderPaidRawData): OrderEmailTotals | null;
  providerOwnsDeliveredNotification(providerKind: string): boolean;
  normalizeCarrierKind(input: { carrierKind: string | null; service: string | null }): string | null;
  carrierTrackingUrl(carrierKind: string | null, trackingNumber: string): string | null;
  legacyTrackingUrl(ref: { providerKind: string | null; carrierKind: string | null; trackingNumber: string }, hasExplicitReferences: boolean): string | null;
}
