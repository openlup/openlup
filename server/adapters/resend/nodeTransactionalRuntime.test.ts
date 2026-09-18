import { describe, expect, it, vi } from "vitest";

import {
  NODE_TRANSACTIONAL_FUNCTIONS,
  createNodeTransactionalRuntime,
  type EdgeFunctionHandler,
} from "./nodeTransactionalRuntime.js";

function handlerReturning(status: number): EdgeFunctionHandler {
  return async () => new Response(JSON.stringify({ ok: status < 400 }), { status });
}

describe("createNodeTransactionalRuntime", () => {
  it("covers only the complete captured Node action", () => {
    expect([...NODE_TRANSACTIONAL_FUNCTIONS]).toEqual(["send-email"]);
  });

  it("maps a 2xx handler response to ok=true with the status preserved", async () => {
    const runtime = createNodeTransactionalRuntime({
      resolveHandler: async () => handlerReturning(200),
    });
    expect(await runtime.invoke("send-email", { tester_id: "t1" })).toEqual({ ok: true, status: 200 });
  });

  it("treats 3xx as ok and 4xx/5xx as not ok", async () => {
    const r3 = createNodeTransactionalRuntime({ resolveHandler: async () => handlerReturning(302) });
    const r4 = createNodeTransactionalRuntime({ resolveHandler: async () => handlerReturning(404) });
    const r5 = createNodeTransactionalRuntime({ resolveHandler: async () => handlerReturning(502) });
    expect(await r3.invoke("send-email", {})).toEqual({ ok: true, status: 302 });
    expect(await r4.invoke("send-email", {})).toEqual({ ok: false, status: 404 });
    expect(await r5.invoke("send-email", {})).toEqual({ ok: false, status: 502 });
  });

  it("rejects an unknown function name with 404 (never a silent success)", async () => {
    const runtime = createNodeTransactionalRuntime({
      resolveHandler: async () => handlerReturning(200),
    });
    expect(await runtime.invoke("not-a-function", {})).toEqual({ ok: false, status: 404 });
  });

  it("reports 501 when no handler is wired (fails loud, does not pretend mail was sent)", async () => {
    const runtime = createNodeTransactionalRuntime();
    expect(await runtime.invoke("send-email", {})).toEqual({ ok: false, status: 501 });
  });

  it("reports 500 when the resolver throws", async () => {
    const runtime = createNodeTransactionalRuntime({
      resolveHandler: async () => {
        throw new Error("boot failure");
      },
    });
    expect(await runtime.invoke("send-email", {})).toEqual({ ok: false, status: 500 });
  });

  it("reports 500 when the handler itself throws", async () => {
    const runtime = createNodeTransactionalRuntime({
      resolveHandler: async () => async () => {
        throw new Error("handler blew up");
      },
    });
    expect(await runtime.invoke("send-email", {})).toEqual({ ok: false, status: 500 });
  });

  it("synthesizes a POST Request with a JSON body but no privileged headers", async () => {
    const captured: Request[] = [];
    const runtime = createNodeTransactionalRuntime({
      baseUrl: "https://example.test/",
      resolveHandler: async () => async (req: Request) => {
        captured.push(req);
        return new Response("ok", { status: 200 });
      },
    });
    await runtime.invoke("send-email", { receipt: "delivery-1" });
    const req = captured[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://example.test/internal/transactional/send-email");
    expect(req.headers.get("Authorization")).toBeNull();
    expect(captured[0].headers.get("x-cron-secret")).toBeNull();
    expect(await req.json()).toEqual({ receipt: "delivery-1" });
  });

  it("only resolves the handler for known functions", async () => {
    const resolveHandler = vi.fn(async () => handlerReturning(200));
    const runtime = createNodeTransactionalRuntime({ resolveHandler });
    await runtime.invoke("unknown", {});
    expect(resolveHandler).not.toHaveBeenCalled();
  });
});
