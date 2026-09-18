import { describe, expect, it, vi } from "vitest";
import type { PartnerAcquisitionPort } from "../../../src/domains/partners/ports.js";
import {
  createPartnerAcquisitionListHandler,
  createPartnerAcquisitionSubmitHandler,
  createPartnerAcquisitionTransitionHandler,
} from "./partnerAcquisitionDirect.js";

const TOKEN = "o".repeat(32);
const ACTOR = "9f576216-011a-4f67-8404-3f28f7f624d5";
const ENV = {
  PLATFORM_BUNDLE: "node-postgres",
  DATABASE_URL: "postgres://direct/partners",
  PLATFORM_OPERATOR_TOKEN: TOKEN,
  PLATFORM_OPERATOR_ID: ACTOR,
};
const CASE = {
  contractVersion: "partner_acquisition_v1" as const,
  caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222",
  organization: { name: "Acme Foods", country: "US" },
  contact: { firstName: "Jane", lastName: "Smith", email: "jane@acme.example", phone: "+15551234567" },
  notes: "Retail inquiry",
  status: "new" as const,
  version: 1,
  createdAt: "2026-08-17T10:00:00.000+00:00",
  updatedAt: "2026-08-17T10:00:00.000+00:00",
};

type Handler = ReturnType<typeof createPartnerAcquisitionSubmitHandler>;
type HttpRequest = Parameters<Handler>[0];
type HttpResponse = Parameters<Handler>[1];

function port(): PartnerAcquisitionPort {
  return {
    submit: vi.fn(async () => ({ ok: true as const, value: CASE, replayed: false })),
    list: vi.fn(async () => ({
      ok: true as const,
      value: { contractVersion: "partner_acquisition_v1" as const, cases: [CASE], nextCursor: null },
    })),
    transition: vi.fn(async () => ({
      ok: true as const,
      value: { ...CASE, status: "contacted" as const, version: 2 },
      replayed: false,
    })),
    close: vi.fn(async () => undefined),
  };
}

function request(
  method: string,
  body?: unknown,
  query: Record<string, string> = {},
  token?: string,
): HttpRequest {
  return {
    method,
    body,
    query,
    headers: {
      "idempotency-key": "partner-command-0001",
      "x-forwarded-for": "127.0.0.1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  } as unknown as HttpRequest;
}

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function authOptions(allowed = true) {
  return {
    checkerFactory: vi.fn(async () => ({
      isOperatorAllowed: vi.fn(async () => allowed),
      close: vi.fn(async () => undefined),
    })),
  };
}

describe("partner acquisition direct BFF", () => {
  it("submits through the mounted neutral port and returns the existing public envelope", async () => {
    const adapter = port();
    const res = response();
    await createPartnerAcquisitionSubmitHandler({
      env: ENV,
      resolvePort: async () => adapter,
    })(request("POST", {
      company: "Acme Foods", country: "US", firstName: "Jane", lastName: "Smith",
      email: "jane@acme.example", phone: "+1 555 123 4567", notes: "Retail inquiry",
    }), res);
    expect(adapter.submit).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "partner-command-0001",
      requesterKey: "127.0.0.1",
      policyVersion: "partner-inquiry-request-v1",
      sourcePath: "/partners/b2b-inquiries",
    }));
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { success: true, id: CASE.caseRef },
    });
  });

  it("authorizes before opening the partner port", async () => {
    const resolvePort = vi.fn(async () => port());
    const unauthorized = response();
    const options = { env: ENV, resolvePort, authOptions: authOptions() };
    await createPartnerAcquisitionListHandler(options)(request("GET", undefined, {
      view: "partner_acquisition_v1",
    }), unauthorized);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(resolvePort).not.toHaveBeenCalled();

    const forbidden = response();
    await createPartnerAcquisitionListHandler({
      ...options,
      authOptions: authOptions(false),
    })(request("GET", undefined, { view: "partner_acquisition_v1" }, TOKEN), forbidden);
    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(resolvePort).not.toHaveBeenCalled();
  });

  it("lists and transitions the same case for an allowed operator", async () => {
    const adapter = port();
    const options = { env: ENV, resolvePort: async () => adapter, authOptions: authOptions() };
    const listed = response();
    await createPartnerAcquisitionListHandler(options)(request("GET", undefined, {
      view: "partner_acquisition_v1", limit: "10",
    }, TOKEN), listed);
    expect(adapter.list).toHaveBeenCalledWith({
      view: "partner_acquisition_v1", limit: 10, actorRef: ACTOR,
    });
    expect(listed.status).toHaveBeenCalledWith(200);

    const transitioned = response();
    await createPartnerAcquisitionTransitionHandler(options)(request("POST", {
      id: CASE.caseRef, expectedVersion: 1, status: "contacted",
    }, {}, TOKEN), transitioned);
    expect(adapter.transition).toHaveBeenCalledWith({
      actorRef: ACTOR,
      idempotencyKey: "partner-command-0001",
      request: { id: CASE.caseRef, expectedVersion: 1, status: "contacted" },
    });
    expect(transitioned.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("maps validation and conflict before exposing internal errors", async () => {
    const adapter = port();
    vi.mocked(adapter.submit).mockResolvedValueOnce({ ok: false, error: { kind: "conflict" } });
    const conflict = response();
    await createPartnerAcquisitionSubmitHandler({ env: ENV, resolvePort: async () => adapter })(
      request("POST", {
        company: "Acme Foods", country: "US", firstName: "Jane", lastName: "Smith",
        email: "jane@acme.example",
      }), conflict,
    );
    expect(conflict.status).toHaveBeenCalledWith(409);

    const invalid = response();
    await createPartnerAcquisitionSubmitHandler({ env: ENV, resolvePort: async () => adapter })(
      request("POST", { company: "x" }), invalid,
    );
    expect(invalid.status).toHaveBeenCalledWith(400);
  });
});
