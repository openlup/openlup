import { afterEach, describe, expect, it, vi } from "vitest";
import { HOSTED_CLIENT_ADDRESS_HEADER, HOSTED_RUNTIME_MARKER_KEY } from "../../adapters/vercel/runtimeProvenance.js";
import type { HttpRequest } from "../types/http.js";
import { rateLimitClientAddress } from "./clientAddress.js";

const key = "CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS";
const peer = "192.0.2.10";
const otherPeer = "192.0.2.11";
const forwarded = "203.0.113.9, 198.51.100.7";
const hosted = "198.51.100.8";

function request(remoteAddress?: string, headers: HttpRequest["headers"] = {}): HttpRequest {
  return { socket: { remoteAddress }, headers } as HttpRequest;
}

afterEach(() => vi.restoreAllMocks());

describe("rate-limit client address", () => {
  it("puts different forwarding claims from the same direct peer in one bucket", () => {
    for (const first of [20, 30]) {
      expect(rateLimitClientAddress(request(peer, {
        "x-forwarded-for": `203.0.113.${first}`,
        "cf-connecting-ip": `203.0.113.${first + 1}`,
        [HOSTED_CLIENT_ADDRESS_HEADER]: `203.0.113.${first + 2}`,
      }), {})).toBe(peer);
    }
  });

  it("keeps distinct transport peers in distinct buckets", () => {
    expect([peer, otherPeer].map((address) =>
      rateLimitClientAddress(request(address, { "x-forwarded-for": forwarded }), {}),
    )).toEqual([peer, otherPeer]);
  });

  it("uses the declared hop from the right of the forwarded chain", () => {
    expect(rateLimitClientAddress(request(peer, { "x-forwarded-for": forwarded }), { [key]: " 1 " }))
      .toBe("198.51.100.7");
  });

  it.each(["", "  ", "0", "999999999999999999999999999999"])(
    "leaves the forwarded rung unused for %j",
    (value) => {
      expect(rateLimitClientAddress(request(peer, { "x-forwarded-for": forwarded }), { [key]: value }))
        .toBe(peer);
    },
  );

  it.each([undefined, "198.51.100.7"])("falls through a missing or short forwarded chain (%j)", (chain) => {
    expect(rateLimitClientAddress(request(peer, { "x-forwarded-for": chain, [HOSTED_CLIENT_ADDRESS_HEADER]: hosted }), {
      [key]: "2", [HOSTED_RUNTIME_MARKER_KEY]: "1",
    })).toBe(hosted);
  });

  it("keeps a blank selected entry in the shared bucket", () => {
    expect(rateLimitClientAddress(request(peer, {
      "x-forwarded-for": [", 198.51.100.7"], [HOSTED_CLIENT_ADDRESS_HEADER]: hosted,
    }), { [key]: "2", [HOSTED_RUNTIME_MARKER_KEY]: "1" })).toBe("unknown");
  });

  it("uses the hosted client-address header with the marker exposed", () => {
    expect(rateLimitClientAddress(request(peer, {
      "x-forwarded-for": forwarded, [HOSTED_CLIENT_ADDRESS_HEADER]: hosted,
    }), { [HOSTED_RUNTIME_MARKER_KEY]: "1" })).toBe(hosted);
  });

  it("ignores the hosted header when the marker is absent", () => {
    expect(rateLimitClientAddress(request(peer, { [HOSTED_CLIENT_ADDRESS_HEADER]: hosted }), {})).toBe(peer);
  });

  it("uses the peer when the hosted marker is present but its header is absent", () => {
    expect(rateLimitClientAddress(request(peer, { "x-forwarded-for": forwarded }), { [HOSTED_RUNTIME_MARKER_KEY]: "1" }))
      .toBe(peer);
  });

  it.each([undefined, "  "])("uses the shared bucket when the socket has no address (%j)", (address) => {
    expect(rateLimitClientAddress(request(address), {})).toBe("unknown");
  });

  it("logs a malformed setting and uses one shared bucket for different peers and headers", () => {
    const value = "invalid-hop-count-fixture";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { [key]: value, [HOSTED_RUNTIME_MARKER_KEY]: "1" };
    expect(rateLimitClientAddress(request(peer, { "x-forwarded-for": forwarded, [HOSTED_CLIENT_ADDRESS_HEADER]: hosted }), env))
      .toBe("unknown");
    expect(rateLimitClientAddress(request(otherPeer, { "x-forwarded-for": hosted, [HOSTED_CLIENT_ADDRESS_HEADER]: forwarded }), env))
      .toBe("unknown");
    expect(log).toHaveBeenCalledTimes(2);
    const message = expect.stringMatching(
      /^OPENLUP_E_TRUSTED_PROXY_HOPS_INVALID\nObserved: .+\nCause: .+\nFix: .+\nRecheck: .+$/,
    );
    for (const [entry] of log.mock.calls) {
      expect(entry).toEqual(message);
      expect(entry).toContain(key);
      expect(entry).not.toContain(value);
    }
  });
});
