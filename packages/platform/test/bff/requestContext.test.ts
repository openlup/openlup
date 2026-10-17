import { describe, expect, it, vi } from "vitest";
import { createRequestContextStore } from "../../src/bff/requestContext.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

function request(): HttpRequest {
  return { method: "GET", headers: {}, query: {} } as HttpRequest;
}

function response(): HttpResponse {
  return {} as HttpResponse;
}

describe("request context store", () => {
  it("creates one context on install and reuses it for every observation", () => {
    const req = request();
    const res = response();
    const readRequestId = vi.fn(() => "request-12");
    const store = createRequestContextStore({ readRequestId });
    expect(store.readResponse(res)).toBeUndefined();
    const installed = store.install(req, res);
    expect(installed).toEqual({ requestId: "request-12" });
    expect(store.install(req, res)).toBe(installed);
    expect(store.readOrCreate(req)).toBe(installed);
    expect(store.readResponse(res)).toBe(installed);
    expect(readRequestId.mock.calls).toEqual([[req]]);
  });

  it("creates on request access but binds responses only on install", () => {
    const req = request();
    const first = response();
    const second = response();
    const readRequestId = vi.fn(() => "request-13");
    const store = createRequestContextStore({ readRequestId });
    const context = store.readOrCreate(req);
    expect(store.readOrCreate(req)).toBe(context);
    expect(store.readResponse(first)).toBeUndefined();
    expect(store.readResponse(second)).toBeUndefined();
    expect(store.install(req, first)).toBe(context);
    expect(store.readResponse(first)).toBe(context);
    expect(store.readResponse(second)).toBeUndefined();
    expect(store.install(req, second)).toBe(context);
    expect(store.readResponse(second)).toBe(context);
    expect(readRequestId.mock.calls).toEqual([[req]]);
  });

  it("keeps interleaved request and response pairs independent", () => {
    const firstReq = request();
    const secondReq = request();
    const firstRes = response();
    const secondRes = response();
    const readRequestId = vi.fn().mockReturnValueOnce("request-14").mockReturnValueOnce("request-15");
    const store = createRequestContextStore({ readRequestId });
    const first = store.install(firstReq, firstRes);
    const second = store.install(secondReq, secondRes);
    expect(second).not.toBe(first);
    expect(store.readResponse(secondRes)).toBe(second);
    expect(store.readResponse(firstRes)).toBe(first);
    expect(store.readOrCreate(secondReq).requestId).toBe("request-15");
    expect(store.readOrCreate(firstReq).requestId).toBe("request-14");
    expect(readRequestId.mock.calls).toEqual([[firstReq], [secondReq]]);
  });

  it("isolates contexts across stores even for the same request and response", () => {
    const req = request();
    const res = response();
    const firstReader = vi.fn(() => "reference-a");
    const secondReader = vi.fn(() => "reference-b");
    const firstStore = createRequestContextStore({ readRequestId: firstReader });
    const secondStore = createRequestContextStore({ readRequestId: secondReader });
    const first = firstStore.install(req, res);
    expect(secondStore.readResponse(res)).toBeUndefined();
    const second = secondStore.install(req, res);
    expect(second).not.toBe(first);
    expect(firstStore.readOrCreate(req)).toBe(first);
    expect(secondStore.readOrCreate(req)).toBe(second);
    expect(firstStore.readResponse(res)).toBe(first);
    expect(secondStore.readResponse(res)).toBe(second);
    expect(first.requestId).toBe("reference-a");
    expect(second.requestId).toBe("reference-b");
    expect(firstReader.mock.calls).toEqual([[req]]);
    expect(secondReader.mock.calls).toEqual([[req]]);
  });
});
