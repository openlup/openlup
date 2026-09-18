import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAdminCatalogActivateHandler,
  createAdminCatalogArchiveHandler,
  createAdminCatalogArchiveProductHandler,
  createAdminCatalogCloneDraftHandler,
  createAdminCatalogCreateDraftHandler,
  createAdminCatalogDeactivateHandler,
  createAdminCatalogRestoreHandler,
  createAdminCatalogSetPriceHandler,
  createAdminCatalogUpdateDraftHandler,
  type AdminCatalogHandlerDeps,
} from "./adminCatalogHandler.js";
import type { AdminCatalogDataPort } from "./adminCatalogDataPort.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, headers: {}, query: {} } as unknown as VercelRequest;
}

function deps(overrides: Partial<AdminCatalogHandlerDeps> = {}): AdminCatalogHandlerDeps {
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
    ...overrides,
  };
}

const legacyMutations: Array<{
  name: string;
  create: (handlerDeps: AdminCatalogHandlerDeps) => (req: VercelRequest, res: VercelResponse) => Promise<void>;
  body: unknown;
  writer: keyof AdminCatalogDataPort;
}> = [
  {
    name: "create draft",
    create: createAdminCatalogCreateDraftHandler,
    body: {
      product: {
        slug: "duck",
        name: "Duck",
        species: "dog",
        unit: "can",
        sku: "OPENLUP-DOG-DUCK-CAN-400G",
        netWeightGrams: 400,
        kcalPerUnit: 480,
        allergens: ["duck"],
      },
    },
    writer: "upsertDraft",
  },
  {
    name: "update draft",
    create: createAdminCatalogUpdateDraftHandler,
    body: { slug: "duck", updates: { name: "Duck Deluxe" } },
    writer: "updateDraft",
  },
  {
    name: "set price",
    create: createAdminCatalogSetPriceHandler,
    body: { sku: "OPENLUP-DOG-DUCK-CAN-400G", price: { mode: "one_time", unitPriceMinor: 1490, currency: "PLN" } },
    writer: "setPrice",
  },
  {
    name: "archive SKU",
    create: createAdminCatalogArchiveHandler,
    body: { sku: "OPENLUP-DOG-DUCK-CAN-400G" },
    writer: "archiveSku",
  },
  {
    name: "activate product",
    create: createAdminCatalogActivateHandler,
    body: { slug: "duck" },
    writer: "activateProduct",
  },
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
    body: { sourceSlug: "duck", slug: "duck-copy", sku: "OPENLUP-DOG-DUCK-CAN-400G-COPY" },
    writer: "cloneDraft",
  },
  {
    name: "deactivate product",
    create: createAdminCatalogDeactivateHandler,
    body: { slug: "duck" },
    writer: "deactivateProduct",
  },
];

describe("admin catalog legacy mutation fence", () => {
  it.each(legacyMutations)("authenticates then fences $name without invoking $writer", async ({ create, body, writer }) => {
    const res = createResponse();
    const authorizeAdmin = vi.fn().mockResolvedValue({
      ok: true,
      userId: "admin-1",
      role: "admin",
      isMachineActor: false,
    });
    const d = deps({ authorizeAdmin });

    await create(d)(request("POST", body), res);

    expect(authorizeAdmin).toHaveBeenCalledOnce();
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

  it("preserves the admin authorization gate", async () => {
    const res = createResponse();
    const d = deps({
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "UNAUTHORIZED", message: "no" }),
    });

    await createAdminCatalogCreateDraftHandler(d)(request("POST", {}), res);

    expect(d.dataPort.upsertDraft).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("preserves the POST-only route contract", async () => {
    const res = createResponse();
    const authorizeAdmin = vi.fn();

    await createAdminCatalogCreateDraftHandler(deps({ authorizeAdmin }))(request("GET"), res);

    expect(authorizeAdmin).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
