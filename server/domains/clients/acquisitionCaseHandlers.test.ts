import { describe, expect, it, vi } from "vitest";

import type { AcquisitionCasePort } from "./acquisitionCasePorts.js";
import { createAcquisitionCaseHandlers } from "./acquisitionCaseHandlers.js";

const request = {
  contact: { email: "person@example.test" },
  consent: {
    accepted: true as const,
    consentVersion: "tester-consent.v1",
    policyVersion: "privacy.v1",
    locale: "en" as const,
  },
  addressReference: {
    source: "local_registry",
    reference: "address:krakow-1",
    revision: "2026-08-16",
    provenance: "operator_fixture",
  },
};

function port(): AcquisitionCasePort {
  return {
    submit: vi.fn(async () => ({ ok: false as const, error: { kind: "conflict" as const } })),
    list: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })),
    get: vi.fn(async () => ({ ok: false as const, error: { kind: "not_found" as const } })),
    transition: vi.fn(async () => ({ ok: false as const, error: { kind: "not_found" as const } })),
    activeCount: vi.fn(async () => ({ ok: true as const, value: 7 })),
    close: vi.fn(async () => undefined),
  };
}

describe("acquisition case handlers", () => {
  it("derives scope, source, consent time and path server-side", async () => {
    const adapter = port();
    const handlers = createAcquisitionCaseHandlers(adapter, {
      now: () => "2026-08-16T12:00:00.000Z",
    });
    await handlers.submit(request, { idempotencyKey: "submit:key-123", requesterKey: "127.0.0.1" });
    expect(adapter.submit).toHaveBeenCalledWith({
      scope: "public_tester_application",
      sourceKind: "tester_application",
      idempotencyKey: "submit:key-123",
      requesterKey: "public_tester_application:127.0.0.1",
      acceptedAt: "2026-08-16T12:00:00.000Z",
      sourcePath: "/tester-application",
      request,
    });
  });

  it("binds actor scope and normalizes active count", async () => {
    const adapter = port();
    const handlers = createAcquisitionCaseHandlers(adapter);
    await handlers.list("operator-1", { view: "acquisition_case_v1", limit: 25 });
    expect(adapter.list).toHaveBeenCalledWith({
      actorRef: "operator-1",
      scope: "public_tester_application",
      limit: 25,
    });
    await handlers.get("operator-1", "acquisition-case:11111111-1111-4111-8111-111111111111");
    expect(adapter.get).toHaveBeenCalledWith({
      actorRef: "operator-1",
      scope: "public_tester_application",
      caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
    });
    await expect(handlers.activeCount()).resolves.toEqual({
      ok: true,
      value: { activeTesterCount: 7 },
    });
  });
});
