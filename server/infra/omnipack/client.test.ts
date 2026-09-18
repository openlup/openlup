import { describe, expect, it, vi } from "vitest";
import { OMNIPACK_SIMULATOR_FIXTURES } from "./fixtures.js";
import {
  OmnipackProviderError,
  createOmnipackClient,
  readOmnipackClientConfig,
  sanitizeOmnipackProviderError,
  type OmnipackClientConfig,
} from "./client.js";

const config: OmnipackClientConfig = {
  baseUrl: "https://api.stage.omnipack.tech",
  username: "stage-user",
  password: "stage-pass",
  timeoutMs: 1_000,
  safeReadRetries: 1,
  productPath: "/products",
  inboundPath: "/shipments",
};

describe("Omnipack client", () => {
  it("returns null until the Basic Auth credential gate is complete", () => {
    expect(readOmnipackClientConfig({})).toBeNull();
    expect(readOmnipackClientConfig({
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED: "true",
      OMNIPACK_USERNAME: "stage-user",
    })).toBeNull();

    expect(readOmnipackClientConfig({
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED: "true",
      OMNIPACK_ENV: "stage",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech/",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
      OMNIPACK_HTTP_TIMEOUT_MS: "2500",
      OMNIPACK_SAFE_READ_RETRIES: "2",
    })).toEqual({
      baseUrl: "https://api.stage.omnipack.tech",
      username: "stage-user",
      password: "stage-pass",
      timeoutMs: 2500,
      safeReadRetries: 2,
      productPath: "/products",
      inboundPath: "/shipments",
    });
  });

  it("posts product-create + inbound to the configured paths and does NOT retry them", async () => {
    const productFetch = vi.fn(async () => jsonResponse({ sku: "OPENLUP-DOG-LAMB-CAN-400G" }, { ok: false, status: 500 }));
    const productClient = createOmnipackClient(config, productFetch as typeof fetch);
    await expect(productClient.createProduct({ sku: "OPENLUP-DOG-LAMB-CAN-400G" }, "OPENLUP-DOG-LAMB-CAN-400G")).rejects.toThrow(
      OmnipackProviderError,
    );
    expect(productFetch).toHaveBeenCalledTimes(1); // POST is non-retried even on 500
    const productCalls = productFetch.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(productCalls[0]?.[0].toString()).toBe("https://api.stage.omnipack.tech/products");
    expect(productCalls[0]?.[1]).toMatchObject({ method: "POST" });

    const inboundFetch = vi.fn(async () => jsonResponse({ reference: "seed:abc:OPENLUP:120:LOT1" }));
    const inboundClient = createOmnipackClient(config, inboundFetch as typeof fetch);
    await expect(
      inboundClient.createInbound({ reference: "seed:abc:OPENLUP:120:LOT1", items: [] }, "seed:abc:OPENLUP:120:LOT1"),
    ).resolves.toMatchObject({ provider: "omnipack", reference: "seed:abc:OPENLUP:120:LOT1" });
    expect(inboundFetch).toHaveBeenCalledTimes(1);
    expect((inboundFetch.mock.calls as unknown as Array<[URL, RequestInit]>)[0]?.[0].toString()).toBe(
      "https://api.stage.omnipack.tech/shipments",
    );
  });

  it("reads a product's packs[] via GET /products/{sku} (retried as a safe read)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: "TEMPORARY" }, { ok: false, status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        packs: [
          { ean: "5908121193005", quantity: 1 },
          { ean: "5908121193999", quantity: 12 },
          { quantity: 3 }, // packs without an ean are dropped
        ],
      }));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(client.getProduct("OPENLUP-DOG-LAMB-CAN-400G")).resolves.toEqual({
      provider: "omnipack",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      packs: [
        { ean: "5908121193005", quantity: 1 },
        { ean: "5908121193999", quantity: 12 },
      ],
      raw: { sku: "OPENLUP-DOG-LAMB-CAN-400G", packs: [
        { ean: "5908121193005", quantity: 1 },
        { ean: "5908121193999", quantity: 12 },
        { quantity: 3 },
      ] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls as unknown as Array<[URL, RequestInit]>)[1]?.[0].toString()).toBe(
      "https://api.stage.omnipack.tech/products/OPENLUP-DOG-LAMB-CAN-400G",
    );
  });

  it("posts a single pack to /products/{sku}/packs and does NOT retry it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sku: "OPENLUP-DOG-LAMB-CAN-400G", ean: "5908121193005" }, { ok: false, status: 500 }));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(
      client.createProductPack("OPENLUP-DOG-LAMB-CAN-400G", { ean: "5908121193005", quantity: 1 }, "5908121193005"),
    ).rejects.toThrow(OmnipackProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // POST is non-retried even on 500
    const calls = fetchImpl.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls[0]?.[0].toString()).toBe("https://api.stage.omnipack.tech/products/OPENLUP-DOG-LAMB-CAN-400G/packs");
    expect(calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("honors env-overridable product/inbound paths", () => {
    const overridden = readOmnipackClientConfig({
      OMNIPACK_PROVIDER_ENABLED: "true",
      COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED: "true",
      OMNIPACK_ENV: "stage",
      OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech/",
      OMNIPACK_USERNAME: "stage-user",
      OMNIPACK_PASSWORD: "stage-pass",
      OMNIPACK_WEBHOOK_TOKEN: "unguessable",
      OMNIPACK_PRODUCT_PATH: "/v2/products",
      OMNIPACK_INBOUND_PATH: "/v2/advices",
    });
    expect(overridden?.productPath).toBe("/v2/products");
    expect(overridden?.inboundPath).toBe("/v2/advices");
  });

  it("uses Basic Auth and maps create order responses without retrying unsafe requests", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OMNIPACK_SIMULATOR_FIXTURES.placeOrderResponse, { ok: false, status: 503 }));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest)).rejects.toMatchObject({
      name: "OmnipackProviderError",
      operation: "createOrder",
      status: 503,
      retryable: false,
      mayHaveSucceeded: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = fetchImpl.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls[0]?.[0].toString()).toBe("https://api.stage.omnipack.tech/orders");
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("stage-user:stage-pass").toString("base64")}`,
      },
    });
  });

  it("never repeats a successful create-order POST whose response lacks acceptance proof", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "accepted", orderId: "" }));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest))
      .rejects.toThrow("omnipack_order_response_invalid");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([408, 409, 425, 429, 500, 503, 599])(
    "classifies an ambiguous create-order HTTP %i response as possibly successful without retrying it",
    async (status) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ code: `HTTP_${status}` }, { ok: false, status }));
      const client = createOmnipackClient(config, fetchImpl as typeof fetch);

      await expect(client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest)).rejects.toMatchObject({
        name: "OmnipackProviderError",
        operation: "createOrder",
        status,
        retryable: false,
        mayHaveSucceeded: true,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    "classifies a definite create-order HTTP %i rejection as not successful",
    async (status) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ code: `HTTP_${status}` }, { ok: false, status }));
      const client = createOmnipackClient(config, fetchImpl as typeof fetch);

      await expect(client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest)).rejects.toMatchObject({
        name: "OmnipackProviderError",
        operation: "createOrder",
        status,
        retryable: false,
        mayHaveSucceeded: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies a create-order network failure with no response as possibly successful", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed for client@example.test");
    });
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    const error = await client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest).catch((cause) => cause);

    expect(error).toBeInstanceOf(OmnipackProviderError);
    expect(error).toMatchObject({
      operation: "createOrder",
      status: null,
      code: "network_error",
      retryable: false,
      mayHaveSucceeded: true,
    });
    expect(sanitizeOmnipackProviderError(error)).toEqual({
      code: "network_error",
      mayHaveSucceeded: true,
      message: "OmniPack request failed: createOrder",
      operation: "createOrder",
      retryable: false,
      status: null,
    });
    expect(JSON.stringify(sanitizeOmnipackProviderError(error))).not.toContain("client@example.test");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies a timed-out create-order POST as possibly successful", async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    }));
    const client = createOmnipackClient({ ...config, timeoutMs: 5 }, fetchImpl as typeof fetch);

    await expect(client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest)).rejects.toMatchObject({
      name: "OmnipackProviderError",
      operation: "createOrder",
      status: null,
      code: "network_error",
      retryable: false,
      mayHaveSucceeded: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes an unknown provider failure conservatively without exposing its message", () => {
    const sanitized = sanitizeOmnipackProviderError(
      new Error("raw OmniPack response for client@example.test with stage-pass"),
    );

    expect(sanitized).toEqual({
      code: "omnipack_provider_error",
      mayHaveSucceeded: true,
      message: "OmniPack request failed",
      operation: null,
      retryable: true,
      status: null,
    });
    expect(JSON.stringify(sanitized)).not.toContain("client@example.test");
    expect(JSON.stringify(sanitized)).not.toContain("stage-pass");
  });

  it("retries safe reads and maps stock evidence", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: "TEMPORARY" }, { ok: false, status: 503 }))
      .mockResolvedValueOnce(jsonResponse(OMNIPACK_SIMULATOR_FIXTURES.stockResponse));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(client.getStock()).resolves.toEqual([{
      provider: "omnipack",
      sku: "OPENLUP-KARMA-ADULT-2KG",
      totalQuantity: 48,
      forSaleQuantity: 35,
      reservedOrUnavailableQuantity: 13,
      stockTruth: "external_stock_master_with_local_reservations",
    }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves retryable GET semantics without marking a read as possibly successful", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: "TEMPORARY" }, { ok: false, status: 503 }));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(client.getStock()).rejects.toMatchObject({
      name: "OmnipackProviderError",
      operation: "getStock",
      status: 503,
      retryable: true,
      mayHaveSucceeded: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps read endpoints with query params", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OMNIPACK_SIMULATOR_FIXTURES.stockMovementsResponse))
      .mockResolvedValueOnce(jsonResponse(OMNIPACK_SIMULATOR_FIXTURES.fulfilmentsResponse))
      .mockResolvedValueOnce(jsonResponse(OMNIPACK_SIMULATOR_FIXTURES.fulfilmentRequestsResponse));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    await expect(client.getStockMovements({ startLocalDate: "2026-06-01", endLocalDate: "2026-06-10", page: 2 })).resolves.toHaveLength(1);
    await expect(client.getFulfilments({ page: 0, size: 50 })).resolves.toHaveLength(1);
    await expect(client.getFulfilmentRequests()).resolves.toHaveLength(1);

    expect(fetchImpl.mock.calls[0]?.[0]?.toString()).toBe(
      "https://api.stage.omnipack.tech/stock-movements?startLocalDate=2026-06-01&endLocalDate=2026-06-10&page=2",
    );
    expect(fetchImpl.mock.calls[1]?.[0]?.toString()).toBe("https://api.stage.omnipack.tech/fulfilments?page=0&size=50");
    expect(fetchImpl.mock.calls[2]?.[0]?.toString()).toBe("https://api.stage.omnipack.tech/fulfilment-requests");
  });

  it("does not leak Basic Auth, customer PII, or raw provider body through sanitized errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: "BAD_ADDRESS",
      email: "client@example.test",
      phone: "+48000000000",
      street: "Secret 1",
      message: "Customer client@example.test at Secret 1 failed",
    }, { ok: false, status: 400 }));
    const client = createOmnipackClient(config, fetchImpl as typeof fetch);

    let sanitized: ReturnType<typeof sanitizeOmnipackProviderError> | null = null;
    try {
      await client.createOrder(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest);
    } catch (error) {
      sanitized = sanitizeOmnipackProviderError(error);
    }

    expect(sanitized).toEqual({
      code: "BAD_ADDRESS",
      mayHaveSucceeded: false,
      message: "OmniPack request failed: createOrder",
      operation: "createOrder",
      retryable: false,
      status: 400,
    });
    expect(JSON.stringify(sanitized)).not.toContain("client@example.test");
    expect(JSON.stringify(sanitized)).not.toContain("+48000000000");
    expect(JSON.stringify(sanitized)).not.toContain("Secret 1");
    expect(JSON.stringify(sanitized)).not.toContain("stage-pass");
  });
});

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  } as Response;
}
