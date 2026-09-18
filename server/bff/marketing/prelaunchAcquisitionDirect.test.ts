import { describe, expect, it, vi } from "vitest";
import type { AcquisitionCaseRuntimeBinding } from "../../runtime/clients/acquisitionCaseBinding.js";
import {
  createPrelaunchAcquisitionDetailHandler,
  createPrelaunchAcquisitionListHandler,
} from "./prelaunchAcquisitionDirect.js";

const AT = "2026-08-17T10:00:00.000Z";
const CASE = {
  contractVersion: "tester_application_v1" as const,
  caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222",
  sourceKind: "tester_application" as const,
  consent: {
    consentVersion: "tester-consent.v1",
    policyVersion: "privacy.v1",
    recordedAt: AT,
    locale: "en" as const,
    sourcePath: "/tester-application" as const,
  },
  addressReference: {
    source: "fixture",
    reference: "address-ref-0001",
    revision: "v1",
    provenance: "operator_fixture",
  },
  state: "submitted" as const,
  version: 1,
  createdAt: AT,
  updatedAt: AT,
};

type ListHandler = ReturnType<typeof createPrelaunchAcquisitionListHandler>;
type Request = Parameters<ListHandler>[0];
type Response = Parameters<ListHandler>[1];

function binding(): AcquisitionCaseRuntimeBinding {
  return {
    handlers: {
      submit: vi.fn(),
      list: vi.fn(async () => ({
        ok: true as const,
        value: { contractVersion: "tester_application_v1" as const, cases: [CASE], nextCursor: null },
      })),
      get: vi.fn(async () => ({ ok: true as const, value: CASE })),
      transition: vi.fn(),
      activeCount: vi.fn(),
      contractVersion: "tester_application_v1",
    },
    close: vi.fn(async () => undefined),
  };
}

function request(query: Record<string, string>): Request {
  return { method: "GET", headers: {}, query } as unknown as Request;
}

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("prelaunch acquisition direct BFF", () => {
  it("authorizes before resolving persistence", async () => {
    const resolveBinding = vi.fn(async () => binding());
    const res = response();
    await createPrelaunchAcquisitionListHandler({
      authorize: async () => null,
      resolveBinding,
    })(request({ view: "prelaunch_acquisition_v1" }), res);
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("maps the established acquisition list to the strict prelaunch V1 projection", async () => {
    const runtime = binding();
    const res = response();
    await createPrelaunchAcquisitionListHandler({
      authorize: async () => "9f576216-011a-4f67-8404-3f28f7f624d5",
      resolveBinding: async () => runtime,
    })(request({ view: "prelaunch_acquisition_v1", limit: "10" }), res);
    expect(runtime.handlers.list).toHaveBeenCalledWith(
      "9f576216-011a-4f67-8404-3f28f7f624d5",
      { view: "acquisition_case_v1", limit: 10 },
    );
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "prelaunch_acquisition_v1",
        leads: [expect.objectContaining({ sourceRef: CASE.caseRef, state: "submitted" })],
        nextCursor: null,
      },
    });
  });

  it("opens the canonical case and maps a durable not-found refusal", async () => {
    const runtime = binding();
    const options = {
      authorize: async () => "9f576216-011a-4f67-8404-3f28f7f624d5",
      resolveBinding: async () => runtime,
    };
    const found = response();
    await createPrelaunchAcquisitionDetailHandler(options)(request({ sourceRef: CASE.caseRef }), found);
    expect(runtime.handlers.get).toHaveBeenCalledWith(
      "9f576216-011a-4f67-8404-3f28f7f624d5",
      CASE.caseRef,
    );
    expect(found.status).toHaveBeenCalledWith(200);

    vi.mocked(runtime.handlers.get).mockResolvedValueOnce({ ok: false, error: { kind: "not_found" } });
    const missing = response();
    await createPrelaunchAcquisitionDetailHandler(options)(request({
      sourceRef: "acquisition-case:33333333-3333-4333-8333-333333333333",
    }), missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});
