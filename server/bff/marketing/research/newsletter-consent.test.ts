import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import {
  COMMUNICATION_INTEGRATION_SIGNATURE_HEADER,
  COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER,
  signCommunicationIntegrationEvent,
} from "../../../infra/communications/integrationEventSignature.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

const { handleConsent } = vi.hoisted(() => ({ handleConsent: vi.fn() }));
vi.mock("./acquisitionEvidenceDirect.js", () => ({
  handleAcquisitionNewsletterConsent: handleConsent,
}));

describe("POST /api/bff/marketing/research/newsletter-consent", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("rejects an invalid signature before invoking the consent port", async () => {
    vi.stubEnv("COMMUNICATION_INTEGRATIONS_EVENTS_SECRET", "integration-secret");
    const { default: handler } = await import("./newsletter-consent.js");
    const res = response();
    await handler(request(JSON.stringify({ contractVersion: "acquisition_newsletter_consent_v1" }), "bad"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(handleConsent).not.toHaveBeenCalled();
  });

  it("passes a verified providerless command to the direct binding", async () => {
    vi.stubEnv("COMMUNICATION_INTEGRATIONS_EVENTS_SECRET", "integration-secret");
    handleConsent.mockImplementation(async (_body, res: HttpResponse) => { res.status(200).json({ ok: true }); });
    const { default: handler } = await import("./newsletter-consent.js");
    const body = JSON.stringify({ contractVersion: "acquisition_newsletter_consent_v1" });
    const res = response();
    await handler(request(body), res);
    expect(handleConsent).toHaveBeenCalledWith({ contractVersion: "acquisition_newsletter_consent_v1" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it("public default refuses before privileged consent or event work", async () => {
    unitComposition.enabled = false;
    vi.stubEnv("COMMUNICATION_INTEGRATIONS_EVENTS_SECRET", "integration-secret"); handleConsent.mockClear();
    try {
      const { default: handler } = await import("./newsletter-consent.js");
      const res = response();
      await handler(request(JSON.stringify({ contractVersion: "acquisition_newsletter_consent_v1" })), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: false, error: expect.objectContaining({ details: expect.objectContaining({ reason: "adopter_policy_required" }) }),
      }));
      for (const effect of [handleConsent]) expect(effect).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
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
