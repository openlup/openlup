import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CatalogSkuPacksReadPort } from "../../../src/domains/catalog/ports.js";
import { createCatalogSkuPacksHandler } from "./catalogSkuPacksHandler.js";

describe("catalog sku-packs handler", () => {
  it("returns the per-SKU packs projection through the port", async () => {
    const port = createPort(response());
    const res = createResponse();
    await createHandler({ port })(request("GET"), res);
    expect(port.getCatalogSkuPacks).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: response() });
  });

  it("rejects non-GET methods and unauthenticated admins", async () => {
    const method = createResponse();
    await createHandler({ port: createPort(response()) })(request("POST"), method);
    const unauthorized = createResponse();
    await createHandler({ port: createPort(response()), authorized: false })(request("GET"), unauthorized);
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
  });

  it("maps invalid responses (502) and upstream failures (503)", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ skus: [], totalPacks: -1 }) })(request("GET"), invalid);
    const failed = createResponse();
    await createHandler({ port: createPort(new Error("db down")) })(request("GET"), failed);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("maps authorization throws to the shared envelope", async () => {
    const res = createResponse();
    await createCatalogSkuPacksHandler({
      packsPort: createPort(response()),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("auth down")),
    })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({ port, authorized = true }: { port: CatalogSkuPacksReadPort; authorized?: boolean }) {
  return createCatalogSkuPacksHandler({ packsPort: port, authorizeAdmin: vi.fn().mockResolvedValue(authorized) });
}

function createPort(result: unknown): CatalogSkuPacksReadPort {
  return {
    getCatalogSkuPacks: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function request(method: string): VercelRequest {
  return { method, query: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function response() {
  return {
    skus: [
      {
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        packs: [
          { ean: "5908121193005", kind: "unit" as const, quantity: 1, isPrimary: true, source: "local" as const },
          { ean: "5908121193999", kind: "collective" as const, quantity: 12, isPrimary: false, source: "local" as const },
        ],
      },
    ],
    totalPacks: 2,
  };
}
