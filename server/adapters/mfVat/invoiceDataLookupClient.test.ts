import { describe, expect, it, vi } from "vitest";

import {
  createMfVatInvoiceDataLookupPort,
  mapMfVatLookupResponse,
  readMfVatLookupConfig,
} from "./invoiceDataLookupClient.js";

const request = { taxId: "1234563218", country: "PL" as const, providerKind: "mf_vat" };

describe("MF VAT invoice data lookup client", () => {
  it("uses the public MF VAT API defaults without secrets", () => {
    expect(readMfVatLookupConfig({})).toMatchObject({
      baseUrl: "https://wl-api.mf.gov.pl",
      timeoutMs: 5000,
      providerKind: "mf_vat_whitelist",
    });
  });

  it("maps a complete MF whitelist response to the provider-neutral contract", () => {
    const mapped = mapMfVatLookupResponse({
      result: {
        subject: {
          name: '"Example Company" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
          nip: "1234563218",
          statusVat: "Czynny",
          regon: "123456789",
          workingAddress: "Example Street 11, 32-091 Example City",
        },
      },
    }, request);

    expect(mapped).toMatchObject({
      status: "found",
      providerKind: "mf_vat_whitelist",
      taxId: "1234563218",
      legalName: '"Example Company" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
      regon: "123456789",
      vatStatus: "active",
      address: {
        line1: "Example Street 11",
        postalCode: "32-091",
        city: "Example City",
        country: "PL",
      },
    });
    expect(mapped.evidenceHash).toMatch(/^sha256:/);
  });

  it("fails closed when MF response has no complete company address", () => {
    expect(mapMfVatLookupResponse({
      result: {
        subject: {
          name: "Missing Address Sp. z o.o.",
          statusVat: "Czynny",
        },
      },
    }, request)).toMatchObject({
      status: "not_found",
      legalName: null,
      address: null,
    });
  });

  it("calls the MF endpoint with canonical NIP and current date", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          subject: {
            name: "Example Company Sp. z o.o.",
            statusVat: "Czynny",
            workingAddress: "Example Street 11, 32-091 Example City",
          },
        },
      }),
    } as Response));
    const port = createMfVatInvoiceDataLookupPort({
      baseUrl: "https://wl-api.example.test",
      timeoutMs: 1000,
      providerKind: "mf_vat_whitelist",
    }, fetchImpl as unknown as typeof fetch);

    await expect(port.lookupInvoiceData(request)).resolves.toMatchObject({ status: "found" });
    const calledUrl = fetchImpl.mock.calls[0]?.[0];
    expect(String(calledUrl)).toMatch(/^https:\/\/wl-api\.example\.test\/api\/search\/nip\/1234563218\?date=\d{4}-\d{2}-\d{2}$/);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
  });
});
