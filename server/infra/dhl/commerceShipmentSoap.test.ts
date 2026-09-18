import { describe, expect, it, vi } from "vitest";
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
