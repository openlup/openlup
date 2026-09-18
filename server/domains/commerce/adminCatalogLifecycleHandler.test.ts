import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAdminCatalogArchiveProductHandler,
  createAdminCatalogCloneDraftHandler,
  createAdminCatalogDeactivateHandler,
  createAdminCatalogRestoreHandler,
  type AdminCatalogHandlerDeps,
} from "./adminCatalogHandler.js";
import type { AdminCatalogDataPort } from "./adminCatalogDataPort.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function request(body: unknown): VercelRequest {
  return { method: "POST", body, headers: {}, query: {} } as unknown as VercelRequest;
}

function deps(): AdminCatalogHandlerDeps {
  const dataPort: AdminCatalogDataPort = {
    upsertDraft: vi.fn(),
    updateDraft: vi.fn(),
    setPrice: vi.fn(),
    archiveSku: vi.fn(),
    activateProduct: vi.fn(),
    archiveProduct: vi.fn(),
    restoreProduct: vi.fn(),
    deactivateProduct: vi.fn(),
    cloneDraft: vi.fn(),
  };
  return {
    dataPort,
    authorizeAdmin: vi.fn().mockResolvedValue({
      ok: true,
      userId: "admin-1",
      role: "admin",
      isMachineActor: false,
    }),
  };
}

const lifecycleMutations: Array<{
  name: string;
  create: (handlerDeps: AdminCatalogHandlerDeps) => (req: VercelRequest, res: VercelResponse) => Promise<void>;
  body: unknown;
  writer: "archiveProduct" | "restoreProduct" | "cloneDraft" | "deactivateProduct";
}> = [
  {
    name: "archive product",
    create: createAdminCatalogArchiveProductHandler,
    body: { slug: "duck" },
    writer: "archiveProduct",
  },
  {
    name: "restore product",
    create: createAdminCatalogRestoreHandler,
    body: { slug: "duck" },
    writer: "restoreProduct",
  },
  {
    name: "clone draft",
    create: createAdminCatalogCloneDraftHandler,
    body: { sourceSlug: "duck", slug: "duck-copy", sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G" },
    writer: "cloneDraft",
  },
  {
    name: "deactivate product",
    create: createAdminCatalogDeactivateHandler,
    body: { slug: "duck" },
    writer: "deactivateProduct",
  },
];

describe("admin catalog lifecycle mutation fence", () => {
  it.each(lifecycleMutations)("fences $name before invoking $writer", async ({ create, body, writer }) => {
    const res = createResponse();
    const d = deps();

    await create(d)(request(body), res);

    expect(d.dataPort[writer]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "FORBIDDEN",
          details: { reason: "legacy_catalog_mutation_fenced" },
        }),
      }),
    );
  });
});
