import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  ChannelIngestUnavailableError,
  createChannelWebhookHandler,
  emptyChannelWebhookPort,
  type ChannelWebhookPort,
} from "./channelWebhookHandler.js";
import { createNoopChannelConnectorAdapter } from "../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import type { ChannelIngestOutcome } from "./channelOrderIngestSaga.js";

// The handler against the REAL simulator connector rather than a stub of it. That is deliberate:
// the four branches this handler answers are the four the connector port promises to produce, so a
// test that invented its own normalizer would only prove the handler agrees with itself.

const connector = createNoopChannelConnectorAdapter().orders;

function response() {
  return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as VercelResponse;
}

function request(options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return {
    method: options.method ?? "POST",
    headers: options.headers ?? { "x-simulator-signature": "valid" },
    body: options.body ?? JSON.stringify({ fixture: "order-well-formed.json" }),
  } as unknown as VercelRequest;
}

function port(overrides: Partial<ChannelWebhookPort> = {}): ChannelWebhookPort {
  return {
    ingestOrder: vi.fn(async (): Promise<ChannelIngestOutcome> => ({
      kind: "settled",
      ledgerId: "led-1",
      orderId: "ord-1",
      paymentIntentId: "pi-1",
    })),
    quarantineSignal: vi.fn(async () => ({ quarantineId: "quar-1" })),
    ...overrides,
  };
}

function handler(overrides: Partial<Parameters<typeof createChannelWebhookHandler>[0]> = {}) {
  return createChannelWebhookHandler({
    connectorKind: "noop_channel",
    enabled: () => true,
    verifyToken: () => true,
    connector,
    port: port(),
    readRawBody: async (req) => String((req as { body?: unknown }).body ?? ""),
    ...overrides,
  });
}

function body(res: VercelResponse): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("channel webhook handler", () => {
  it("refuses a non-POST before the flag, the token or the body are consulted", async () => {
    const res = response();
    const normalizeWebhook = vi.fn();

    await handler({ connector: { normalizeWebhook } })(request({ method: "GET" }), res);

    expect(normalizeWebhook).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("answers unavailable while the flag is off, without normalizing", async () => {
    const res = response();
    const normalizeWebhook = vi.fn();

    await handler({ enabled: () => false, connector: { normalizeWebhook } })(request(), res);

    expect(normalizeWebhook).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body(res)).toMatchObject({ error: { details: { reason: "feature_flag_disabled" } } });
  });

  it("fails closed on a missing token: the empty port is what answers, and it cannot write", async () => {
    const res = response();
    const normalizeWebhook = vi.fn();

    await handler({
      verifyToken: () => false,
      port: emptyChannelWebhookPort(),
      connector: { normalizeWebhook },
    })(request({ headers: {} }), res);

    expect(normalizeWebhook).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(body(res)).toMatchObject({ error: { details: { reason: "token_rejected" } } });
  });

  it("proves the empty port refuses every durable call it carries", async () => {
    const empty = emptyChannelWebhookPort();
    await expect(empty.ingestOrder({} as never)).rejects.toThrow("channel_webhook_port_unavailable");
    await expect(empty.quarantineSignal({ providerEventId: "e", signal: {} as never })).rejects.toThrow(
      "channel_webhook_port_unavailable",
    );
  });

  it("rejects a bad signature without touching the port", async () => {
    const res = response();
    const injected = port();

    await handler({ port: injected })(request({ headers: { "x-simulator-signature": "nope" } }), res);

    expect(injected.ingestOrder).not.toHaveBeenCalled();
    expect(injected.quarantineSignal).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(body(res)).toMatchObject({ error: { details: { reason: "signature_rejected" } } });
  });

  it("answers bad-request on a malformed body", async () => {
    const res = response();

    await handler()(request({ body: "{not json" }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(body(res)).toMatchObject({ error: { details: { reason: "payload_malformed" } } });
  });

  it("quarantines an unknown vocabulary and acknowledges it, rather than throwing", async () => {
    const res = response();
    const injected = port();

    await handler({ port: injected })(
      request({ body: JSON.stringify({ fixture: "signal-unknown-vocabulary.json" }) }),
      res,
    );

    expect(injected.quarantineSignal).toHaveBeenCalledTimes(1);
    expect(injected.ingestOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res)).toMatchObject({
      ok: true,
      data: { status: "quarantined", reason: "unmapped_vocabulary", quarantineId: "quar-1" },
    });
  });

  it("acknowledges a delivery the connector does not model", async () => {
    const res = response();

    await handler()(request({ body: JSON.stringify({ fixture: "something-else" }) }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res)).toMatchObject({ data: { status: "ignored", reason: "not_an_order" } });
  });

  it("reports a settled order with the ids an operator needs", async () => {
    const res = response();

    await handler()(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res)).toMatchObject({
      data: { status: "settled", ledgerId: "led-1", orderId: "ord-1", paymentIntentId: "pi-1" },
    });
  });

  it("does NOT acknowledge an admission refusal", async () => {
    const res = response();

    await handler({
      port: port({
        ingestOrder: async () => ({ kind: "refused", refusal: "channel_not_found", detail: "no channel" }),
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toMatchObject({ error: { details: { reason: "channel_not_found" } } });
  });

  it("names an unaccepted currency in the same 409, rather than needing a path of its own", async () => {
    const res = response();

    await handler({
      port: port({
        ingestOrder: async () => ({
          kind: "refused",
          refusal: "currency_not_accepted",
          detail: "currency EUR is not settled here (channel EUR, order EUR)",
        }),
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toMatchObject({
      error: { details: { reason: "currency_not_accepted" } },
    });
  });

  it("answers unavailable — not 500 — when a rail this deployment needs is unbound", async () => {
    const res = response();

    await handler({
      port: port({
        ingestOrder: async () => {
          throw new ChannelIngestUnavailableError("channel_ingest_rails_unbound");
        },
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body(res)).toMatchObject({ error: { details: { reason: "channel_ingest_rails_unbound" } } });
  });

  it("lets a real fault escape rather than dressing it as a refusal", async () => {
    const res = response();

    await expect(
      handler({
        port: port({
          ingestOrder: async () => {
            throw new Error("database exploded");
          },
        }),
      })(request(), res),
    ).rejects.toThrow("database exploded");
  });

  it("answers bad-request when the raw body cannot be read", async () => {
    const res = response();

    await handler({
      readRawBody: async () => {
        throw new Error("stream too large");
      },
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(body(res)).toMatchObject({ error: { details: { reason: "body_unreadable" } } });
  });
});
