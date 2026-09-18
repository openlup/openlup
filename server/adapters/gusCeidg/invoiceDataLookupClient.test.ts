import { describe, expect, it, vi } from "vitest";

import {
  createGusCeidgInvoiceDataLookupPort,
  createUnavailableInvoiceDataLookupPort,
  mapGusCeidgLookupResponse,
  readGusCeidgLookupConfig,
} from "./invoiceDataLookupClient.js";

const request = { taxId: "1234563218", country: "PL" as const, providerKind: "gus_ceidg" };

describe("GUS/CEIDG invoice data lookup client", () => {
  it("stays unavailable unless the dedicated real-provider env is complete", () => {
    expect(readGusCeidgLookupConfig({ GUS_CEIDG_LOOKUP_ENABLED: "false" })).toBeNull();
    expect(readGusCeidgLookupConfig({ GUS_CEIDG_LOOKUP_ENABLED: "true" })).toBeNull();

    expect(readGusCeidgLookupConfig({
      GUS_CEIDG_LOOKUP_ENABLED: "true",
      GUS_CEIDG_LOOKUP_BASE_URL: "https://lookup.example.test/",
      GUS_CEIDG_LOOKUP_API_TOKEN: "token",
      GUS_CEIDG_LOOKUP_TIMEOUT_MS: "2500",
    })).toMatchObject({
      baseUrl: "https://lookup.example.test",
      path: "/invoice-data-lookup",
      apiToken: "token",
      timeoutMs: 2500,
      providerKind: "gus_ceidg_http",
    });
  });

  it("maps a complete real-provider payload to the provider-neutral contract", () => {
    const mapped = mapGusCeidgLookupResponse({
      data: {
        nazwa: "Example Company Sp. z o.o.",
        REGON: "123456789",
        statusVat: "czynny",
        adres: {
          ulica: "Example Street",
          nrBudynku: "11",
          kodPocztowy: "32-091",
          miejscowosc: "ExampleCity",
          kraj: "PL",
        },
      },
    }, request);

    expect(mapped).toMatchObject({
      status: "found",
      providerKind: "gus_ceidg_http",
      taxId: "1234563218",
      legalName: "Example Company Sp. z o.o.",
      regon: "123456789",
      vatStatus: "active",
      address: {
        line1: "Example Street 11",
        postalCode: "32-091",
        city: "ExampleCity",
        country: "PL",
      },
    });
    expect(mapped.evidenceHash).toMatch(/^sha256:/);
  });

  it("fails closed as not_found when provider data is incomplete", () => {
    expect(mapGusCeidgLookupResponse({
      data: { legalName: "Missing Address Sp. z o.o." },
    }, request)).toMatchObject({
      status: "not_found",
      legalName: null,
      address: null,
    });
  });

  it("calls the configured server-side lookup endpoint without exposing raw payloads", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          legalName: "Example Company Sp. z o.o.",
          address: { line1: "Example Street 11", postalCode: "32-091", city: "ExampleCity", country: "PL" },
        },
      }),
    } as Response));
    const port = createGusCeidgInvoiceDataLookupPort({
      baseUrl: "https://lookup.example.test",
      path: "/companies",
      apiToken: "secret-token",
      timeoutMs: 1000,
      providerKind: "gus_ceidg_http",
    }, fetchImpl as never);

    await expect(port.lookupInvoiceData(request)).resolves.toMatchObject({ status: "found" });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://lookup.example.test/companies?taxId=1234563218&country=PL" }),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });

  it("returns provider_unavailable from the explicit unavailable port", async () => {
    await expect(
      createUnavailableInvoiceDataLookupPort().lookupInvoiceData(request),
    ).resolves.toMatchObject({ status: "provider_unavailable" });
  });
});
