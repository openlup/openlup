import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { createOmnipackWebhookRoute } from "./_handler.js";
import orderDeliveredRoute from "./order-delivered.js";
import orderPickedRoute from "./order-picked.js";
import orderProcessingRoute from "./order-processing.js";
import orderShippedRoute from "./order-shipped.js";
import shipmentAcceptedRoute from "./shipment-accepted.js";

const { mockCreateGateway, makeFakePort } = vi.hoisted(() => {
  const makeFakePort = () => ({
    ingestInboundEvent: vi.fn(async () => ({ inboundProviderEventId: "evt-1", replayed: false })),
    findDispatchRef: vi.fn(async () => null),
    recordStatusEvidence: vi.fn(),
    recordTrackingReference: vi.fn(),
    markHandedOver: vi.fn(),
    markProviderStockConsumed: vi.fn(),
    markInboundEventProcessed: vi.fn(async () => undefined),
  });
  return {
    makeFakePort,
    mockCreateGateway: vi.fn(() => ({ port: makeFakePort() })),
  };
});

vi.mock("../../../../adapters/supabase/omnipackWebhookGateway.js", () => ({
  createSupabaseOmnipackWebhookGateway: mockCreateGateway,
}));

const ENV_KEYS = [
  "COMMERCE_OMNIPACK_WEBHOOKS_ENABLED",
  "OMNIPACK_PROVIDER_ENABLED",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OMNIPACK_WEBHOOK_TOKEN",
  "ACCOUNTING_REQUEST_ENABLED",
  "ACCOUNTING_ISSUE_TRIGGER",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const CONCRETE_ROUTES = [
  { event: "shipment.accepted", handler: shipmentAcceptedRoute },
  { event: "order.processing_started", handler: orderProcessingRoute },
  { event: "order.picked", handler: orderPickedRoute },
  { event: "order.shipped", handler: orderShippedRoute },
  { event: "order.delivered", handler: orderDeliveredRoute },
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enableWebhookEnv() {
  process.env.COMMERCE_OMNIPACK_WEBHOOKS_ENABLED = "true";
  process.env.OMNIPACK_PROVIDER_ENABLED = "true";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.OMNIPACK_WEBHOOK_TOKEN = "expected-token";
}

describe("OmniPack webhook BFF route", () => {
  afterEach(() => {
    mockCreateGateway.mockReset();
    mockCreateGateway.mockReturnValue({ port: makeFakePort() });
  });

  it("fails closed before parsing or DB work when webhook flags are disabled", async () => {
    process.env.COMMERCE_OMNIPACK_WEBHOOKS_ENABLED = "false";
    process.env.OMNIPACK_PROVIDER_ENABLED = "true";
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(request(), res);

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
    }));
  });

  it("fails closed without service-role env even when webhook flags are enabled", async () => {
    process.env.COMMERCE_OMNIPACK_WEBHOOKS_ENABLED = "true";
    process.env.OMNIPACK_PROVIDER_ENABLED = "true";
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.OMNIPACK_WEBHOOK_TOKEN;
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(request(), res);

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("secret");
  });

  it("rejects invalid tokens before service-role client creation", async () => {
    enableWebhookEnv();
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ "x-omnipack-webhook-token": "wrong-token" }),
      res,
    );

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects malformed Basic Auth before service-role client creation", async () => {
    enableWebhookEnv();
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ authorization: "Basic not-base64" }),
      res,
    );

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects Basic Auth with the wrong password before service-role client creation", async () => {
    enableWebhookEnv();
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ authorization: basicAuth("openlup", "wrong-token") }),
      res,
    );

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects Basic Auth with an empty username before service-role client creation", async () => {
    enableWebhookEnv();
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ authorization: basicAuth("", "expected-token") }),
      res,
    );

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects non-POST requests before service-role client creation", async () => {
    enableWebhookEnv();
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ authorization: "Bearer expected-token" }, "GET"),
      res,
    );

    expect(mockCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("constructs the DB gateway only after method, env, and token gates pass", async () => {
    enableWebhookEnv();
    process.env.ACCOUNTING_REQUEST_ENABLED = "true";
    process.env.ACCOUNTING_ISSUE_TRIGGER = "handoff";
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ "x-omnipack-webhook-token": "expected-token" }),
      res,
    );

    expect(mockCreateGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      }),
      expect.objectContaining({
        accountingEnabled: true,
        accountingPortFactory: expect.any(Function),
        accountingProviderKind: expect.any(String),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("accepts Basic Auth after method, env, and token gates pass", async () => {
    enableWebhookEnv();
    const res = response();

    await createOmnipackWebhookRoute("order.shipped")(
      request({ authorization: basicAuth("openlup", "expected-token") }),
      res,
    );

    expect(mockCreateGateway).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each(CONCRETE_ROUTES)("accepts a valid $event webhook through the concrete route", async ({ event, handler }) => {
    enableWebhookEnv();
    const res = response();

    await handler(
      request({ authorization: "Bearer expected-token" }, "POST", webhookBody(event)),
      res,
    );

    expect(mockCreateGateway).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("accepts a real shipment.accepted body where the route supplies the event", async () => {
    enableWebhookEnv();
    const res = response();

    await shipmentAcceptedRoute(
      request({ authorization: basicAuth("openlup", "expected-token") }, "POST", {
        orderId: "89791ce1-976d-479b-b849-5086bdffa291",
        shipments: [{
          trackingNo: "431327317541800124673586",
          shippingMethod: "InPost",
        }],
      }),
      res,
    );

    expect(mockCreateGateway).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("still rejects an explicit event that conflicts with the concrete route", async () => {
    enableWebhookEnv();
    const res = response();

    await shipmentAcceptedRoute(
      request({ authorization: basicAuth("openlup", "expected-token") }, "POST", {
        event: "order.shipped",
        orderId: "89791ce1-976d-479b-b849-5086bdffa291",
      }),
      res,
    );

    expect(mockCreateGateway).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

function request(
  headers: Record<string, string> = {},
  method = "POST",
  body: Record<string, unknown> = webhookBody("order.shipped"),
): VercelRequest {
  return {
    method,
    body,
    query: {},
    headers,
  } as unknown as VercelRequest;
}

function webhookBody(event: string): Record<string, unknown> {
  return {
    event,
    orderId: "provider-order-1",
    orderNumber: "openlup-order-1001",
    fulfilmentNumber: "FUL-1001",
    occurredAt: "2026-06-10T09:00:00+00:00",
  };
}

function response(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
