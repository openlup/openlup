import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  channelIngestWebhookEnabled,
  createChannelWebhookRoute,
  verifyChannelWebhookToken,
} from "./_handler.js";

const { mockResolveBinding } = vi.hoisted(() => ({ mockResolveBinding: vi.fn() }));

vi.mock("../../../runtime/channelIngest/channelIngestStoreBinding.js", () => ({
  resolveChannelIngestStoreBinding: mockResolveBinding,
}));

const ENV_KEYS = [
  "CHANNEL_INGEST_WEBHOOK_ENABLED",
  "CHANNEL_WEBHOOK_TOKEN",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NODE_ENV",
  "VERCEL_ENV",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mockResolveBinding.mockReset();
});

function response() {
  return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as VercelResponse;
}

function request(headers: Record<string, string> = {}, method = "POST") {
  return {
    method,
    headers: { "x-simulator-signature": "valid", ...headers },
    body: JSON.stringify({ fixture: "signal-unknown-vocabulary.json" }),
  } as unknown as VercelRequest;
}

function enableRoute() {
  process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "true";
  process.env.CHANNEL_WEBHOOK_TOKEN = "expected-token";
  process.env.NODE_ENV = "test";
}

function body(res: VercelResponse): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("channel webhook route factory", () => {
  it("fails closed with the flag off, before the store binding is resolved", async () => {
    process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "false";
    const res = response();

    await createChannelWebhookRoute("noop_channel")(request({ authorization: "Bearer expected-token" }), res);

    expect(mockResolveBinding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("refuses a non-POST before the store binding is resolved", async () => {
    enableRoute();
    const res = response();

    await createChannelWebhookRoute("noop_channel")(request({}, "GET"), res);

    expect(mockResolveBinding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("answers unavailable — and never leaks the name as a value — with no token configured", async () => {
    process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "true";
    delete process.env.CHANNEL_WEBHOOK_TOKEN;
    const res = response();

    await createChannelWebhookRoute("noop_channel")(request(), res);

    expect(mockResolveBinding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body(res)).toMatchObject({ error: { details: { reason: "webhook_token_required" } } });
  });

  it("rejects a wrong token before the store binding is resolved", async () => {
    enableRoute();
    const res = response();

    await createChannelWebhookRoute("noop_channel")(request({ authorization: "Bearer wrong" }), res);

    expect(mockResolveBinding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("expected-token");
  });

  it("refuses the simulator connector where a simulated settlement must not be believed", async () => {
    enableRoute();
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    const res = response();

    await createChannelWebhookRoute("noop_channel")(request({ authorization: "Bearer expected-token" }), res);

    expect(mockResolveBinding).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body(res)).toMatchObject({ error: { details: { reason: "connector_unavailable" } } });
  });

  it("reports the binding's own refusal reason when the store cannot be resolved", async () => {
    enableRoute();
    mockResolveBinding.mockReturnValue({ error: "supabase_env_required" });
    const res = response();

    await createChannelWebhookRoute("noop_channel")(request({ authorization: "Bearer expected-token" }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body(res)).toMatchObject({ error: { details: { reason: "supabase_env_required" } } });
  });

  it("runs the delivery inside the binding once every guard is satisfied", async () => {
    enableRoute();
    const quarantine = vi.fn(async () => ({
      id: "quar-9",
      reason: "unmapped_vocabulary" as const,
      status: "open" as const,
      vocabulary: "SUPER_SAVER",
    }));
    mockResolveBinding.mockReturnValue({
      binding: { run: (work: (context: unknown) => Promise<unknown>) => work({ store: { quarantine } }) },
    });
    const res = response();

    await createChannelWebhookRoute("noop_channel")(
      request({ "x-channel-webhook-token": "expected-token" }),
      res,
    );

    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res)).toMatchObject({ data: { status: "quarantined", quarantineId: "quar-9" } });
  });
});

// The comparison itself belongs to the shared `timingSafeStringEqual` in _lib, not to this route:
// a second hand-rolled constant-time compare is how one of them quietly stops being constant-time,
// and a BFF file that reaches for Buffer/crypto directly also trips the backend-DB boundary
// scanner, whose `dbChain` pattern matches any `.from(`. These cases pin the ROUTE's contract —
// which headers are accepted and what is refused — on top of that shared primitive.
describe("channel webhook token verification", () => {
  it("is false whenever no token is configured, whatever the caller sends", () => {
    expect(verifyChannelWebhookToken({ headers: { authorization: "Bearer x" } } as never, undefined)).toBe(false);
    expect(verifyChannelWebhookToken({ headers: {} } as never, "")).toBe(false);
  });

  it("accepts either the bearer header or the bare channel header", () => {
    expect(verifyChannelWebhookToken({ headers: { authorization: "Bearer t" } } as never, "t")).toBe(true);
    expect(verifyChannelWebhookToken({ headers: { "x-channel-webhook-token": "t" } } as never, "t")).toBe(true);
  });

  it("refuses a request carrying no token header at all", () => {
    expect(verifyChannelWebhookToken({ headers: {} } as never, "token")).toBe(false);
    expect(verifyChannelWebhookToken({ headers: { authorization: "" } } as never, "token")).toBe(false);
  });

  it("refuses an array-valued header whose first entry is wrong", () => {
    expect(verifyChannelWebhookToken({ headers: { authorization: ["Bearer nope"] } } as never, "token")).toBe(false);
    expect(verifyChannelWebhookToken({ headers: { authorization: ["Bearer token"] } } as never, "token")).toBe(true);
  });

  it("refuses a prefix, a suffix and a differing token of equal length", () => {
    expect(verifyChannelWebhookToken({ headers: { "x-channel-webhook-token": "tok" } } as never, "token")).toBe(false);
    expect(verifyChannelWebhookToken({ headers: { "x-channel-webhook-token": "tokens" } } as never, "token")).toBe(false);
    expect(verifyChannelWebhookToken({ headers: { "x-channel-webhook-token": "toker" } } as never, "token")).toBe(false);
  });
});

describe("channel ingest webhook flag", () => {
  it("is true only for the exact string", () => {
    process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "true";
    expect(channelIngestWebhookEnabled()).toBe(true);
    process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "1";
    expect(channelIngestWebhookEnabled()).toBe(false);
    delete process.env.CHANNEL_INGEST_WEBHOOK_ENABLED;
    expect(channelIngestWebhookEnabled()).toBe(false);
  });
});
