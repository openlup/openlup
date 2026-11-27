import { describe, expect, it, vi } from "vitest";
import { CarrierSoapResponseTooLargeError } from "../../infra/dhl/adminDhlSoap.js";
import {
  CARRIER_TRACKING_ENDPOINT,
  CARRIER_HTTP_ERROR_PREFIX,
  buildCarrierTrackingEnvelope,
  extractCarrierTrackingEvents,
  pollCarrierTracking,
} from "./trackingPoller.js";

describe("carrier tracking poller", () => {
  it("escapes SOAP values and extracts all tracking events", () => {
    expect(buildCarrierTrackingEnvelope("TRK<&", "user<&", "pass<&")).toContain("<shipmentId>TRK&lt;&amp;</shipmentId>");
    expect(extractCarrierTrackingEvents("<status>DWP</status><status>DOR</status><description>w drodze</description>"))
      .toEqual({ codes: ["DWP", "DOR"], descriptions: ["w drodze"] });
  });

  it("preserves SOAP faults and HTTP provider errors with manual redirect and AbortSignal", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("<faultstring>provider fault</faultstring>"))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://evil.example" } }));
    await expect(pollCarrierTracking({ fetchImpl, trackingNumber: "TRK-1", username: "user", password: "pass" }))
      .resolves.toMatchObject({ providerError: "provider fault", events: { codes: [], descriptions: [] } });
    await expect(pollCarrierTracking({ fetchImpl, trackingNumber: "TRK-2", username: "user", password: "pass" }))
      .resolves.toMatchObject({ providerError: `${CARRIER_HTTP_ERROR_PREFIX} 404` });
    await expect(pollCarrierTracking({ fetchImpl, trackingNumber: "TRK-3", username: "user", password: "pass" }))
      .resolves.toMatchObject({ providerError: `${CARRIER_HTTP_ERROR_PREFIX} 302` });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, CARRIER_TRACKING_ENDPOINT, expect.objectContaining({
      redirect: "manual",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ SOAPAction: `${CARRIER_TRACKING_ENDPOINT}#getTrackAndTraceInfo` }),
    }));
  });

  it("enforces timeout, caller signal, and response size cap on tracking polls", async () => {
    const hungFetch = vi.fn(() => new Promise<Response>(() => {}));
    await expect(
      pollCarrierTracking({ fetchImpl: hungFetch as never, trackingNumber: "TRK-1", username: "user", password: "pass", timeoutMs: 25 }),
    ).rejects.toThrow(/timed out/i);

    const oversizedFetch = vi.fn().mockResolvedValue(new Response("x".repeat(256), { status: 200 }));
    await expect(
      pollCarrierTracking({ fetchImpl: oversizedFetch as never, trackingNumber: "TRK-1", username: "user", password: "pass", maxBodyBytes: 64 }),
    ).rejects.toBeInstanceOf(CarrierSoapResponseTooLargeError);

    const controller = new AbortController();
    controller.abort(new Error("poll cancelled"));
    await expect(
      pollCarrierTracking({ fetchImpl: hungFetch as never, trackingNumber: "TRK-1", username: "user", password: "pass", signal: controller.signal }),
    ).rejects.toThrow("poll cancelled");
  });
});
