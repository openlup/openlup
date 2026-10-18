import { afterEach, expect, it, vi } from "vitest";
import { createOperatorAuthHandlers } from "../../src/identity/operatorAuthHandlers.js";
import { createOperatorSessionService } from "../../src/identity/operatorSession.js";
import type { OperatorIdentityStore } from "../../src/identity/operatorPorts.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
function fixture() {
  const sessions = { requestChallenge: vi.fn(async (_email: string, accept?: () => Promise<void>) => { await accept?.(); }), verifyChallenge: vi.fn(async () => null) };
  const padResponseTime = vi.fn(async () => {});
  const handlers = createOperatorAuthHandlers({ sessions, padResponseTime, origin: "https://app.example.invalid", messages: { invalidRequest: "bad", forbidden: "forbidden", unauthorized: "unauthorized", unavailable: "unavailable" } });
  const req = { method: "POST", headers: { origin: "https://app.example.invalid", "content-type": "application/json", "x-forwarded-host": "attacker.invalid" }, body: { email: "admin@example.invalid" } } as HttpRequest;
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return { sessions, padResponseTime, handlers, req, res: res as unknown as HttpResponse, status: res.status, json: res.json };
}
it("unknown, revoked and limited requests share accepted response and 400ms floor", async () => {
  const f = fixture(); await f.handlers.requestChallenge(f.req, f.res);
  expect(f.status).toHaveBeenCalledWith(200); expect(f.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } }); expect(f.padResponseTime).toHaveBeenCalledWith(expect.any(Number), 400);
});
it("cross origin and spoofed callback origins refuse before any store operation", async () => {
  const f = fixture(); f.req.headers.origin = "https://attacker.invalid";
  await f.handlers.requestChallenge(f.req, f.res); expect(f.status).toHaveBeenCalledWith(403); expect(f.sessions.requestChallenge).not.toHaveBeenCalled();
});
it("requires JSON, rejects malformed envelopes and uses a generic authentication refusal", async () => {
  const f = fixture(); f.req.body = { token: "bad" }; await f.handlers.verifyChallenge(f.req, f.res); expect(f.status).toHaveBeenLastCalledWith(401);
  f.req.body = { email: "extra", token: "a".repeat(43) }; await f.handlers.verifyChallenge(f.req, f.res); expect(f.status).toHaveBeenLastCalledWith(400);
  f.req.body = { token: "a".repeat(43) }; await f.handlers.verifyChallenge(f.req, f.res); expect(f.status).toHaveBeenLastCalledWith(401);
  f.req.headers["content-type"] = "text/plain"; await f.handlers.verifyChallenge(f.req, f.res); expect(f.status).toHaveBeenLastCalledWith(403);
});
it("database and signing failures return 503 and unsupported methods return 405", async () => {
  const f = fixture(); f.sessions.requestChallenge.mockRejectedValueOnce(new Error("db"));
  await f.handlers.requestChallenge(f.req, f.res); expect(f.status).toHaveBeenLastCalledWith(503);
  f.req.method = "GET"; await f.handlers.verifyChallenge(f.req, f.res); expect(f.status).toHaveBeenLastCalledWith(405);
});

afterEach(() => vi.useRealTimers());
it.each(["unknown", "revoked", "limited"])("sends the same response at the same time for eligible and %s requests before slow delivery", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const store = { issue: vi.fn(), redeem: vi.fn(), findMembership: vi.fn(), bootstrapFirstAdministrator: vi.fn(), pruneChallenges: vi.fn(), close: vi.fn() } satisfies OperatorIdentityStore;
  const delivery = { deliver: vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); }) };
  const sessions = createOperatorSessionService({ store, delivery, issuer: { issue: vi.fn() } });
  const handlers = createOperatorAuthHandlers({ sessions, origin: "https://app.example.invalid", messages: { invalidRequest: "bad", forbidden: "forbidden", unauthorized: "unauthorized", unavailable: "unavailable" },
    padResponseTime: async (started, minimum) => { await new Promise(resolve => setTimeout(resolve, Math.max(0, started + minimum - Date.now()))); },
  });
  const responses: { at: number; body: unknown }[] = [];
  f.json.mockImplementation(body => { responses.push({ at: Date.now(), body }); return f.res; });
  for (const eligible of [true, false]) {
    responses.length = 0;
    store.issue.mockResolvedValueOnce(eligible ? { deliverable: true, email: "admin@example.invalid", expiresAt: "2026-10-18T12:10:00Z" } : { deliverable: false });
    const started = Date.now();
    const request = handlers.requestChallenge(f.req, f.res);
    await vi.advanceTimersByTimeAsync(400);
    expect(responses).toEqual([{ at: started + 400, body: { ok: true, data: { accepted: true } } }]);
    expect(f.status).toHaveBeenLastCalledWith(200);
    if (eligible) {
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(f.json.mock.invocationCallOrder.at(-1)).toBeLessThan(delivery.deliver.mock.invocationCallOrder[0]);
      await vi.advanceTimersByTimeAsync(2000);
    }
    await request;
    expect(responses).toHaveLength(1);
  }
  expect(delivery.deliver).toHaveBeenCalledTimes(1);
});
