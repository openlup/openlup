import { describe, expect, it, vi } from "vitest";

import type { PlatformOperatorChecker } from "../../runtime/auth/adminAuthBinding.js";
import type { AcquisitionCaseRuntimeBinding } from "../../runtime/clients/acquisitionCaseBinding.js";
import {
  createAdminClientsTestersDirectHandler,
  createAdminTesterProgramStatusDirectHandler,
  createClientsTesterSignupDirectHandler,
  createTesterProgramActiveCountDirectHandler,
} from "./acquisitionCaseDirect.js";

type DirectHandler = ReturnType<typeof createClientsTesterSignupDirectHandler>;
type HttpRequest = Parameters<DirectHandler>[0];
type HttpResponse = Parameters<DirectHandler>[1];

const TOKEN = "a".repeat(32);
const OPERATOR_ID = "9f576216-011a-4f67-8404-3f28f7f624d5";
const env = {
  PLATFORM_BUNDLE: "node-postgres",
  PLATFORM_OPERATOR_TOKEN: TOKEN,
  PLATFORM_OPERATOR_ID: OPERATOR_ID,
};

function response() {
  const out: { status?: number; body?: unknown } = {};
  const setHeader = vi.fn();
  const res = {
    setHeader,
    status: vi.fn((status: number) => { out.status = status; return res; }),
    json: vi.fn((body: unknown) => { out.body = body; return res; }),
  };
  return { out, setHeader, res: res as unknown as HttpResponse };
}

function request(input: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    headers: {},
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...input,
  } as HttpRequest;
}

function binding(overrides: Partial<AcquisitionCaseRuntimeBinding["handlers"]> = {}): AcquisitionCaseRuntimeBinding {
  return {
    handlers: {
      contractVersion: "tester_application_v1",
      submit: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
      list: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
      get: vi.fn(async () => ({ ok: false as const, error: { kind: "not_found" as const } })),
      transition: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
      activeCount: vi.fn(async () => ({ ok: true as const, value: { activeTesterCount: 0 } })),
      ...overrides,
    },
    close: vi.fn(async () => undefined),
  };
}

function checker(allowed: boolean): PlatformOperatorChecker {
  return {
    isOperatorAllowed: vi.fn(async () => allowed),
    close: vi.fn(async () => undefined),
  };
}

describe("direct acquisition case routes", () => {
  it("retires portable public acquisition before bundle or binding resolution", async () => {
    const resolveBinding = vi.fn();
    const target = response();
    await createClientsTesterSignupDirectHandler({ env, resolveBinding })(request({
      method: "POST",
      body: { contact: { email: "person@example.test" } },
    }), target.res);
    expect(target.out.status).toBe(404);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it.each([
    ["public signup", createClientsTesterSignupDirectHandler],
    ["admin status", createAdminTesterProgramStatusDirectHandler],
  ])("preserves POST method parity on the retired %s route", async (_label, createHandler) => {
    const target = response();
    await createHandler()(request({ method: "GET" }), target.res);
    expect(target.out.status).toBe(405);
    expect(target.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("keeps missing and wrong tokens off DB and inactive membership off acquisition", async () => {
    const checkerFactory = vi.fn(async () => checker(true));
    const resolveBinding = vi.fn();
    for (const token of [undefined, "wrong"]) {
      const target = response();
      await createAdminClientsTestersDirectHandler({ env, resolveBinding, adminAuthOptions: { checkerFactory } })(request({
        headers: token ? { authorization: `Bearer ${token}` } : {},
        query: { view: "acquisition_case_v1" },
      }), target.res);
      expect(target.out.status).toBe(401);
    }
    expect(checkerFactory).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();

    const inactiveChecker = checker(false);
    const inactive = response();
    await createAdminClientsTestersDirectHandler({
      env,
      resolveBinding,
      adminAuthOptions: { checkerFactory: async () => inactiveChecker },
    })(request({ headers: { authorization: `Bearer ${TOKEN}` }, query: { view: "acquisition_case_v1" } }), inactive.res);
    expect(inactive.out.status).toBe(403);
    expect(inactiveChecker.isOperatorAllowed).toHaveBeenCalledWith(OPERATOR_ID);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("retires transitions while preserving the portable active-count read", async () => {
    const transition = vi.fn(async () => ({ ok: false as const, error: { kind: "conflict" as const } }));
    const conflict = response();
    await createAdminTesterProgramStatusDirectHandler({ env, authorize: async () => OPERATOR_ID, resolveBinding: async () => binding({ transition }) })(request({
      method: "POST",
      headers: { "idempotency-key": "status:key-123" },
      body: { view: "acquisition_case_v1", caseRef: "case:tester-123", expectedVersion: 1, transition: "approve" },
    }), conflict.res);
    expect(conflict.out.status).toBe(404);
    expect(transition).not.toHaveBeenCalled();

    const count = response();
    await createTesterProgramActiveCountDirectHandler({ env, resolveBinding: async () => binding({
      activeCount: vi.fn(async () => ({ ok: true as const, value: { activeTesterCount: 4 } })),
    }) })(request(), count.res);
    expect(count.out.body).toMatchObject({ ok: true, data: { activeTesterCount: 4 } });
  });

  it("refuses hosted and no-view reads before auth or acquisition binding", async () => {
    const authorize = vi.fn();
    const resolveBinding = vi.fn();
    const target = response();
    await createAdminClientsTestersDirectHandler({
      env: { PLATFORM_BUNDLE: "vercel-supabase" }, authorize, resolveBinding,
    })(request({ query: {} }), target.res);
    expect(target.out.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("rejects a malformed list limit after auth but before acquisition binding", async () => {
    const resolveBinding = vi.fn();
    const target = response();
    await createAdminClientsTestersDirectHandler({
      env,
      authorize: async () => OPERATOR_ID,
      resolveBinding,
    })(request({ query: { view: "acquisition_case_v1", limit: "not-a-number" } }), target.res);
    expect(target.out.status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
  });
});
