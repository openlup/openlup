import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OutboxEventRow } from "../domains/commerce/outboxDispatchContracts.js";
import type { ResendDispatchOutcome } from "./mapResendOutcome.js";
import { createTransactionalEmailHandler } from "./transactionalEmailHandler.js";

const schema = z.object({ clientId: z.string().min(1) }).passthrough();
const OK: ResendDispatchOutcome = {
  ok: true,
  resendId: "re_1",
  httpStatus: 200,
  providerError: null,
  aborted: false,
};
const signal = new AbortController().signal;
const row = (payload: unknown): OutboxEventRow => ({ id: "evt-1", payload }) as OutboxEventRow;

type Recipient = { email: string; firstName: string | null; country: string | null };

function build(
  over: {
    resolve?: () => Promise<Recipient | null>;
    findExistingSend?: () => Promise<boolean>;
    send?: () => Promise<ResendDispatchOutcome>;
  } = {},
) {
  const send = vi.fn(over.send ?? (async () => OK));
  const resolve = vi.fn(
    over.resolve ?? (async (): Promise<Recipient | null> => ({ email: "a@b.pl", firstName: "Ada", country: "PL" })),
  );
  const findExistingSend = vi.fn(over.findExistingSend ?? (async () => false));
  const handler = createTransactionalEmailHandler({
    eventType: "test.event",
    timeoutMs: 10_000,
    templateSlug: "tmpl-1",
    schema,
    resolveKey: (p) => p.clientId,
    recipientPort: { resolve },
    findExistingSend,
    send,
  });
  return { handler, send, resolve, findExistingSend };
}

describe("createTransactionalEmailHandler", () => {
  it("exposes the eventType and timeoutMs", () => {
    const { handler } = build();
    expect(handler.eventType).toBe("test.event");
    expect(handler.timeoutMs).toBe(10_000);
  });

  it("discards on a contract parse failure with the field detail", async () => {
    const { handler, send } = build();
    const outcome = await handler.handle(row({ notClientId: 1 }), signal);
    expect(outcome.kind).toBe("discard");
    expect((outcome as { reason: string }).reason).toMatch(/^contract_parse_failed: clientId:/);
    expect(send).not.toHaveBeenCalled();
  });

  it("processes-skip when the recipient is unresolved, before dedupe/send", async () => {
    const { handler, send, findExistingSend } = build({ resolve: async () => null });
    expect(await handler.handle(row({ clientId: "c1" }), signal)).toEqual({
      kind: "processed",
      detail: { skipped: "recipient_unresolved" },
    });
    expect(findExistingSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("processes-dedupe when already sent, before send", async () => {
    const { handler, send } = build({ findExistingSend: async () => true });
    expect(await handler.handle(row({ clientId: "c1" }), signal)).toEqual({
      kind: "processed",
      detail: { dedupe: "email_already_sent" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves recipient by resolveKey, dedupes by slug+id, then sends and maps the outcome", async () => {
    const { handler, send, resolve, findExistingSend } = build();
    const outcome = await handler.handle(row({ clientId: "c1" }), signal);
    expect(resolve).toHaveBeenCalledWith("c1", signal);
    expect(findExistingSend).toHaveBeenCalledWith("tmpl-1", "evt-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_1" } });
  });

  it("maps a failed send via mapResendOutcome (e.g. 503 → snooze)", async () => {
    const { handler } = build({
      send: async () => ({
        ok: false,
        resendId: null,
        httpStatus: 503,
        providerError: "down",
        aborted: false,
      }),
    });
    expect(await handler.handle(row({ clientId: "c1" }), signal)).toEqual({
      kind: "snooze",
      reason: "down",
    });
  });
});
