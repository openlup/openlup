import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type {
  CustomerDiagnosticHistoryPort,
  CustomerDiagnosticOverviewPort,
} from "../../domains/observability/customerDiagnosticHistory.js";
import {
  CustomerDiagnosticDisabledError,
  CustomerDiagnosticOriginError,
  CustomerDiagnosticUnauthorizedError,
  type CustomerDiagnosticHistoryBinding,
} from "../../runtime/observability/customerDiagnosticHistoryBinding.js";
import { createCustomerDiagnosticEventsRoute } from "./customer-diagnostic-events.js";

type DiagnosticPort = CustomerDiagnosticHistoryPort & CustomerDiagnosticOverviewPort;

const body = {
  contractVersion: "customer-diagnostic-ingest.v1",
  clientEventKey: "11111111-1111-4111-8111-111111111111",
  action: "entry_boot",
  phase: "settled",
  code: "failed",
};

describe("customer diagnostic events BFF", () => {
  it("acknowledges only a committed append and returns its opaque capability", async () => {
    const port = fakePort({ outcome: "committed", credentialDisposition: "issued", deduplicated: false });
    const target = response();
    await createCustomerDiagnosticEventsRoute({
      createCredential: () => "A".repeat(43),
      resolveBinding: () => binding(port),
    })(request(body), target.res);
    expect(port.ingest).toHaveBeenCalledWith(expect.objectContaining({
      principalId: null, subjectId: null, ingestRequestId: expect.any(String),
    }));
    expect(target.out.status).toBe(200);
    expect(target.out.body).toMatchObject({ ok: true, data: {
      contractVersion: "customer-diagnostic-ingest.v1",
      persistence: "committed",
      segmentCredential: "A".repeat(43),
      deduplicated: false,
    } });
  });

  it("keeps absent coverage on the retained v1 path and forwards only explicit v2", async () => {
    const legacy = fakePort({ outcome: "rate_limited" });
    await createCustomerDiagnosticEventsRoute({ resolveBinding: () => binding(legacy) })(request(body), response().res);
    expect(legacy.ingest).toHaveBeenCalledWith(expect.not.objectContaining({ coverageVersion: expect.anything() }));
    const v2 = fakePort({ outcome: "rate_limited" });
    await createCustomerDiagnosticEventsRoute({ resolveBinding: () => binding(v2) })(request({ ...body, coverageVersion: "purchase-auth-account.v2" }), response().res);
    expect(v2.ingest).toHaveBeenCalledWith(expect.objectContaining({ coverageVersion: "purchase-auth-account.v2" }));
  });

  it("stores the event but drops a browser reference outside the closed vocabulary", async () => {
    const dropped = fakePort({ outcome: "rate_limited" });
    await createCustomerDiagnosticEventsRoute({ resolveBinding: () => binding(dropped) })(
      request({ ...body, relatedRequestId: "checkout-timeout-request" }), response().res,
    );
    expect(dropped.ingest).toHaveBeenCalledTimes(1);
    expect(dropped.ingest).toHaveBeenCalledWith(expect.not.objectContaining({ relatedRequestId: expect.anything() }));

    for (const reference of ["11111111-1111-4111-8111-111111111111", "bff-axiom-canary-healthy-1"]) {
      const kept = fakePort({ outcome: "rate_limited" });
      await createCustomerDiagnosticEventsRoute({ resolveBinding: () => binding(kept) })(
        request({ ...body, relatedRequestId: reference }), response().res,
      );
      expect(kept.ingest).toHaveBeenCalledWith(expect.objectContaining({ relatedRequestId: reference }));
    }
  });

  it("does not trust the host request carrier as a reference outside that host runtime", async () => {
    const hosted = "iad1::sfo1::edge-request";
    const node = fakePort({ outcome: "rate_limited" });
    await createCustomerDiagnosticEventsRoute({ env: {}, resolveBinding: () => binding(node) })(
      request({ ...body, relatedRequestId: hosted }), response().res,
    );
    expect(node.ingest).toHaveBeenCalledWith(expect.not.objectContaining({ relatedRequestId: expect.anything() }));

    const host = fakePort({ outcome: "rate_limited" });
    await createCustomerDiagnosticEventsRoute({ env: { VERCEL: "1" }, resolveBinding: () => binding(host) })(
      request({ ...body, relatedRequestId: hosted }), response().res,
    );
    expect(host.ingest).toHaveBeenCalledWith(expect.objectContaining({ relatedRequestId: hosted }));
  });

  it("rejects an explicit unknown coverage version before any RPC binding", async () => {
    const resolveBinding = vi.fn();
    const target = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding })(request({ ...body, coverageVersion: "purchase-auth-account.v1" }), target.res);
    expect(target.out.status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...body, action: "auth_callback", phase: "settled", code: "callback_expired" }, "v2-only action and code"],
    [{ ...body, action: "configurator_gate", phase: "attempted", code: "observed" }, "v2-only action"],
    [{ ...body, action: "account_mutation", phase: "settled", code: "validation_blocked" }, "v2-only code"],
  ])("rejects absent coverage with %s before any RPC binding", async (legacyBody) => {
    const resolveBinding = vi.fn();
    const target = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding })(request(legacyBody), target.res);
    expect(target.out.status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("accepts the largest declared body and rejects parsed bodies over one KiB", async () => {
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(1_024);
    const accepted = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding: () => binding(fakePort({ outcome: "rate_limited" })) })(
      request(body, { "content-length": "1024" }), accepted.res,
    );
    expect(accepted.out.status).toBe(429);

    const rejected = response();
    const resolveBinding = vi.fn();
    await createCustomerDiagnosticEventsRoute({ resolveBinding })(
      request({ ...body, extra: "x".repeat(1_024) }), rejected.res,
    );
    expect(rejected.out.status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""], ["invalid", "12x"], ["oversize", "1025"], ["multiple", ["10", "11"]],
  ])("rejects a %s Content-Length before resolving persistence", async (_name, contentLength) => {
    const resolveBinding = vi.fn();
    const target = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding })(request(body, { "content-length": contentLength }), target.res);
    expect(target.out.status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and invalid action combinations before side effects", async () => {
    for (const invalid of [{ ...body, rawMessage: "private" }, { ...body, phase: "entered" }]) {
      const resolveBinding = vi.fn();
      const target = response();
      await createCustomerDiagnosticEventsRoute({ resolveBinding })(request(invalid), target.res);
      expect(target.out.status).toBe(400);
      expect(resolveBinding).not.toHaveBeenCalled();
    }
  });

  it.each([
    [new CustomerDiagnosticOriginError(), 403, "FORBIDDEN"],
    [new CustomerDiagnosticUnauthorizedError(), 401, "UNAUTHORIZED"],
    [new CustomerDiagnosticDisabledError(), 503, "UPSTREAM_UNAVAILABLE"],
    [new Error("commit status unknown"), 503, "UPSTREAM_UNAVAILABLE"],
  ])("maps persistence boundary failures without claiming a commit", async (failure, status, code) => {
    const target = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding: () => { throw failure; } })(request(body), target.res);
    expect(target.out.status).toBe(status);
    expect(target.out.body).toMatchObject({ ok: false, error: { code } });
    expect(target.out.body).not.toEqual(expect.objectContaining({ persistence: "committed" }));
  });

  it("does not return a capability when admission is rate limited", async () => {
    const target = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding: () => binding(fakePort({ outcome: "rate_limited" })) })(request(body), target.res);
    expect(target.out.status).toBe(429);
    expect(target.out.body).not.toEqual(expect.objectContaining({ segmentCredential: expect.anything() }));
  });

  it("rejects non-POST methods before binding", async () => {
    const resolveBinding = vi.fn();
    const target = response();
    await createCustomerDiagnosticEventsRoute({ resolveBinding })(request(body, {}, "GET"), target.res);
    expect(target.out.status).toBe(405);
    expect(target.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(resolveBinding).not.toHaveBeenCalled();
  });
});

function fakePort(result: Awaited<ReturnType<CustomerDiagnosticHistoryPort["ingest"]>>): DiagnosticPort {
  return { ingest: vi.fn(async () => result), search: vi.fn(), readSegment: vi.fn(), prune: vi.fn(), overview: vi.fn() };
}

function binding(port: DiagnosticPort): CustomerDiagnosticHistoryBinding {
  return {
    authenticateCustomer: vi.fn(async () => ({ principalId: null, subjectId: null })),
    ingressAbuseKey: vi.fn(() => "b".repeat(64)),
    run: async (work) => work(port),
  };
}

function request(value: unknown, headers: Record<string, string | string[]> = {}, method = "POST"): VercelRequest {
  return { method, headers, query: {}, body: value } as unknown as VercelRequest;
}

function response() {
  const out: { status?: number; body?: unknown } = {};
  const setHeader = vi.fn();
  const res = {
    setHeader, removeHeader: vi.fn(),
    status: vi.fn((status: number) => { out.status = status; return res; }),
    json: vi.fn((value: unknown) => { out.body = value; return res; }),
  };
  return { out, setHeader, res: res as unknown as VercelResponse };
}
