import { describe, expect, it } from "vitest";
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import {
  installObservedRequestContext,
  readOrCreateObservedRequestContext,
  readObservedResponseContext,
} from "./requestContext.js";

describe("observed request context", () => {
  it("binds one trusted reference to both request and response", () => {
    const req = request("bff-axiom-canary-context-1");
    const res = {} as VercelResponse;

    const installed = installObservedRequestContext(req, res);

    expect(installed.requestId).toBe("bff-axiom-canary-context-1");
    expect(readOrCreateObservedRequestContext(req)).toBe(installed);
    expect(readObservedResponseContext(res)).toBe(installed);
  });

  it("keeps interleaved requests and responses isolated", () => {
    const firstReq = request("bff-axiom-canary-context-first");
    const secondReq = request("bff-axiom-canary-context-second");
    const firstRes = {} as VercelResponse;
    const secondRes = {} as VercelResponse;

    installObservedRequestContext(firstReq, firstRes);
    installObservedRequestContext(secondReq, secondRes);

    expect(readObservedResponseContext(secondRes)?.requestId).toBe(
      "bff-axiom-canary-context-second",
    );
    expect(readObservedResponseContext(firstRes)?.requestId).toBe(
      "bff-axiom-canary-context-first",
    );
  });
});

function request(requestId: string): VercelRequest {
  return {
    method: "GET",
    headers: { "x-request-id": requestId },
    query: {},
  } as unknown as VercelRequest;
}
