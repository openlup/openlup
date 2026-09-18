import { z } from "zod";
import {
  ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
  type AccountingOrderReversalReason,
  type AccountingOrderReversalRequested,
  accountingOrderReversalRequestedPayloadSchema,
} from "../../src/domains/accounting/outboxReversalContracts.js";
import type { AccountingCorrectionScaffoldPort } from "../../src/domains/accounting/ports.js";
import {
  COMMERCE_ORDER_CANCELED_EVENT_TYPE,
  COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
} from "../../src/domains/commerce/outboxEventContracts.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "../../server/domains/commerce/contracts.js";
const HANDLER_TIMEOUT_MS = 10_000;
const legacyPayloadSchema = z.object({ orderUuid: z.guid(), orderId: z.string().min(1) }).passthrough();

export type LegacyCommerceOrderReversalEventType =
  | typeof COMMERCE_ORDER_CANCELED_EVENT_TYPE
  | typeof COMMERCE_ORDER_REFUNDED_EVENT_TYPE;

type LegacyCommerceOrderReversalRow = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type AccountingOrderReversalCompatibilityResult =
  | { kind: "ready"; request: AccountingOrderReversalRequested }
  | { kind: "invalid_payload" };

const REASON_BY_LEGACY_EVENT_TYPE: Record<
  LegacyCommerceOrderReversalEventType,
  AccountingOrderReversalReason
> = {
  [COMMERCE_ORDER_CANCELED_EVENT_TYPE]: "order_canceled",
  [COMMERCE_ORDER_REFUNDED_EVENT_TYPE]: "order_refunded",
};

/**
 * The sole Wave 2A compatibility/rollback seam. It converts an already-active
 * composite commerce row into the future accounting obligation without
 * registering, claiming, or producing a second outbox row.
 */
export function adaptLegacyCommerceOrderReversal(
  row: LegacyCommerceOrderReversalRow,
  sourceEventType: LegacyCommerceOrderReversalEventType,
): AccountingOrderReversalCompatibilityResult {
  const parsed = legacyPayloadSchema.safeParse(row.payload);
  if (!parsed.success) return { kind: "invalid_payload" };

  return {
    kind: "ready",
    request: {
      eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
      idempotencyKey: `${row.id}:accounting-reversal`,
      orderUuid: parsed.data.orderUuid,
      reason: REASON_BY_LEGACY_EVENT_TYPE[sourceEventType],
      payload: {
        outboxEventId: row.id,
        eventType: row.event_type,
        orderId: parsed.data.orderId,
      },
    },
  };
}

export function adaptAccountingOrderReversalRequested(
  row: LegacyCommerceOrderReversalRow,
): AccountingOrderReversalCompatibilityResult {
  const parsed = accountingOrderReversalRequestedPayloadSchema.safeParse(row.payload);
  if (!parsed.success) return { kind: "invalid_payload" };

  return {
    kind: "ready",
    request: {
      eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
      idempotencyKey: parsed.data.businessIdempotencyKey,
      orderUuid: parsed.data.orderUuid,
      reason: parsed.data.reason,
      payload: {
        outboxEventId: row.id,
        eventType: row.event_type,
        orderId: parsed.data.orderId,
        sourceEvent: parsed.data.sourceEvent,
      },
    },
  };
}

export function buildAccountingOrderReversalHandlers(input: {
  accountingPort: AccountingCorrectionScaffoldPort;
  providerKind: string;
  enabled: boolean;
}): OutboxHandler[] {
  if (!input.enabled) return [];
  return [
    createAccountingOrderReversalHandler({
      eventType: COMMERCE_ORDER_CANCELED_EVENT_TYPE,
      adapt: (row) => adaptLegacyCommerceOrderReversal(row, COMMERCE_ORDER_CANCELED_EVENT_TYPE),
      accountingPort: input.accountingPort,
      providerKind: input.providerKind,
    }),
    createAccountingOrderReversalHandler({
      eventType: COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
      adapt: (row) => adaptLegacyCommerceOrderReversal(row, COMMERCE_ORDER_REFUNDED_EVENT_TYPE),
      accountingPort: input.accountingPort,
      providerKind: input.providerKind,
    }),
    createAccountingOrderReversalHandler({
      eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
      adapt: adaptAccountingOrderReversalRequested,
      accountingPort: input.accountingPort,
      providerKind: input.providerKind,
    }),
  ];
}

function createAccountingOrderReversalHandler(input: {
  eventType: LegacyCommerceOrderReversalEventType | typeof ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE;
  adapt: (row: OutboxEventRow) => AccountingOrderReversalCompatibilityResult;
  accountingPort: AccountingCorrectionScaffoldPort;
  providerKind: string;
}): OutboxHandler {
  return {
    eventType: input.eventType,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow): Promise<OutboxHandlerOutcome> {
      const compatibility = input.adapt(row);
      if (compatibility.kind === "invalid_payload") {
        return { kind: "discard", reason: "accounting_reversal_payload_invalid" };
      }
      try {
        const result = await input.accountingPort.requestInvoiceReversalFromOrderStatus({
          idempotencyKey: compatibility.request.idempotencyKey,
          orderId: compatibility.request.orderUuid,
          reason: compatibility.request.reason,
          providerKind: input.providerKind,
          payload: compatibility.request.payload,
        });
        return {
          kind: "processed",
          detail: { accountingReversalAction: result.action, invoiceStatus: result.invoice?.status ?? "no_invoice" },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "retry", reason: message.slice(0, 300) };
      }
    },
  };
}
