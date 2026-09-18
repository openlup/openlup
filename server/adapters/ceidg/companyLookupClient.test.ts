import { describe, expect, it, vi } from "vitest";

import {
  createCeidgInvoiceDataLookupPort,
  mapCeidgLookupResponse,
  readCeidgLookupConfig,
} from "./companyLookupClient.js";

const request = { taxId: "1181590588", country: "PL" as const, providerKind: "ceidg_v3" };

// Trimmed shape mirroring the real CEIDG v3 /firmy?nip= payload.
const CEIDG_FIRMA = {
  firmy: [
    {
      id: "00000000-0000-0000-0000-000000000000",
      nazwa: "Zero to One Bartłomiej Roszkowski",
      status: "AKTYWNY",
      wlasciciel: { imie: "Bartłomiej", nazwisko: "Roszkowski", nip: "1181590588", regon: "147460466" },
      adresDzialalnosci: {
        ulica: "Powstania Styczniowego",
        budynek: "3",
        kod: "05-074",
        miasto: "Halinów",
        kraj: "Polska",
      },
    },
  ],
};

describe("CEIDG company lookup adapter", () => {
  it("maps firma.nazwa to the full sole-proprietor legal name", () => {
    const result = mapCeidgLookupResponse(CEIDG_FIRMA, request);
    expect(result).toMatchObject({
      status: "found",
      legalName: "Zero to One Bartłomiej Roszkowski",
      regon: "147460466",
      address: { line1: "Powstania Styczniowego 3", postalCode: "05-074", city: "Halinów", country: "PL" },
    });
  });

  it("prefers the active entry when CEIDG returns historical duplicates", () => {
    const withWithdrawn = {
      firmy: [
        { nazwa: "Old Name Bartłomiej Roszkowski", status: "WYKRESLONY", adresDzialalnosci: CEIDG_FIRMA.firmy[0].adresDzialalnosci, wlasciciel: { regon: "147460466" } },
        CEIDG_FIRMA.firmy[0],
      ],
    };
    expect(mapCeidgLookupResponse(withWithdrawn, request).legalName).toBe("Zero to One Bartłomiej Roszkowski");
  });

  it("returns not_found for an empty result set", () => {
    expect(mapCeidgLookupResponse({ firmy: [] }, request).status).toBe("not_found");
    expect(mapCeidgLookupResponse(null, request).status).toBe("not_found");
  });

  it("only configures with a token", () => {
    expect(readCeidgLookupConfig({})).toBeNull();
    const config = readCeidgLookupConfig({ CEIDG_API_TOKEN: "jwt-token" });
    expect(config).toMatchObject({ apiToken: "jwt-token", providerKind: "ceidg_v3" });
    expect(config?.baseUrl).toContain("dane.biznes.gov.pl");
  });

  it("sends the NIP query with a Bearer token and parses the response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(CEIDG_FIRMA), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const port = createCeidgInvoiceDataLookupPort(
      { baseUrl: "https://dane.biznes.gov.pl/api/ceidg/v3", apiToken: "jwt-token", timeoutMs: 5_000, providerKind: "ceidg_v3" },
      fetchImpl as unknown as typeof fetch,
    );
    const result = await port.lookupInvoiceData(request);
    expect(result.legalName).toBe("Zero to One Bartłomiej Roszkowski");
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(calledUrl)).toContain("/firmy?nip=1181590588");
    expect(calledInit.headers).toMatchObject({ Authorization: "Bearer jwt-token" });
  });
});
