import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";
import {
  OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG,
  type OrderEmailTotals,
  type OrderPaymentLifecyclePort,
  type OrderRecipientPort,
  type TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { buildItems, formatMoney, type RawLine } from "./orderEmailLines.js";
import { shouldSkipOrderDraftConfirmation } from "./orderEmailEligibility.js";

export { OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG };

const HANDLER_TIMEOUT_MS = 10_000;

// Frozen minimal parse (challenge R-m5): validate ONLY the fields this handler
// consumes, with schemas owned HERE — never the live quote/order-draft zod
// schemas. A producer-side schema deploy must not retro-DLQ in-flight events.
// Everything except orderUuid/orderId is optional-tolerant: malformed lines or
// totals degrade the email content, they never fail the event.
const payloadSubsetSchema = z
  .object({
    orderUuid: z.guid(),
    orderId: z.string().min(1),
    orderDraftSnapshot: z.unknown().optional(),
  })
  .passthrough();

const moneySubsetSchema = z
  .object({
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().trim().min(1),
  })
  .passthrough();

const lineSubsetSchema = z
  .object({
    quantity: z.number().int().positive(),
    productSlug: z.string().trim().min(1).optional(),
    sku: z.string().trim().min(1).optional(),
    lineSubtotalGross: moneySubsetSchema.optional(),
  })
  .passthrough();

const snapshotSubsetSchema = z
  .object({
    lines: z.array(z.unknown()).optional(),
    totals: z
      .object({
        subtotalGross: z.unknown().optional(),
        discountTotalGross: z.unknown().optional(),
        totalGross: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function extractLines(snapshot: unknown): RawLine[] {
  const parsed = snapshotSubsetSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.lines === undefined) return [];
  const lines: RawLine[] = [];
  for (const candidate of parsed.data.lines) {
    const line = lineSubsetSchema.safeParse(candidate);
    if (!line.success) continue;
    if (line.data.productSlug === undefined && line.data.sku === undefined) continue;
    lines.push({
      label: null,
      quantity: line.data.quantity,
      lineSubtotalMinor: line.data.lineSubtotalGross?.amountMinor ?? null,
      currency: line.data.lineSubtotalGross?.currency ?? null,
    });
  }
  return lines;
}

function buildTotals(snapshot: unknown): OrderEmailTotals | null {
  const parsed = snapshotSubsetSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.totals === undefined) return null;
  const total = moneySubsetSchema.safeParse(parsed.data.totals.totalGross);
  if (!total.success) return null;
  const subtotal = moneySubsetSchema.safeParse(parsed.data.totals.subtotalGross);
  const discount = moneySubsetSchema.safeParse(parsed.data.totals.discountTotalGross);
  const currency = total.data.currency;
  return {
    // Omit the subtotal row when it cannot be parsed — do NOT fall back to the
    // grand total, which would render "Subtotal = Total" alongside a separate
    // discount line that no longer reconciles.
    subtotalLabel: subtotal.success
      ? formatMoney(subtotal.data.amountMinor, subtotal.data.currency)
      : null,
    discountLabel:
      discount.success && discount.data.amountMinor > 0
        ? `-${formatMoney(discount.data.amountMinor, discount.data.currency)}`
        : null,
    totalLabel: formatMoney(total.data.amountMinor, currency),
  };
}

export function createOutboxOrderDraftEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}): OutboxHandler {
  return {
    eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
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
      const skipReason = shouldSkipOrderDraftConfirmation(lifecycle);
      if (skipReason) {
        return { kind: "processed", detail: { skipped: skipReason } };
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderUuid, signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const lines = extractLines(parsed.data.orderDraftSnapshot);
      const locale = resolveLocale(recipient.country ?? null);

      const outcome = await deps.emailPort.sendOrderConfirmation({
        to: recipient.email,
        firstName: recipient.firstName,
        petName: recipient.petName ?? null,
        orderId: parsed.data.orderId,
        outboxEventId: row.id,
        items: buildItems(lines, locale),
        totals: buildTotals(parsed.data.orderDraftSnapshot),
        locale,
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}
