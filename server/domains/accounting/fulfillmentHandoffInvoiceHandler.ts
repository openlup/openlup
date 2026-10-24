import { createFulfillmentHandoffInvoiceHandler as createHandler } from "@openlup/platform/invoicing";
import {
  AccountingInvoicePersistenceError,
  type AccountingInvoiceIssuePort,
  type AccountingPaidOrderInvoiceIssuePort,
} from "../../../src/domains/accounting/ports.js";
import {
  COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE,
  commerceFulfillmentHandedOverPayloadSchema,
} from "../../../src/lib/fulfillmentHandoffOutboxContract.js";
import type {
  OutboxEventRow,
  OutboxHandler,
} from "../commerce/contracts.js";
import {
  decideChannelInvoice,
  type OrderInvoicePolicyReader,
} from "./channelInvoicePolicyGate.js";

const HANDLER_TIMEOUT_MS = 10_000;

export function createFulfillmentHandoffInvoiceHandler(input: {
  accountingPort: AccountingInvoiceIssuePort;
  providerKind: string;
  issueTrigger: "handoff" | "paid";
  // Wave B6. Absent decides `issue`, so every composition that predates this
  // wave keeps today's behaviour. A read failure falls into the catch below and
  // becomes a retry, which is the right outcome for a transient policy read.
  invoicePolicyReader?: OrderInvoicePolicyReader;
}): OutboxHandler {
  return createHandler<OutboxEventRow, { orderUuid: string; fulfillmentOrderId: string }>({
    descriptor: { eventType: COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE, timeoutMs: HANDLER_TIMEOUT_MS },
    parsePayload: (value) => commerceFulfillmentHandedOverPayloadSchema.safeParse(value),
    decide: (payload) => decideChannelInvoice(input.invoicePolicyReader, { by: "order", orderUuid: payload.orderUuid }),
    request: async (row, payload) => {
      const result = input.issueTrigger === "paid"
        ? await input.accountingPort.requestInvoiceIssueFromPaidOrder({
          idempotencyKey: `${row.idempotency_key}:accounting-invoice-paid`, orderId: payload.orderUuid, providerKind: input.providerKind,
        })
        : await input.accountingPort.requestInvoiceIssueFromFulfillmentHandoff({
          idempotencyKey: `${row.idempotency_key}:accounting-invoice`, fulfillmentOrderId: payload.fulfillmentOrderId, providerKind: input.providerKind,
        });
      return { accountingInvoiceId: result.invoice.id, accountingInvoiceStatus: result.invoice.status, accountingInvoiceReplayed: result.invoice.replayed };
    },
    errorDetails: (error) => ({
      message: error instanceof Error ? error.message : String(error),
      causeCode: error instanceof AccountingInvoicePersistenceError ? error.causeCode : undefined,
      causeMessage: error instanceof AccountingInvoicePersistenceError ? error.causeMessage : undefined,
    }),
  });
}

/**
 * The direct paid-order handler performs the accounting request before it ACKs
 * the parent event. Its handoff notification is therefore a durable receipt,
 * not a second side-effect command. Validate and drain it explicitly.
 */
export function createFulfillmentHandoffReceiptHandler(input: {
  accountingPort: AccountingPaidOrderInvoiceIssuePort;
  providerKind: string;
  invoicePolicyReader?: OrderInvoicePolicyReader;
}): OutboxHandler {
  return {
    eventType: COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row, signal) {
      if (!commerceFulfillmentHandedOverPayloadSchema.safeParse(row.payload).success) {
        return { kind: "discard", reason: "fulfillment_handoff_payload_invalid" };
      }
      if (signal.aborted) return { kind: "retry", reason: "fulfillment_handoff_handler_aborted" };
      const parsed = commerceFulfillmentHandedOverPayloadSchema.parse(row.payload);
      try {
        const decision = await decideChannelInvoice(input.invoicePolicyReader, {
          by: "order",
          orderUuid: parsed.orderUuid,
        });
        if (!decision.issue) return { kind: "processed", detail: decision.detail };
        const result = await input.accountingPort.requestInvoiceIssueFromPaidOrder({
          idempotencyKey: `${row.idempotency_key}:accounting-invoice-paid`,
          orderId: parsed.orderUuid,
          providerKind: input.providerKind,
        });
        return { kind: "processed", detail: {
          accountingInvoiceId: result.invoice.id,
          accountingInvoiceStatus: result.invoice.status,
          accountingInvoiceReplayed: result.invoice.replayed,
        } };
      } catch (error) {
        return { kind: "retry", reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
      }
    },
  };
}
