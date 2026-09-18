import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  COMMUNICATION_INTEGRATION_SIGNATURE_HEADER,
  COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER,
  signCommunicationIntegrationEvent,
} from "../../../infra/communications/integrationEventSignature.js";

const { mockCreateClient, mockCreateSupabasePort, port } = vi.hoisted(() => {
  const port = {
    recordProviderEvent: vi.fn(),
    recordPermission: vi.fn(),
    markProviderEvent: vi.fn(),
  };
  return {
    port,
    mockCreateClient: vi.fn(() => ({ rpc: vi.fn() })),
    mockCreateSupabasePort: vi.fn(() => port),
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../../../adapters/supabase/communications/newsletterWebhookPort.js", () => ({
  createSupabaseNewsletterWebhookPort: mockCreateSupabasePort,
}));

const ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMMUNICATION_INTEGRATIONS_EVENTS_SECRET",
  "PLATFORM_BUNDLE",
] as const;

type EnvKey = typeof ENV_KEYS[number];

describe("POST /api/bff/communications/integrations/events", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
    mockCreateSupabasePort.mockClear();
    port.recordProviderEvent.mockReset();
    port.recordPermission.mockReset();
    port.markProviderEvent.mockReset();
    port.recordProviderEvent.mockResolvedValue({
      providerEventId: "provider-row-1",
      contactId: "contact-1",
      inserted: true,
    });
    port.recordPermission.mockResolvedValue(undefined);
    port.markProviderEvent.mockResolvedValue(undefined);
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it("rejects invalid signatures before creating a service-role client", async () => {
    setEnv();
    const { default: handler, config } = await import("./events.js");
    const res = createResponse();

    await handler(request(JSON.stringify(validEvent()), { signature: "bad" }), res);

    expect(config).toEqual({ api: { bodyParser: false } });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("processes signed canonical unsubscribe events through the shared webhook core", async () => {
    setEnv();
    const { default: handler } = await import("./events.js");
    const res = createResponse();
    const body = JSON.stringify({
      ...validEvent(),
      eventType: "unsubscribe",
      purpose: null,
    });

    await handler(request(body), res);

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      expect.any(Object),
    );
    expect(port.recordProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      providerKind: "noop_newsletter",
      providerEventId: "evt_1",
      eventType: "unsubscribe",
      processingStatus: "received",
    }));
    expect(port.recordPermission).toHaveBeenCalledTimes(2);
    expect(port.recordPermission).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "marketing_newsletter",
      state: "suppressed",
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

});

function setEnv() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.COMMUNICATION_INTEGRATIONS_EVENTS_SECRET = "integration-secret";
}

function validEvent() {
  return {
    providerKind: "noop_newsletter",
    providerEventId: "evt_1",
    eventType: "subscribe",
    email: "ala@example.com",
    remoteProfileId: "remote-1",
    remoteListId: "list-1",
    purpose: "marketing_newsletter",
    explicitOptInEvidence: true,
    occurredAt: "2026-06-14T10:00:00+00:00",
  };
}

function request(rawBody: string, overrides: { signature?: string } = {}): VercelRequest {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = overrides.signature ?? signCommunicationIntegrationEvent({
    rawBody,
    timestamp,
    secret: "integration-secret",
  });
  return {
    method: "POST",
    headers: {
      [COMMUNICATION_INTEGRATION_SIGNATURE_HEADER]: `sha256=${signature}`,
      [COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER]: String(timestamp),
    },
    body: rawBody,
  } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
