import { describe, expect, it } from "vitest";
import {
  signCommunicationIntegrationEvent,
  verifyCommunicationIntegrationEventSignature,
} from "./integrationEventSignature.js";

describe("communication integration event signatures", () => {
  it("verifies timestamped HMAC signatures", () => {
    const rawBody = JSON.stringify({ providerKind: "noop_newsletter" });
    const timestamp = 1_780_000_000;
    const secret = "integration-secret";
    const signature = signCommunicationIntegrationEvent({ rawBody, timestamp, secret });

    expect(verifyCommunicationIntegrationEventSignature({
      rawBody,
      signatureHeader: `sha256=${signature}`,
      timestampHeader: String(timestamp),
      secret,
      now: () => timestamp + 30,
    })).toBe(true);
  });

  it("rejects stale or mismatched signatures", () => {
    const rawBody = "{}";
    const timestamp = 1_780_000_000;
    const secret = "integration-secret";
    const signature = signCommunicationIntegrationEvent({ rawBody, timestamp, secret });

    expect(verifyCommunicationIntegrationEventSignature({
      rawBody,
      signatureHeader: signature,
      timestampHeader: String(timestamp),
      secret,
      now: () => timestamp + 301,
    })).toBe(false);
    expect(verifyCommunicationIntegrationEventSignature({
      rawBody: "{\"changed\":true}",
      signatureHeader: signature,
      timestampHeader: String(timestamp),
      secret,
      now: () => timestamp,
    })).toBe(false);
  });
});
