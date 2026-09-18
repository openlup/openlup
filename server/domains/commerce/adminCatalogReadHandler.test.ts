import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAdminCatalogGetHandler,
  createAdminCatalogHistoryHandler,
  createAdminCatalogListHandler,
  type AdminCatalogReadHandlerDeps,
} from "./adminCatalogReadHandler.js";
import type {
  AdminCatalogReadDataPort,
  CatalogHistoryResult,
  ListCatalogProductsResult,
} from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import type { CatalogProductDetail } from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import { CatalogRpcError } from "./adminCatalogDataPort.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function request(method: string, query: Record<string, unknown> = {}): VercelRequest {
  return { method, headers: {}, query } as unknown as VercelRequest;
}

const listResult: ListCatalogProductsResult = {
  products: [
    { slug: "duck", name: "Duck", status: "draft", species: "dog", skuCount: 1, hasActivePrice: false },
  ],
  total: 1,
};

const detail: CatalogProductDetail = {
  slug: "duck",
  name: "Duck",
  status: "draft",
  species: "dog",
  allergens: ["duck"],
  marketingContent: null,
  skus: [
    {
      sku: "OPENLUP-DOG-DUCK-CAN-400G",
      status: "draft",
      petType: "dog",
      title: "Duck",
      netWeightGrams: 400,
      formatCode: "can",
      unitFormCode: "can",
      kcalPerUnit: 480,
      gtin: null,
      priceEntries: [
        { mode: "one_time", unitPriceMinor: 1290, currency: "PLN", active: true, validFrom: "2026-06-01T00:00:00Z", validTo: null },
      ],
    },
  ],
  readyToPublish: true,
  publishBlockers: [],
};

const historyResult: CatalogHistoryResult = {
  events: [
    { id: "e2", action: "set_price", actorKind: "machine", actorEmail: null, source: "mcp_agent", entityType: "catalog_product", entityId: "OPENLUP-DOG-DUCK-CAN-400G", oldValue: null, newValue: { unit_price_minor: 1290 }, occurredAt: "2026-06-02T00:00:00Z" },
    { id: "e1", action: "create_draft", actorKind: "machine", actorEmail: null, source: "mcp_agent", entityType: "catalog_product", entityId: "duck", oldValue: null, newValue: { slug: "duck" }, occurredAt: "2026-06-01T00:00:00Z" },
  ],
  total: 2,
};

function deps(overrides: Partial<AdminCatalogReadHandlerDeps> = {}): AdminCatalogReadHandlerDeps {
  const dataPort: AdminCatalogReadDataPort = {
    list: vi.fn().mockResolvedValue(listResult),
    get: vi.fn().mockResolvedValue(detail),
    history: vi.fn().mockResolvedValue(historyResult),
  };
  return {
    dataPort,
    authorizeAdmin: async () => ({ ok: true, userId: "admin-1", role: "admin", isMachineActor: false }),
    ...overrides,
  };
}

describe("admin catalog read handlers — shared spine", () => {
  it("rejects non-GET (405)", async () => {
    const res = createResponse();
    await createAdminCatalogListHandler(deps())(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects unauthorized callers (401)", async () => {
    const res = createResponse();
    await createAdminCatalogListHandler(
      deps({ authorizeAdmin: async () => ({ ok: false, code: "UNAUTHORIZED", message: "no" }) }),
    )(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("catalog__list", () => {
  it("parses query filters + pagination and returns the summary envelope", async () => {
    const res = createResponse();
    const d = deps();
    await createAdminCatalogListHandler(d)(
      request("GET", { status: "draft", species: "dog", query: "du", limit: "10", offset: "0" }),
      res,
    );
    expect(d.dataPort.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: "draft", species: "dog", query: "du", limit: 10, offset: 0 }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ total: 1, products: listResult.products, contractVersion: "commerce.v0" }),
      }),
    );
  });

  it("defaults status=all + pagination when query is empty", async () => {
    const res = createResponse();
    const d = deps();
    await createAdminCatalogListHandler(d)(request("GET", {}), res);
    expect(d.dataPort.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: "all", limit: 50, offset: 0 }),
    );
  });

  it("rejects a bad query (400) — out-of-range limit", async () => {
    const res = createResponse();
    await createAdminCatalogListHandler(deps())(request("GET", { limit: "9999" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects an unknown filter (400) — strict schema", async () => {
    const res = createResponse();
    await createAdminCatalogListHandler(deps())(request("GET", { bogus: "x" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("catalog__get", () => {
  it("returns the full detail with readyToPublish + publishBlockers", async () => {
    const res = createResponse();
    const d = deps();
    await createAdminCatalogGetHandler(d)(request("GET", { slug: "duck" }), res);
    expect(d.dataPort.get).toHaveBeenCalledWith("duck");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          contractVersion: "commerce.v0",
          product: expect.objectContaining({ readyToPublish: true, publishBlockers: [] }),
        }),
      }),
    );
  });

  it("maps a missing product to NOT_FOUND (404)", async () => {
    const res = createResponse();
    const port: AdminCatalogReadDataPort = {
      list: vi.fn(),
      get: vi.fn().mockRejectedValue(new CatalogRpcError("P0002", "catalog_product_not_found")),
      history: vi.fn(),
    };
    await createAdminCatalogGetHandler(deps({ dataPort: port }))(request("GET", { slug: "nope" }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ details: expect.objectContaining({ reason: "catalog_product_not_found" }) }) }),
    );
  });

  it("rejects a missing slug (400)", async () => {
    const res = createResponse();
    await createAdminCatalogGetHandler(deps())(request("GET", {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 502 when the data port yields a contract-invalid response", async () => {
    const res = createResponse();
    const port: AdminCatalogReadDataPort = {
      list: vi.fn(),
      get: vi.fn().mockResolvedValue({ ...detail, readyToPublish: "yes" as unknown as boolean }),
      history: vi.fn(),
    };
    await createAdminCatalogGetHandler(deps({ dataPort: port }))(request("GET", { slug: "duck" }), res);
    expect(res.status).toHaveBeenCalledWith(502);
  });
});

describe("catalog__history", () => {
  it("returns the audit events newest-first with total", async () => {
    const res = createResponse();
    const d = deps();
    await createAdminCatalogHistoryHandler(d)(request("GET", { slug: "duck", limit: "20" }), res);
    expect(d.dataPort.history).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "duck", limit: 20, offset: 0 }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as { data: { events: { id: string }[]; total: number } };
    expect(body.data.total).toBe(2);
    expect(body.data.events.map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("rejects a missing slug (400)", async () => {
    const res = createResponse();
    await createAdminCatalogHistoryHandler(deps())(request("GET", { limit: "20" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
