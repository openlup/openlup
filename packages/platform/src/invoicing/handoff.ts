import type { ChannelInvoiceDecision } from "./channelPolicy.js";

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

/** Host retains event schema, key scopes, RPC error class and compatibility detail. */
export function createFulfillmentHandoffInvoiceHandler<Row extends { payload: unknown }, Payload>(input: {
  descriptor: { eventType: string; timeoutMs: number };
  parsePayload(value: unknown): { success: true; data: Payload } | { success: false };
  decide(payload: Payload): Promise<ChannelInvoiceDecision>;
  request(row: Row, payload: Payload): Promise<Record<string, unknown>>;
  errorDetails(error: unknown): { message: string; causeCode?: string; causeMessage?: string };
}) {
  return {
    ...input.descriptor,
    async handle(row: Row, signal: AbortSignal): Promise<
      { kind: "processed"; detail: Record<string, unknown> } |
      { kind: "discard"; reason: string; benign?: boolean } | { kind: "retry"; reason: string }
    > {
      const parsed = input.parsePayload(row.payload);
      if (!parsed.success) return { kind: "discard", reason: "fulfillment_handoff_payload_invalid" };
      if (signal.aborted) return { kind: "retry", reason: "fulfillment_handoff_handler_aborted" };
      try {
        const decision = await input.decide(parsed.data);
        if (!decision.issue) return { kind: "processed", detail: decision.detail };
        return { kind: "processed", detail: await input.request(row, parsed.data) };
      } catch (error) {
        const { message, causeCode, causeMessage } = input.errorDetails(error);
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
