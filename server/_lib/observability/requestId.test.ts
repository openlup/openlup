import { describe, expect, it, vi } from "vitest";
import { acceptsReportedRequestId, readObservedRequestId } from "./requestId.js";

describe("readObservedRequestId", () => {
  it("preserves only the controlled canary identifier, including a non-empty array header", () => {
    expect(readObservedRequestId({
      "x-request-id": ["", "bff-axiom-canary-healthy-1"],
    })).toBe("bff-axiom-canary-healthy-1");
  });

  it("drops arbitrary, malformed, and oversized caller IDs before a safe provider fallback", () => {
    const fallback = "host:request-42";
    expect(readObservedRequestId({ "x-request-id": "buyer@example.com token=secret" }, fallback))
      .toBe(fallback);
    expect(readObservedRequestId({ "x-request-id": "bff-axiom-canary-Uppercase" }, fallback))
      .toBe(fallback);
    expect(readObservedRequestId({
      "x-request-id": `bff-axiom-canary-${"a".repeat(97)}`,
    }, fallback)).toBe(fallback);
  });

  it("does not trust a valid Vercel carrier on a Node request without adapter provenance", () => {
    expect(readObservedRequestId({ "x-vercel-id": "iad1::sfo1::edge-request" }))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("accepts only a safe provider ID supplied through the adapter seam", () => {
    expect(readObservedRequestId({ "x-request-id": "buyer@example.com" }, "node:request-42"))
      .toBe("node:request-42");
    expect(readObservedRequestId({}, "buyer@example.com token=secret"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("acceptsReportedRequestId", () => {
  const hostAccepts = (value: string) => value === "iad1::sfo1::edge-request";

  it.each([
    ["reporter UUID", "11111111-1111-4111-8111-111111111111", true],
    ["uppercase reporter UUID", "AAAAAAAA-1111-5111-B111-111111111111", true],
    ["nil UUID outside the reporter family", "00000000-0000-0000-0000-000000000000", false],
    ["canary", "bff-axiom-canary-healthy-1", true],
    ["uppercase canary", "bff-axiom-canary-Healthy", false],
    ["free text", "checkout-timeout-request", false],
    ["credential-shaped text", "token=secret", false],
    ["empty", "", false],
  ])("classifies a %s without the host predicate", (_label, value, accepted) => {
    expect(acceptsReportedRequestId(value)).toBe(accepted);
  });

  it("admits only what the active host adapter claims, and nothing on a host without one", () => {
    expect(acceptsReportedRequestId("iad1::sfo1::edge-request", hostAccepts)).toBe(true);
    expect(acceptsReportedRequestId("iad1::sfo1::edge-request")).toBe(false);
    expect(acceptsReportedRequestId("iad1::other::edge-request", hostAccepts)).toBe(false);
  });

  it("rejects every non-string reference before the host predicate is consulted", () => {
    const host = vi.fn(() => true);
    for (const value of [undefined, null, 42, {}, ["11111111-1111-4111-8111-111111111111"]]) {
      expect(acceptsReportedRequestId(value, host)).toBe(false);
    }
    expect(host).not.toHaveBeenCalled();
  });
});
