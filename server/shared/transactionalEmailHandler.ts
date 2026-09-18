import type { ZodType } from "zod";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "../domains/commerce/outboxDispatchContracts.js";
import { mapResendOutcome, truncateReason, type ResendDispatchOutcome } from "./mapResendOutcome.js";

// Shared scaffold for the transactional outbox email handlers whose control flow
// is identical: parse a frozen payload subset → resolve the recipient (skip-as-
// processed when unresolved) → dedupe by template slug + outbox id → send → map
// the send outcome. Per-handler variation (payload schema, which id resolves the
// recipient, the template slug, and any pre-send derivation + the actual send
// call) is injected via `spec`.
//
// NOT for handlers that deviate from this flow — e.g. dedupe-first ordering
// (order-paid), retry-on-unresolved-recipient (review-*), consent gates, or
// post-send effects (back-in-stock notification marking). Those keep their
// hand-written body and share only mapResendOutcome.
export interface TransactionalEmailHandlerSpec<TPayload, TRecipient> {
  eventType: string;
  timeoutMs: number;
  templateSlug: string;
  schema: ZodType<TPayload>;
  // Which parsed-payload field resolves the recipient (e.g. orderUuid, clientId).
  resolveKey: (payload: TPayload) => string;
  recipientPort: { resolve(key: string, signal: AbortSignal): Promise<TRecipient | null> };
  findExistingSend: (templateSlug: string, outboxEventId: string) => Promise<boolean>;
  // Derive any extra inputs and perform the provider send. Runs only after the
  // recipient is resolved and the dedupe check passes.
  send: (ctx: {
    row: OutboxEventRow;
    payload: TPayload;
    recipient: TRecipient;
    signal: AbortSignal;
  }) => Promise<ResendDispatchOutcome>;
}

export function createTransactionalEmailHandler<TPayload, TRecipient>(
  spec: TransactionalEmailHandlerSpec<TPayload, TRecipient>,
): OutboxHandler {
  return {
    eventType: spec.eventType,
    timeoutMs: spec.timeoutMs,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = spec.schema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      const recipient = await spec.recipientPort.resolve(spec.resolveKey(parsed.data), signal);
      if (recipient === null) {
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await spec.findExistingSend(spec.templateSlug, row.id);
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const outcome = await spec.send({ row, payload: parsed.data, recipient, signal });
      return mapResendOutcome(outcome);
    },
  };
}
