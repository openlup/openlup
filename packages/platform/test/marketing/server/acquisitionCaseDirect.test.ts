import { describe, expect, it, vi } from "vitest";

import { createBffResponder } from "../../../src/bff/index.js";
const respond = createBffResponder();
import type { AcquisitionCaseReadBinding } from "../../../src/marketing/server/directPorts.js";
import {
  createAcquisitionCaseListDirectHandler,
  createAcquisitionCaseActiveCountDirectHandler,
} from "../../../src/marketing/server/acquisitionCaseDirect.js";

type DirectHandler = ReturnType<typeof createAcquisitionCaseListDirectHandler>;
type HttpRequest = Parameters<DirectHandler>[0];
type HttpResponse = Parameters<DirectHandler>[1];

const OPERATOR_ID = "9f576216-011a-4f67-8404-3f28f7f624d5";


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

function binding(overrides: Partial<AcquisitionCaseReadBinding["handlers"]> = {}): AcquisitionCaseReadBinding {
  return {
    handlers: {
      list: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
      get: vi.fn(async () => ({ ok: false as const, error: { kind: "not_found" as const } })),
      activeCount: vi.fn(async () => ({ ok: true as const, value: { activeTesterCount: 0 } })),
      ...overrides,
    },
  };
}

describe("direct acquisition case routes", () => {
  it("keeps authorization refusal ahead of acquisition binding", async () => {
    const authorize = vi.fn(async () => null);
    const resolveBinding = vi.fn();
    const target = response();
    await createAcquisitionCaseListDirectHandler({ respond, isDirect: () => true, authorize, resolveBinding })(request({ query: { view: "acquisition_case_v1" } }), target.res);
    expect(authorize).toHaveBeenCalledOnce();
    expect(resolveBinding).not.toHaveBeenCalled();
  });
  it("preserves the portable active-count read without authorization", async () => {
    const target = response();
    const authorize = vi.fn();
    await createAcquisitionCaseActiveCountDirectHandler({ respond, isDirect: () => true, authorize, resolveBinding: async () => binding({
      activeCount: vi.fn(async () => ({ ok: true as const, value: { activeTesterCount: 4 } })),
    }) })(request(), target.res);
    expect(target.out.body).toMatchObject({ ok: true, data: { activeTesterCount: 4 } });
    expect(authorize).not.toHaveBeenCalled();
  });
  it("refuses hosted and no-view reads before auth or acquisition binding", async () => {
    const authorize = vi.fn();
    const resolveBinding = vi.fn();
    const target = response();
    await createAcquisitionCaseListDirectHandler({
      respond, isDirect: () => false, authorize, resolveBinding,
    })(request({ query: {} }), target.res);
    expect(target.out.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("rejects a malformed list limit after auth but before acquisition binding", async () => {
    const resolveBinding = vi.fn();
    const target = response();
    await createAcquisitionCaseListDirectHandler({
      respond, isDirect: () => true,
      authorize: async () => OPERATOR_ID,
      resolveBinding,
    })(request({ query: { view: "acquisition_case_v1", limit: "not-a-number" } }), target.res);
    expect(target.out.status).toBe(400);
    expect(resolveBinding).not.toHaveBeenCalled();
  });
});
