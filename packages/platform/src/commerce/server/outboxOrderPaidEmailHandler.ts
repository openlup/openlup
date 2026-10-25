import type { CommerceEmailRuntime } from "./emailRuntime.js";
import { z } from "zod";
import { COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE } from "../outboxEventSchemas.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "../outboxDispatchContracts.js";
import {
  OUTBOX_ORDER_PAID_TEMPLATE_SLUG,
  type OrderEmailTotals,
  type OrderPaidLinesPort,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "../outboxOrderDraftEmailPorts.js";
import { buildItems, type RawLine } from "../orderEmailLines.js";

export { OUTBOX_ORDER_PAID_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

export const outboxOrderPaidEmailDescriptor = Object.freeze({
  eventType: COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS,
});

/**
 * An adopter's note about the paid order's parcel, already localized, or null
 * for none. Best-effort and inside this handler's timeout: a failure is logged
 * and the receipt is sent without the note.
 */
export type OrderPaidParcelNoteReader<Locale extends string = string> = (
  orderUuid: string,
  locale: Locale,
  signal: AbortSignal,
) => Promise<string | null>;

// Frozen minimal parse (mirror the order-draft handler): validate ONLY what this
// handler consumes; a producer schema change must never retro-DLQ in-flight rows.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    mode: z.string().min(1).optional(),
  })
  .passthrough();

function totalsFrom<Locale extends string>(data: {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}, runtime: Pick<CommerceEmailRuntime<Locale>, "formatMoney" | "genericItemLabel" | "mapSendOutcome" | "parseOutboxPayload" | "presentPaidOrder" | "resolveLocale">): OrderEmailTotals {
  return {
    subtotalLabel: runtime.formatMoney(data.subtotalMinor, data.currency),
    discountLabel:
      data.discountMinor > 0 ? `−${runtime.formatMoney(data.discountMinor, data.currency)}` : null,
    totalLabel: runtime.formatMoney(data.totalMinor, data.currency),
  };
}

export function createOutboxOrderPaidEmailHandler<Locale extends string>(deps: {
  runtime: Pick<CommerceEmailRuntime<Locale>, "formatMoney" | "genericItemLabel" | "mapSendOutcome" | "parseOutboxPayload" | "presentPaidOrder" | "resolveLocale">;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
  linesPort: OrderPaidLinesPort;
  describeParcel?: OrderPaidParcelNoteReader<Locale>;
}): OutboxHandler {
  return {
    ...outboxOrderPaidEmailDescriptor,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = deps.runtime.parseOutboxPayload(payloadSubsetSchema, row.payload);
      if (parsed.ok === false) {
        return parsed.outcome;
      }

      // Dedupe FIRST (cheap, recipient-independent): an already-sent event must not
      // burn the recipient + lines reads (4 queries) on every reprocess/retry/preview
      // drain — those passes were pure waste on the dupe path.
      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_ORDER_PAID_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      // Items + totals from the DB. A genuine read error throws → worker retries.
      // A missing order row means the paid order is not yet readable (replication
      // lag): retry rather than send a contentless "receipt" with no items/totals.
      const data = await deps.linesPort.read(parsed.data.orderUuid, signal);
      if (data === null) {
        return { kind: "retry", reason: "order_paid_data_unavailable" };
      }
      const presentation = deps.runtime.presentPaidOrder(data);
      const rawLines: RawLine[] = (data.lines ?? []).map((line) => ({
        label: line.label,
        quantity: line.quantity,
        lineSubtotalMinor: presentation ? null : line.lineTotalMinor,
        currency: data.currency,
      }));
      const locale = deps.runtime.resolveLocale(recipient.country ?? null);
      const parcelNote = await readParcelNote(deps.describeParcel, parsed.data.orderUuid, locale, signal, row.id);

      const outcome = await deps.emailPort.sendOrderPaidConfirmation({
        to: recipient.email,
        firstName: recipient.firstName,
        contextName: recipient.contextName ?? null,
        orderId: parsed.data.orderId,
        mode: parsed.data.mode ?? "one_time",
        outboxEventId: row.id,
        items: buildItems(rawLines, locale, deps.runtime),
        totals: presentation ?? totalsFrom(data, deps.runtime),
        ...(parcelNote ? { parcelNote } : {}),
        locale,
        signal,
      });

      return deps.runtime.mapSendOutcome(outcome);
    },
  };
}

/**
 * Asks the composed reader, if any, for the receipt's parcel note. A missing
 * reader, an empty answer or a failure all mean no note: a failure is logged
 * with the event id only, and the receipt is sent without the note.
 */
async function readParcelNote<Locale extends string>(
  describeParcel: OrderPaidParcelNoteReader<Locale> | undefined,
  orderUuid: string,
  locale: Locale,
  signal: AbortSignal,
  eventId: string,
): Promise<string | null> {
  if (!describeParcel) return null;
  try {
    return (await describeParcel(orderUuid, locale, signal)) || null;
  } catch {
    console.warn("[outbox-dispatch] order_paid_parcel_note_unavailable", eventId);
    return null;
  }
}
