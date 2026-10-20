import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminPromotionCodesDataPort } from "./adminPromotionCodesDataPort.js";
import {
  createAdminPromotionCodeCreateHandler,
  createAdminPromotionCodePreviewHandler,
  createAdminPromotionCodesListHandler,
  createAdminPromotionCodeUpdateHandler,
  type AdminPromotionCodesHandlerDeps,
} from "./adminPromotionCodesHandler.js";
import { previewPromotionCode } from "./promotionCodePreview.js";

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

describe("reference promotion-code environment composition", () => {
it("serves every route unconditionally, with no feature-flag-disabled envelope", async () => {
    // The Code Center rollout flags are retired. A hostile env must
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
});
