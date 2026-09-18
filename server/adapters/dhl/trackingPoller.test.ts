import { describe, expect, it, vi } from "vitest";
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

  it("preserves SOAP faults and HTTP provider errors", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("<faultstring>provider fault</faultstring>"))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(pollCarrierTracking({ fetchImpl, trackingNumber: "TRK-1", username: "user", password: "pass" }))
      .resolves.toMatchObject({ providerError: "provider fault", events: { codes: [], descriptions: [] } });
    await expect(pollCarrierTracking({ fetchImpl, trackingNumber: "TRK-2", username: "user", password: "pass" }))
      .resolves.toMatchObject({ providerError: `${CARRIER_HTTP_ERROR_PREFIX} 404` });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, CARRIER_TRACKING_ENDPOINT, expect.objectContaining({
      headers: expect.objectContaining({ SOAPAction: `${CARRIER_TRACKING_ENDPOINT}#getTrackAndTraceInfo` }),
    }));
  });
});
