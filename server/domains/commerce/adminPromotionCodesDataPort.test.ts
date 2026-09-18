import { describe, expect, it, vi } from "vitest";

import type { AdminPromotionCodesDataPort } from "./adminPromotionCodesDataPort.js";

describe("admin promotion-codes data port contract", () => {
  it("keeps definition lifecycle and optimistic revision in the frozen boundary", async () => {
    const port: AdminPromotionCodesDataPort = {
      list: vi.fn(), create: vi.fn(), update: vi.fn(),
      definition: vi.fn().mockResolvedValue({
        benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
        scopes: ["one_time", "subscription_initial"],
        minimumReferenceMinor: 500,
        revision: 7,
        status: "active",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
        promotionEngineVersion: "promotion-engine.v1",
      }),
    };
    await expect(port.definition("admin", "code-id")).resolves.toEqual(expect.objectContaining({
      revision: 7,
      promotionEngineVersion: "promotion-engine.v1",
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
    }));
  });
});
