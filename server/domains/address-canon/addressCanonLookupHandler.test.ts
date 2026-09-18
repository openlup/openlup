import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type {
  AddressCanonLocalitiesLookupResponse,
  AddressCanonPostalCodeLookupResponse,
  AddressCanonStreetsLookupResponse,
} from "../../../src/domains/address-canon/contracts.js";
import type { AddressCanonLookupPort } from "./ports.js";
import {
  createAddressCanonLocalitiesHandler,
  createAddressCanonPostalCodeHandler,
  createAddressCanonStreetsHandler,
} from "./addressCanonLookupHandler.js";

const SOURCE = {
  sourceKind: "gus_teryt",
  status: "active",
  displayName: "GUS TERYT",
  officialUrl: "https://api.stat.gov.pl/Home/TerytApi",
  sourceRevision: null,
  sourceUpdatedAt: null,
} as const;

const POSTAL_RESPONSE: AddressCanonPostalCodeLookupResponse = {
  contractVersion: "address.canon.v1",
  query: { postalCode: "00-001" },
  resolutionLevel: "postal_code",
  sources: [SOURCE],
  candidates: [
    {
      localityId: "11111111-1111-4111-8111-111111111111",
      countryCode: "PL",
      name: "Warszawa",
      tercCode: "1465011",
      simcCode: "0918123",
      municipalityName: "Warszawa",
      municipalityTercCode: "1465011",
      countyName: "Warszawa",
      voivodeshipName: "mazowieckie",
      postalCode: "00-001",
      confidence: "ambiguous",
      resolutionLevel: "postal_code",
      sources: [SOURCE],
    },
  ],
};

describe("address canon lookup handlers", () => {
  it("returns hidden postal-code candidates through the BFF envelope", async () => {
    const port = createPort({ postal: POSTAL_RESPONSE });
    const res = createResponse();

    await createAddressCanonPostalCodeHandler({ lookupPort: port })(
      request("GET", { postalCode: "00-001", limit: "5" }),
      res,
    );

    expect(port.lookupPostalCode).toHaveBeenCalledWith({ postalCode: "00-001", limit: 5 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: POSTAL_RESPONSE });
  });

  it("validates query strings, methods, and response payloads", async () => {
    // Bare five-digit codes are now auto-normalized to NN-NNN, so use a
    // genuinely malformed code (too short) to exercise the 400 path.
    const invalidQuery = createResponse();
    await createAddressCanonPostalCodeHandler({ lookupPort: createPort({}) })(
      request("GET", { postalCode: "0001" }),
      invalidQuery,
    );

    const method = createResponse();
    await createAddressCanonPostalCodeHandler({ lookupPort: createPort({}) })(
      request("POST"),
      method,
    );

    const invalidResponse = createResponse();
    await createAddressCanonPostalCodeHandler({
      lookupPort: createPort({ postal: { ...POSTAL_RESPONSE, providerPayload: {} } }),
    })(request("GET", { postalCode: "00-001" }), invalidResponse);

    expect(invalidQuery.status).toHaveBeenCalledWith(400);
    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalidResponse.status).toHaveBeenCalledWith(502);
  });

  it("caps locality and street lookup inputs before calling the port", async () => {
    const localities: AddressCanonLocalitiesLookupResponse = {
      contractVersion: "address.canon.v1",
      query: { q: "War" },
      resolutionLevel: "locality",
      sources: [SOURCE],
      candidates: [],
    };
    const streets: AddressCanonStreetsLookupResponse = {
      contractVersion: "address.canon.v1",
      query: { localityId: "11111111-1111-4111-8111-111111111111", q: "Pro" },
      resolutionLevel: "street",
      sources: [SOURCE],
      streets: [],
    };
    const port = createPort({ localities, streets });

    await createAddressCanonLocalitiesHandler({ lookupPort: port })(
      request("GET", { q: "War", limit: "20" }),
      createResponse(),
    );
    await createAddressCanonStreetsHandler({ lookupPort: port })(
      request("GET", {
        localityId: "11111111-1111-4111-8111-111111111111",
        q: "Pro",
        limit: "50",
      }),
      createResponse(),
    );

    expect(port.searchLocalities).toHaveBeenCalledWith({ q: "War", limit: 20 });
    expect(port.listStreets).toHaveBeenCalledWith({
      localityId: "11111111-1111-4111-8111-111111111111",
      q: "Pro",
      limit: 50,
    });
  });
});

function request(method: string, query: Record<string, string> = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(overrides: {
  postal?: unknown;
  localities?: unknown;
  streets?: unknown;
}): AddressCanonLookupPort {
  return {
    lookupPostalCode: vi.fn().mockResolvedValue(overrides.postal ?? POSTAL_RESPONSE),
    searchLocalities: vi.fn().mockResolvedValue(overrides.localities ?? {}),
    listStreets: vi.fn().mockResolvedValue(overrides.streets ?? {}),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
