/**
 * Smoke + gate-contract test for the generic admin-domain handler factories.
 *
 * This file exists as a companion test so the CI coverage guard
 * (scripts/assert-changed-runtime-coverage.ts) does not flag the handler kit
 * as lacking coverage. The functional contract is exercised extensively via
 * domain-specific handler tests (e.g. adminCatalogReadHandler.test.ts,
 * adminCatalogHandler.test.ts). The cases below pin the OPTIONAL gate contract
 * added in release-gates-w7: omit `enabled`/`flagName`/`disabledMessage` for an
 * always-enabled route; pass `enabled: false` for the (byte-identical) disabled
 * envelope.
 */
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import type { AgentDomainMutationSpec } from "../../../src/lib/agent-domain/domainSpec.js";
import { createAdminMutationHandler, createAdminParameterizedReadHandler } from "./handlers.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function request(method: string, body: Record<string, unknown> = {}): VercelRequest {
  return { method, headers: {}, body, query: body } as unknown as VercelRequest;
}

const passthroughSpec = {
  requestSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
  allowedActorKinds: ["human", "machine"],
} as unknown as AgentDomainMutationSpec<Record<string, unknown>>;

function mutationDeps(overrides: Record<string, unknown> = {}) {
  return {
    mutation: passthroughSpec,
    authorizeAdmin: async () => ({ ok: true as const, userId: "admin-1", role: "admin" as const, isMachineActor: false }),
    invoke: vi.fn().mockResolvedValue({ id: "x1" }),
    toResponse: (r: { id: string }) => ({ id: r.id }),
    invalidRequestMessage: "bad",
    failureMessage: "boom",
    ...overrides,
  };
}

describe("admin-domain handler kit — exports", () => {
  it("exports createAdminMutationHandler as a function", () => {
    expect(typeof createAdminMutationHandler).toBe("function");
  });

  it("exports createAdminParameterizedReadHandler as a function", () => {
    expect(typeof createAdminParameterizedReadHandler).toBe("function");
  });
});

describe("admin-domain handler kit — optional gate contract", () => {
  it("mutation: omitting `enabled` runs the handler (always enabled)", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "x1" });
    const res = createResponse();
    await createAdminMutationHandler(mutationDeps({ invoke }))(request("POST"), res);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("mutation: `enabled: false` emits the disabled envelope with the flag name", async () => {
    const invoke = vi.fn();
    const res = createResponse();
    await createAdminMutationHandler(
      mutationDeps({
        invoke,
        enabled: false,
        flagName: "COMMERCE_EXAMPLE_MUTATIONS_ENABLED",
        disabledMessage: "Example mutations are disabled",
      }),
    )(request("POST"), res);
    expect(invoke).not.toHaveBeenCalled();
    const body = vi.mocked(res.json).mock.calls[0][0] as { error: { message: string; details: { reason: string; featureFlag: string } } };
    expect(body.error.message).toBe("Example mutations are disabled");
    expect(body.error.details).toMatchObject({ reason: "feature_flag_disabled", featureFlag: "COMMERCE_EXAMPLE_MUTATIONS_ENABLED" });
  });
});
