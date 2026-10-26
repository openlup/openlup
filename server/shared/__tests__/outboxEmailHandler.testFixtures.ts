import { expect, it } from "vitest";
import type { OutboxEventRow, OutboxHandler } from "../../domains/commerce/outboxDispatchContracts.js";
import type { ResendDispatchOutcome } from "../mapResendOutcome.js";

type EmailFixture = { handler: OutboxHandler; sendCalls: readonly unknown[] };

/** Shared assertions only; each suite supplies its own handler factory and valid row. */
export function registerEmailProviderOutcomeCases(
  build: (options: { outcome: ResendDispatchOutcome }) => Pick<EmailFixture, "handler">,
  row: () => OutboxEventRow,
): void {
  it("snoozes on a 503 and discards on a 422", async () => {
    const snooze = build({
      outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "down", aborted: false },
    });
    expect(await snooze.handler.handle(row(), new AbortController().signal)).toEqual({ kind: "snooze", reason: "down" });

    const discard = build({
      outcome: { ok: false, resendId: null, httpStatus: 422, providerError: null, aborted: false },
    });
    expect(await discard.handler.handle(row(), new AbortController().signal)).toEqual({
      kind: "discard",
      reason: "resend_rejected",
    });
  });
}

export function registerEmailRecipientCases(
  build: (options: { recipient?: null; existing?: boolean }) => EmailFixture,
  row: () => OutboxEventRow,
): void {
  it("skips an unresolved recipient and dedupes an already-sent notice", async () => {
    const skip = build({ recipient: null });
    expect(await skip.handler.handle(row(), new AbortController().signal)).toEqual({
      kind: "processed",
      detail: { skipped: "recipient_unresolved" },
    });

    const dup = build({ existing: true });
    expect(await dup.handler.handle(row(), new AbortController().signal)).toEqual({
      kind: "processed",
      detail: { dedupe: "email_already_sent" },
    });
    expect(dup.sendCalls).toHaveLength(0);
  });
}
