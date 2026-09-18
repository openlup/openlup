import { describe, expect, it, vi } from "vitest";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderRecipientPort,
  ReturnDecisionEmailInput,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxReturnApprovedEmailHandler,
  createOutboxReturnRejectedEmailHandler,
} from "./outboxReturnEmailHandlers.js";

const ORDER_UUID = "11111111-1111-4111-8111-111111111111";

function row(overrides?: Partial<OutboxEventRow>): OutboxEventRow {
  return {
    id: "outbox-evt-1",
    event_type: "commerce.return.approved",
    payload: { orderUuid: ORDER_UUID, orderId: "order_x", returnRequestId: ORDER_UUID, status: "approved" },
    ...overrides,
  } as OutboxEventRow;
}

function recipientPort(resolved: { email: string; firstName: string | null; country?: string | null } | null): OrderRecipientPort {
  return { resolve: vi.fn(async () => resolved) } as unknown as OrderRecipientPort;
}

const okOutcome: TransactionalEmailSendOutcome = { ok: true, resendId: "re_1", httpStatus: 200, providerError: null, aborted: false };

function emailPort(opts: {
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
  send?: (input: ReturnDecisionEmailInput) => Promise<TransactionalEmailSendOutcome>;
}): { port: TransactionalEmailPort; approved: ReturnType<typeof vi.fn>; rejected: ReturnType<typeof vi.fn> } {
  const approved = vi.fn(opts.send ?? (async () => opts.outcome ?? okOutcome));
  const rejected = vi.fn(opts.send ?? (async () => opts.outcome ?? okOutcome));
  const port = {
    findExistingSend: vi.fn(async () => opts.existing ?? false),
    sendReturnApprovedNotice: approved,
    sendReturnRejectedNotice: rejected,
  } as unknown as TransactionalEmailPort;
  return { port, approved, rejected };
}

describe("outbox return email handlers", () => {
  it("approved: sends and returns processed", async () => {
    const { port, approved } = emailPort({});
    const handler = createOutboxReturnApprovedEmailHandler({
      emailPort: port,
      recipientPort: recipientPort({ email: "c@x.test", firstName: "Ala", country: "PL" }),
    });
    const out = await handler.handle(row(), new AbortController().signal);
    expect(out.kind).toBe("processed");
    expect(approved).toHaveBeenCalledTimes(1);
    expect(approved.mock.calls[0]![0]).toMatchObject({ to: "c@x.test", orderId: "order_x", outboxEventId: "outbox-evt-1" });
  });

  it("rejected: routes to the rejected notice", async () => {
    const { port, rejected } = emailPort({});
    const handler = createOutboxReturnRejectedEmailHandler({
      emailPort: port,
      recipientPort: recipientPort({ email: "c@x.test", firstName: null }),
    });
    const out = await handler.handle(row({ event_type: "commerce.return.rejected" }), new AbortController().signal);
    expect(out.kind).toBe("processed");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("dedupes when already sent", async () => {
    const { port, approved } = emailPort({ existing: true });
    const handler = createOutboxReturnApprovedEmailHandler({
      emailPort: port,
      recipientPort: recipientPort({ email: "c@x.test", firstName: "Ala" }),
    });
    const out = await handler.handle(row(), new AbortController().signal);
    expect(out).toMatchObject({ kind: "processed", detail: { dedupe: "email_already_sent" } });
    expect(approved).not.toHaveBeenCalled();
  });

  it("skips when recipient unresolved", async () => {
    const { port } = emailPort({});
    const handler = createOutboxReturnApprovedEmailHandler({ emailPort: port, recipientPort: recipientPort(null) });
    const out = await handler.handle(row(), new AbortController().signal);
    expect(out).toMatchObject({ kind: "processed", detail: { skipped: "recipient_unresolved" } });
  });

  it("discards on a 4xx and snoozes on a 5xx", async () => {
    const discard = emailPort({ outcome: { ok: false, resendId: null, httpStatus: 422, providerError: "bad", aborted: false } });
    const dh = createOutboxReturnApprovedEmailHandler({ emailPort: discard.port, recipientPort: recipientPort({ email: "c@x.test", firstName: "A" }) });
    expect((await dh.handle(row(), new AbortController().signal)).kind).toBe("discard");

    const snooze = emailPort({ outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "down", aborted: false } });
    const sh = createOutboxReturnApprovedEmailHandler({ emailPort: snooze.port, recipientPort: recipientPort({ email: "c@x.test", firstName: "A" }) });
    expect((await sh.handle(row(), new AbortController().signal)).kind).toBe("snooze");
  });

  it("discards on contract parse failure (bad payload)", async () => {
    const { port } = emailPort({});
    const handler = createOutboxReturnApprovedEmailHandler({ emailPort: port, recipientPort: recipientPort({ email: "c@x.test", firstName: "A" }) });
    const out = await handler.handle(row({ payload: { orderId: "order_x" } }), new AbortController().signal);
    expect(out.kind).toBe("discard");
  });
});
