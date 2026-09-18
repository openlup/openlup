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
  OutboxHandlerOutcome,
} from "../commerce/contracts.js";
import {
  decideChannelInvoice,
  type OrderInvoicePolicyReader,
} from "./channelInvoicePolicyGate.js";

const HANDLER_TIMEOUT_MS = 10_000;

// SQLSTATEs the issue-request RPCs raise for permanently non-retryable
// conditions. Retrying these can never succeed, so the event must be discarded
// (terminal) rather than retry-looped into a `failed` backlog that the staging
// outbox-preview gate treats as blocking (see outboxOrderPaidFulfillmentHandler,
// which likewise maps fatal -> discard).
//   - 22023 (invalid_parameter_value): every validation RAISE in
//     accounting_invoice_issue_request_from_handoff / _from_paid_order — invalid
//     input, missing fulfillment order (deleted), missing order/client/address,
//     payment-not-succeeded, package-not-shipped. The handed_over event commits
//     atomically with handed_over_at, so a missing row means it was deleted, not
//     a visibility race.
//   - 23514 (check_violation): the #1811 provider-immutability guard
//     (accounting_invoice_provider_mismatch). The provider is immutable, so a
//     replay against a different provider can never be persisted.
const PERMANENT_ISSUE_SQLSTATES = new Set(["22023", "23514"]);

// The subset of permanent (22023) RAISE identifiers that mean the aggregate or
// its graph was legitimately deleted before this async event dispatched — an
// orphan from smoke/order cleanup or a real order deletion. Discarding these is
// the expected, correct outcome, so they are classified `benign` (logged at warn,
// not error). Every OTHER permanent condition — payment-not-succeeded,
// package-not-shipped, invalid-input, and the 23514 provider-immutability guard —
// is still discarded but kept at error level because it signals a genuine anomaly.
const BENIGN_ISSUE_RAISE_IDENTIFIERS = new Set([
  "accounting_invoice_handoff_not_found",
  "accounting_invoice_order_not_found",
  "accounting_invoice_client_not_found",
  "accounting_invoice_address_not_found",
]);

export function createFulfillmentHandoffInvoiceHandler(input: {
  accountingPort: AccountingInvoiceIssuePort;
  providerKind: string;
  issueTrigger: "handoff" | "paid";
  // Wave B6. Absent decides `issue`, so every composition that predates this
  // wave keeps today's behaviour. A read failure falls into the catch below and
  // becomes a retry, which is the right outcome for a transient policy read.
  invoicePolicyReader?: OrderInvoicePolicyReader;
}): OutboxHandler {
  return {
    eventType: COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(
      row: OutboxEventRow,
      signal: AbortSignal,
    ): Promise<OutboxHandlerOutcome> {
      const parsed = commerceFulfillmentHandedOverPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        return { kind: "discard", reason: "fulfillment_handoff_payload_invalid" };
      }
      if (signal.aborted) {
        return { kind: "retry", reason: "fulfillment_handoff_handler_aborted" };
      }
      try {
        const decision = await decideChannelInvoice(input.invoicePolicyReader, {
          by: "order",
          orderUuid: parsed.data.orderUuid,
        });
        if (!decision.issue) {
          // Processed, not discarded: the event settled correctly and the
          // decision is the outcome. `accountingInvoiceSkipped` lands in
          // outbox_events.metadata, so an operator can see WHY no document
          // exists without reading this file.
          return { kind: "processed", detail: decision.detail };
        }
        const result = input.issueTrigger === "paid"
          ? await input.accountingPort.requestInvoiceIssueFromPaidOrder({
              idempotencyKey: `${row.idempotency_key}:accounting-invoice-paid`,
              orderId: parsed.data.orderUuid,
              providerKind: input.providerKind,
            })
          : await input.accountingPort.requestInvoiceIssueFromFulfillmentHandoff({
              idempotencyKey: `${row.idempotency_key}:accounting-invoice`,
              fulfillmentOrderId: parsed.data.fulfillmentOrderId,
              providerKind: input.providerKind,
            });
        return {
          kind: "processed",
          detail: {
            accountingInvoiceId: result.invoice.id,
            accountingInvoiceStatus: result.invoice.status,
            accountingInvoiceReplayed: result.invoice.replayed,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const causeCode = error instanceof AccountingInvoicePersistenceError
          ? error.causeCode
          : undefined;
        const causeMessage = error instanceof AccountingInvoicePersistenceError
          ? error.causeMessage
          : undefined;
        // Surface the RPC's own RAISE identifier so a discard reads explicitly
        // (e.g. "…: accounting_invoice_handoff_not_found (22023)") instead of an
        // opaque SQLSTATE — this is what lets an orphan discard be told apart
        // from a real payment-not-succeeded failure in the logs.
        const detail = causeMessage && causeMessage !== message ? `${message}: ${causeMessage}` : message;
        const reason = (causeCode ? `${detail} (${causeCode})` : detail).slice(0, 300);
        if (causeCode !== undefined && PERMANENT_ISSUE_SQLSTATES.has(causeCode)) {
          const benign = causeMessage !== undefined
            && BENIGN_ISSUE_RAISE_IDENTIFIERS.has(causeMessage);
          return benign ? { kind: "discard", reason, benign: true } : { kind: "discard", reason };
        }
        return { kind: "retry", reason };
      }
    },
  };
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
