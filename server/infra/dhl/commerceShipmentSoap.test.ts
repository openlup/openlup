import { describe, expect, it, vi } from "vitest";
import { CARRIER_DISPLAY_NAME } from "./adminDhlSoap.js";
import {
  createDhlShipmentWithLabel,
  parseStreet,
  sanitizeProviderText,
} from "./commerceShipmentSoap.js";

describe("commerce DHL SOAP adapter", () => {
  it("maps commerce parties into createShipments and fetches a label without exposing credentials", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      if (body.includes("createShipments")) {
        expect(body).toContain("<name>Anna Kowalska</name>");
        expect(body).toContain("<street>Testowa</street>");
        expect(body).toContain("<houseNumber>12</houseNumber>");
        expect(body).toContain("<accountNumber>123456</accountNumber>");
        return response("<shipmentId>DHL123</shipmentId><dispatchIdentificationNumber>DISP1</dispatchIdentificationNumber>");
      }
      expect(body).toContain("<shipmentId>DHL123</shipmentId>");
      return response(`<labelData>${Buffer.from("pdf").toString("base64")}</labelData>`);
    });

    const result = await createDhlShipmentWithLabel({
      auth: { username: "user", password: "secret", accountNumber: "123456" },
      shipper: party({ name: "OPENLUP", street: "Example Street", houseNumber: "11" }),
      receiver: party({ name: "Anna Kowalska", street: "Testowa", houseNumber: "12" }),
      shipmentDate: "2026-06-16",
      fetchImpl: fetchImpl as never,
    });

    expect(result).toMatchObject({ trackingNumber: "DHL123", dispatchId: "DISP1" });
    expect(new TextDecoder().decode(result.labelPdf ?? new Uint8Array())).toBe("pdf");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies SOAP faults as sanitized fatal provider faults", async () => {
    const fetchImpl = vi.fn(async () => response("<faultstring>password=secret Bad receiver</faultstring>"));

    await expect(createDhlShipmentWithLabel({
      auth: { username: "user", password: "secret", accountNumber: "123456" },
      shipper: party({ name: "OPENLUP", street: "Example Street", houseNumber: "11" }),
      receiver: party({ name: "Anna", street: "Testowa", houseNumber: "12" }),
      shipmentDate: "2026-06-16",
      fetchImpl: fetchImpl as never,
    })).rejects.toMatchObject({ retryable: false });
  });

  it("parses Polish street numbers and redacts provider text", () => {
    expect(parseStreet("Długa 12 / 4")).toEqual({ street: "Długa", houseNumber: "12/4" });
    const sanitized = sanitizeProviderText("<xml>username=bart password=secret ada@example.test +48 500 600 700</xml>");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("ada@example.test");
    expect(sanitized).not.toContain("500 600 700");
  });

  it("sets redirect manual and classifies HTTP 429, 408, and 5xx as retryable while 400 and 302 are fatal", async () => {
    for (const [status, expectedRetryable] of [[429, true], [408, true], [503, true], [400, false], [302, false]] as const) {
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response("upstream status", { status });
      });

      await expect(createDhlShipmentWithLabel({
        auth: { username: "user", password: "secret", accountNumber: "123456" },
        shipper: party({ name: "OPENLUP", street: "Example Street", houseNumber: "11" }),
        receiver: party({ name: "Anna", street: "Testowa", houseNumber: "12" }),
        shipmentDate: "2026-06-16",
        fetchImpl: fetchImpl as never,
      })).rejects.toMatchObject({
        name: "DhlProviderFault",
        message: `${CARRIER_DISPLAY_NAME} HTTP ${status}`,
        retryable: expectedRetryable,
      });
    }
  });

  it("propagates caller AbortSignal and classifies timeout/abort as retryable", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      observedSignal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const pending = createDhlShipmentWithLabel({
      auth: { username: "user", password: "secret", accountNumber: "123456" },
      shipper: party({ name: "OPENLUP", street: "Example Street", houseNumber: "11" }),
      receiver: party({ name: "Anna", street: "Testowa", houseNumber: "12" }),
      shipmentDate: "2026-06-16",
      fetchImpl: fetchImpl as never,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort(new Error("outbox aborted"));

    await expect(pending).rejects.toMatchObject({
      name: "DhlProviderFault",
      retryable: true,
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("times out stalled response body reads and rejects oversized responses", async () => {
    const stalledStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<shipmentId>TRK"));
      },
    });
    const stalledFetch = vi.fn(async () => new Response(stalledStream, { status: 200 }));

    await expect(createDhlShipmentWithLabel({
      auth: { username: "user", password: "secret", accountNumber: "123456" },
      shipper: party({ name: "OPENLUP", street: "Example Street", houseNumber: "11" }),
      receiver: party({ name: "Anna", street: "Testowa", houseNumber: "12" }),
      shipmentDate: "2026-06-16",
      fetchImpl: stalledFetch as never,
      timeoutMs: 25,
    })).rejects.toMatchObject({
      name: "DhlProviderFault",
      retryable: true,
    });

    const oversizedFetch = vi.fn(async () => new Response("x".repeat(256), { status: 200 }));
    await expect(createDhlShipmentWithLabel({
      auth: { username: "user", password: "secret", accountNumber: "123456" },
      shipper: party({ name: "OPENLUP", street: "Example Street", houseNumber: "11" }),
      receiver: party({ name: "Anna", street: "Testowa", houseNumber: "12" }),
      shipmentDate: "2026-06-16",
      fetchImpl: oversizedFetch as never,
      maxBodyBytes: 64,
    })).rejects.toMatchObject({
      name: "DhlProviderFault",
      retryable: false,
    });
  });
});

function party(overrides: Partial<Parameters<typeof createDhlShipmentWithLabel>[0]["shipper"]>) {
  return {
    name: "Name",
    street: "Street",
    houseNumber: "1",
    postalCode: "00-001",
    city: "Warszawa",
    country: "PL",
    phone: "+48123456789",
    email: "test@example.com",
    ...overrides,
  };
}

function response(body: string): Response {
  return new Response(body, { status: 200 });
}
