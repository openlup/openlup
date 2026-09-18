import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_ORDER_PAID_TEMPLATE_SLUG,
  type OrderEmailTotals,
  type OrderPaidLinesPort,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { buildItems, formatMoney, type RawLine } from "./orderEmailLines.js";
import type { FirstSubscriptionPricePresentation } from "../../../src/domains/commerce/firstSubscriptionPricePresentation.js";

export { OUTBOX_ORDER_PAID_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

// Frozen minimal parse (mirror the order-draft handler): validate ONLY what this
// handler consumes; a producer schema change must never retro-DLQ in-flight rows.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    mode: z.string().min(1).optional(),
  })
  .passthrough();

function totalsFrom(data: {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}): OrderEmailTotals {
  return {
    subtotalLabel: formatMoney(data.subtotalMinor, data.currency),
    discountLabel:
      data.discountMinor > 0 ? `−${formatMoney(data.discountMinor, data.currency)}` : null,
    totalLabel: formatMoney(data.totalMinor, data.currency),
  };
}

function totalsFromFirstSubscription(data: {
  currency: string;
  firstSubscriptionPricePresentation: FirstSubscriptionPricePresentation;
}): OrderEmailTotals {
  const presentation = data.firstSubscriptionPricePresentation;
  return {
    subtotalLabel: formatMoney(presentation.catalogProductsMinor, data.currency),
    discountLabel: `−${formatMoney(presentation.productDiscountMinor, data.currency)}`,
    totalLabel: formatMoney(presentation.totalMinor, data.currency),
    firstSubscription: {
      catalogLabel: formatMoney(presentation.catalogProductsMinor, data.currency),
      productPayableLabel: formatMoney(presentation.productPayableMinor, data.currency),
      shippingLabel: presentation.shippingEffectiveMinor > 0
        ? formatMoney(presentation.shippingEffectiveMinor, data.currency)
        : null,
      shippingFree: presentation.shippingGrossMinor > 0
        && presentation.shippingEffectiveMinor === 0,
    },
  };
}

export function createOutboxOrderPaidEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  linesPort: OrderPaidLinesPort;
}): OutboxHandler {
  return {
    eventType: COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
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
      const firstSubscriptionPricePresentation = data.firstSubscriptionPricePresentation ?? null;
      const rawLines: RawLine[] = (data.lines ?? []).map((line) => ({
        label: line.label,
        quantity: line.quantity,
        lineSubtotalMinor: firstSubscriptionPricePresentation ? null : line.lineTotalMinor,
        currency: data.currency,
      }));
      const locale = resolveLocale(recipient.country ?? null);

      const outcome = await deps.emailPort.sendOrderPaidConfirmation({
        to: recipient.email,
        firstName: recipient.firstName,
        petName: recipient.petName ?? null,
        orderId: parsed.data.orderId,
        mode: parsed.data.mode ?? "one_time",
        outboxEventId: row.id,
        items: buildItems(rawLines, locale),
        totals: firstSubscriptionPricePresentation
          ? totalsFromFirstSubscription({ ...data, firstSubscriptionPricePresentation })
          : totalsFrom(data),
        locale,
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}
