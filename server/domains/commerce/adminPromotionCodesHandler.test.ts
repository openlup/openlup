import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import type { AdminPromotionCodesDataPort } from "./adminPromotionCodesDataPort.js";
import {
  createAdminPromotionCodeCreateHandler,
  createAdminPromotionCodePreviewHandler,
  createAdminPromotionCodesListHandler,
  createAdminPromotionCodeUpdateHandler,
  type AdminPromotionCodesHandlerDeps,
} from "./adminPromotionCodesHandler.js";
import { previewPromotionCode } from "./promotionCodePreview.js";
import { createSupabaseAdminPromotionCodesDataPort } from "../../adapters/supabase/adminPromotionCodes.js";

const secret = "handler-test-promotion-preview-secret-32-bytes";
const context = {
  referenceProductMinor: 10_000,
  oneTimeProductMinor: 10_000,
  subscriptionProductMinor: 8_000,
  shippingMinor: 1_500,
};
const previewInput = {
  benefits: [{ lane: "product" as const, kind: "target_percentage" as const, valueBps: 8_000 }],
  scopes: ["one_time" as const, "subscription_initial" as const],
  promotionEngineVersion: "promotion-engine.v2" as const,
  minimumReferenceMinor: 0,
  context,
};
const validCreate = {
  name: "Private campaign",
  code: { kind: "manual" as const, value: "SECRET80" },
  benefits: previewInput.benefits,
  scopes: previewInput.scopes,
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  minimumReferenceMinor: 0,
  redemptionLimitGlobal: null,
  redemptionLimitPerCustomer: null,
  status: "draft" as const,
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};

function response(): { res: VercelResponse; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn();
  const json = vi.fn();
  const res = { setHeader: vi.fn(), status, json } as unknown as VercelResponse;
  status.mockReturnValue(res);
  json.mockReturnValue(res);
  return { res, status, json };
}

function request(method: string, body: unknown = {}, query: Record<string, unknown> = {}): VercelRequest {
  return { method, body, query, headers: {} } as unknown as VercelRequest;
}

function dependencies(overrides: Partial<AdminPromotionCodesHandlerDeps> = {}): AdminPromotionCodesHandlerDeps {
  const dataPort: AdminPromotionCodesDataPort = {
    list: vi.fn().mockResolvedValue({
      codes: [],
      nextCursor: null,
      legacyCompatibility: { ready: true, unprojectedCount: 0, collisionGroupCount: 0 },
    }),
    definition: vi.fn().mockResolvedValue({
      benefits: previewInput.benefits,
      scopes: previewInput.scopes,
      minimumReferenceMinor: 0,
      revision: 2,
      status: "draft",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: null,
      promotionEngineVersion: "promotion-engine.v2",
    }),
    create: vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000010",
      code: "SECRET80", status: "draft", revision: 1, idempotent: false,
    }),
    update: vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000010",
      status: "active", revision: 3, idempotent: false,
    }),
  };
  return {
    dataPort,
    authorizeAdmin: async () => ({ ok: true, userId: "admin-1", role: "admin", isMachineActor: false }),
    previewSecret: secret,
    ...overrides,
  };
}

describe("admin promotion-code handlers", () => {
  it("enforces methods and authorization", async () => {
    const method = response();
    await createAdminPromotionCodePreviewHandler(dependencies())(request("GET"), method.res);
    expect(method.status).toHaveBeenCalledWith(405);

    const auth = response();
    await createAdminPromotionCodeCreateHandler(dependencies({
      authorizeAdmin: async () => ({ ok: false, code: "UNAUTHORIZED", message: "no" }),
    }))(request("POST", validCreate), auth.res);
    expect(auth.status).toHaveBeenCalledWith(401);
  });

  it("serves every route unconditionally, with no feature-flag-disabled envelope", async () => {
    // The Code Center rollout flags were retired in PR 2243. A hostile env must
    // not be able to bring any of these routes back down: the only way in is
    // through auth and the actor-kind gate.
    const previousEnv = { ...process.env };
    for (const name of [
      "COMMERCE_PROMOTION_CODES_ADMIN_ENABLED",
      "COMMERCE_PROMOTION_CODES_MUTATIONS_ENABLED",
    ]) process.env[name] = "false";

    try {
      const list = response();
      await createAdminPromotionCodesListHandler(dependencies())(request("GET"), list.res);
      expect(list.status).toHaveBeenCalledWith(200);

      const preview = response();
      await createAdminPromotionCodePreviewHandler(dependencies())(
        request("POST", previewInput), preview.res,
      );
      expect(preview.status).toHaveBeenCalledWith(200);

      const deps = dependencies();
      const createOut = response();
      const updateOut = response();
      await createAdminPromotionCodeCreateHandler(deps)(
        request("POST", validCreate), createOut.res,
      );
      await createAdminPromotionCodeUpdateHandler(deps)(request("POST", {
        id: "00000000-0000-4000-8000-000000000010",
        expectedRevision: 2,
        updates: { status: "paused" },
        idempotencyKey: "00000000-0000-4000-8000-000000000099",
      }), updateOut.res);

      expect(createOut.status).toHaveBeenCalledWith(200);
      expect(updateOut.status).toHaveBeenCalledWith(200);
      expect(deps.dataPort.create).toHaveBeenCalled();
      expect(deps.dataPort.update).toHaveBeenCalled();

      for (const out of [list, preview, createOut, updateOut]) {
        expect(JSON.stringify(out.json.mock.calls)).not.toContain("feature_flag_disabled");
      }
    } finally {
      process.env = previousEnv;
    }
  });

  it("always reports the mutation capability as available", async () => {
    const out = response();
    await createAdminPromotionCodesListHandler(dependencies())(request("GET"), out.res);

    expect(out.status).toHaveBeenCalledWith(200);
    expect(out.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ capabilities: { mutationsEnabled: true } }),
    }));
  });

  it("rejects a machine actor before mutation data access", async () => {
    const out = response();
    const deps = dependencies({
      authorizeAdmin: async () => ({ ok: true, userId: "machine", role: "admin", isMachineActor: true }),
    });
    await createAdminPromotionCodeCreateHandler(deps)(request("POST", validCreate), out.res);
    expect(out.status).toHaveBeenCalledWith(403);
    expect(deps.dataPort.create).not.toHaveBeenCalled();
  });

  it("returns a server-signed preview with fixed floor and min-reference eligibility", async () => {
    const out = response();
    await createAdminPromotionCodePreviewHandler(dependencies())(
      request("POST", { ...previewInput, minimumReferenceMinor: 10_001 }), out.res,
    );
    expect(out.status).toHaveBeenCalledWith(200);
    expect(out.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        previewProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        results: expect.arrayContaining([expect.objectContaining({ winner: "automatic" })]),
      }),
    }));
  });

  it("returns 400 and no proof for an unsupported legacy value", async () => {
    const out = response();
    await createAdminPromotionCodePreviewHandler(dependencies())(
      request("POST", {
        ...previewInput,
        promotionEngineVersion: "promotion-engine.v1",
        benefits: [{
          lane: "product",
          kind: "fixed_amount",
          validationState: "unsupported_legacy_value",
        }],
      }),
      out.res,
    );
    expect(out.status).toHaveBeenCalledWith(400);
    expect(out.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        details: { reason: "promotion_preview_unsupported_legacy_value" },
      }),
    }));
  });

  it("maps invalid preview proof to 400 and never reflects the raw code on failure", async () => {
    const out = response();
    await createAdminPromotionCodeCreateHandler(dependencies())(request("POST", {
      ...validCreate,
      status: "active",
      previewContext: context,
      previewProof: "A".repeat(43),
    }), out.res);
    expect(out.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(vi.mocked(out.json).mock.calls)).not.toContain("SECRET80");
  });

  it("accepts a valid signed activation proof and persists only its hash fingerprint", async () => {
    const out = response();
    const deps = dependencies();
    const previewProof = previewPromotionCode(previewInput, secret).previewProof;
    await createAdminPromotionCodeCreateHandler(deps)(request("POST", {
      ...validCreate, status: "active", previewContext: context, previewProof,
    }), out.res);
    expect(out.status).toHaveBeenCalledWith(200);
    expect(deps.dataPort.create).toHaveBeenCalledWith(expect.objectContaining({
      resolvedCode: "SECRET80",
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("requires proof for draft-to-scheduled activation and date-driven effective activation", async () => {
    const scheduled = response();
    await createAdminPromotionCodeUpdateHandler(dependencies())(request("POST", {
      id: "00000000-0000-4000-8000-000000000010",
      expectedRevision: 2,
      updates: { status: "active", validFrom: "2099-01-01T00:00:00.000Z" },
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
    }), scheduled.res);
    expect(scheduled.status).toHaveBeenCalledWith(400);

    const dateDriven = response();
    const deps = dependencies();
    vi.mocked(deps.dataPort.definition).mockResolvedValueOnce({
      benefits: previewInput.benefits, scopes: previewInput.scopes,
      minimumReferenceMinor: 0, revision: 2, status: "active",
      validFrom: "2020-01-01T00:00:00.000Z", validTo: "2021-01-01T00:00:00.000Z",
      promotionEngineVersion: "promotion-engine.v2",
    });
    await createAdminPromotionCodeUpdateHandler(deps)(request("POST", {
      id: "00000000-0000-4000-8000-000000000010",
      expectedRevision: 2,
      updates: { validTo: "2099-01-01T00:00:00.000Z" },
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
    }), dateDriven.res);
    expect(dateDriven.status).toHaveBeenCalledWith(400);
  });

  it("uses adapter-mapped valid_to to block proofless reactivation by date extension", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: {
      benefits: previewInput.benefits,
      scopes: previewInput.scopes,
      minimum_reference_minor: 0,
      revision: 2,
      status: "active",
      valid_from: "2020-01-01T00:00:00.000Z",
      valid_to: "2021-01-01T00:00:00.000Z",
      promotion_engine_version: "promotion-engine.v2",
    }, error: null });
    const out = response();
    const deps = dependencies({
      dataPort: createSupabaseAdminPromotionCodesDataPort({ rpc }),
    });

    await createAdminPromotionCodeUpdateHandler(deps)(request("POST", {
      id: "00000000-0000-4000-8000-000000000010",
      expectedRevision: 2,
      updates: { validTo: "2099-01-01T00:00:00.000Z" },
      idempotencyKey: "00000000-0000-4000-8000-000000000005",
    }), out.res);

    expect(out.status).toHaveBeenCalledWith(400);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("admin_promotion_code_definition", expect.any(Object));
  });

  it("maps a stale optimistic revision from the transactional RPC to conflict", async () => {
    const out = response();
    const deps = dependencies();
    vi.mocked(deps.dataPort.update).mockRejectedValueOnce(
      new DomainRpcError("P0001", "promotion_code_revision_conflict"),
    );
    await createAdminPromotionCodeUpdateHandler(deps)(request("POST", {
      id: "00000000-0000-4000-8000-000000000010",
      expectedRevision: 1,
      updates: { status: "paused" },
      idempotencyKey: "00000000-0000-4000-8000-000000000004",
    }), out.res);
    expect(out.status).toHaveBeenCalledWith(409);
    expect(deps.dataPort.update).toHaveBeenCalledOnce();
  });

  it("maps a malformed decoded cursor to a client error", async () => {
    const out = response();
    const deps = dependencies();
    vi.mocked(deps.dataPort.list).mockRejectedValueOnce(
      new DomainRpcError("22023", "promotion_code_cursor_invalid"),
    );
    await createAdminPromotionCodesListHandler(deps)(request("GET", {}, {
      cursor: Buffer.from("bad-cursor").toString("base64url"),
    }), out.res);
    expect(out.status).toHaveBeenCalledWith(400);
  });

  it("rejects an invalid resulting validity window as a client error", async () => {
    const out = response();
    await createAdminPromotionCodeUpdateHandler(dependencies())(request("POST", {
      id: "00000000-0000-4000-8000-000000000010",
      expectedRevision: 2,
      updates: {
        validFrom: "2027-01-02T00:00:00.000Z",
        validTo: "2027-01-01T00:00:00.000Z",
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000005",
    }), out.res);
    expect(out.status).toHaveBeenCalledWith(400);
  });
});
