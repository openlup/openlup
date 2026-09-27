import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import {
  COMMUNICATION_INTEGRATION_SIGNATURE_HEADER,
  COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER,
  signCommunicationIntegrationEvent,
} from "../../../infra/communications/integrationEventSignature.js";

const { handleConsent } = vi.hoisted(() => ({ handleConsent: vi.fn() }));
vi.mock("./acquisitionEvidenceDirect.js", () => ({
  handleAcquisitionNewsletterConsent: handleConsent,
}));

describe("POST /api/bff/marketing/research/newsletter-consent", () => {
  afterEach(() => { delete process.env.COMMUNICATION_INTEGRATIONS_EVENTS_SECRET; });

  it("rejects an invalid signature before invoking the consent port", async () => {
    process.env.COMMUNICATION_INTEGRATIONS_EVENTS_SECRET = "integration-secret";
    const { default: handler } = await import("./newsletter-consent.js");
    const res = response();
    await handler(request(JSON.stringify({ contractVersion: "acquisition_newsletter_consent_v1" }), "bad"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(handleConsent).not.toHaveBeenCalled();
  });

  it("passes a verified providerless command to the direct binding", async () => {
    process.env.COMMUNICATION_INTEGRATIONS_EVENTS_SECRET = "integration-secret";
    handleConsent.mockImplementation(async (_body, res: HttpResponse) => { res.status(200).json({ ok: true }); });
    const { default: handler } = await import("./newsletter-consent.js");
    const body = JSON.stringify({ contractVersion: "acquisition_newsletter_consent_v1" });
    const res = response();
    await handler(request(body), res);
    expect(handleConsent).toHaveBeenCalledWith({ contractVersion: "acquisition_newsletter_consent_v1" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

function request(rawBody: string, signatureOverride?: string): HttpRequest {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signatureOverride ?? signCommunicationIntegrationEvent({
    rawBody, timestamp, secret: "integration-secret",
  });
  return { method: "POST", body: rawBody, headers: {
    [COMMUNICATION_INTEGRATION_SIGNATURE_HEADER]: `sha256=${signature}`,
    [COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER]: String(timestamp),
  } } as unknown as HttpRequest;
}

function response(): HttpResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res); vi.mocked(res.json).mockReturnValue(res); return res;
}
