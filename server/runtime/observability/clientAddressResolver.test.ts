import { describe, expect, it } from "vitest";

import type { VercelRequest } from "../../_lib/types/vercel.js";
import { resolveClientAddress } from "./clientAddressResolver.js";

const forwarded = { "x-forwarded-for": "203.0.113.7, 198.51.100.4, 192.0.2.9" };

describe("diagnostic client address resolver", () => {
  it("selects the declared trusted hop from the right of the forwarding chain", () => {
    for (const [hops, expected] of [[1, "192.0.2.9"], [2, "198.51.100.4"], [3, "203.0.113.7"]] as const) {
      expect(resolveClientAddress(request(forwarded), { trustedProxyHops: hops, env: {} }))
        .toBe(expected);
    }
  });

  it("trims hop whitespace and prefers the declared hop over the platform header", () => {
    expect(resolveClientAddress(request({
      "x-forwarded-for": "  203.0.113.7 ,\t198.51.100.4  ",
      "x-real-ip": "198.51.100.77",
    }), { trustedProxyHops: 2, env: { VERCEL: "1" } })).toBe("203.0.113.7");
  });

  it("falls to the platform address when no hop is declared or the chain is shorter", () => {
    const headers = { ...forwarded, "x-real-ip": "198.51.100.77" };
    const env = { VERCEL: "1" };
    for (const trustedProxyHops of [null, 0, 9]) {
      expect(resolveClientAddress(request(headers), { trustedProxyHops, env })).toBe("198.51.100.77");
    }
  });

  it("keeps a padded chain in the shared bucket and strips a source port from the trusted hop", () => {
    const env = { VERCEL: "1" };
    expect(resolveClientAddress(request({ "x-forwarded-for": ",,", "x-real-ip": "198.51.100.77" }), { trustedProxyHops: 2, env }))
      .toBe("unknown");
    expect(resolveClientAddress(request({ "x-forwarded-for": "203.0.113.7:51234, 10.0.0.1" }), { trustedProxyHops: 2, env }))
      .toBe("203.0.113.7");
    expect(resolveClientAddress(request({ "x-forwarded-for": "[2001:DB8::1]:51234" }), { trustedProxyHops: 1, env }))
      .toBe("2001:db8::1");
    expect(resolveClientAddress(request({ "x-forwarded-for": "2001:db8::1" }), { trustedProxyHops: 1, env }))
      .toBe("2001:db8::1");
  });

  it("ignores the platform header outside the host runtime and uses the transport peer", () => {
    expect(resolveClientAddress(request({ "x-real-ip": "198.51.100.77" }, "10.1.2.3"), { trustedProxyHops: null, env: {} }))
      .toBe("10.1.2.3");
    expect(resolveClientAddress(request(forwarded, "10.1.2.3"), { trustedProxyHops: null, env: {} }))
      .toBe("10.1.2.3");
  });

  it("degrades to one shared bucket when no rung can name the caller", () => {
    expect(resolveClientAddress(request({ "x-real-ip": "198.51.100.77" }), { trustedProxyHops: null, env: {} }))
      .toBe("unknown");
    expect(resolveClientAddress(request({}, "   "), { trustedProxyHops: null, env: {} })).toBe("unknown");
  });
});

function request(
  headers: Record<string, string | string[] | undefined> = {},
  remoteAddress?: string,
): VercelRequest {
  return {
    method: "POST", headers, query: {},
    ...(remoteAddress === undefined ? {} : { socket: { remoteAddress } }),
  } as unknown as VercelRequest;
}
