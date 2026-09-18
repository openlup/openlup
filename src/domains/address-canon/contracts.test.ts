import { describe, expect, it } from "vitest";
import {
  ADDRESS_CANON_CONTRACT_VERSION,
  addressCanonPostalCodeLookupResponseSchema,
} from "./contracts";

const SOURCE = {
  sourceKind: "gus_teryt",
  status: "active",
  displayName: "GUS TERYT",
  officialUrl: "https://api.stat.gov.pl/Home/TerytApi",
  sourceRevision: "2026-06",
  sourceUpdatedAt: "2026-06-06T00:00:00.000+02:00",
} as const;

describe("address canon contracts", () => {
  it("accepts provider-neutral postal-code candidates with provenance", () => {
    const parsed = addressCanonPostalCodeLookupResponseSchema.parse({
      contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
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
    });

    expect(parsed.candidates[0]?.confidence).toBe("ambiguous");
  });

  it("auto-normalizes bare five-digit Polish postal codes to NN-NNN", () => {
    const result = addressCanonPostalCodeLookupResponseSchema.safeParse({
      contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
      query: { postalCode: "00001" },
      resolutionLevel: "postal_code",
      sources: [SOURCE],
      candidates: [],
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.query.postalCode).toBe("00-001");
  });

  it("rejects raw payload leakage and genuinely malformed postal codes", () => {
    expect(
      addressCanonPostalCodeLookupResponseSchema.safeParse({
        contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
        query: { postalCode: "00-001" },
        resolutionLevel: "postal_code",
        sources: [SOURCE],
        providerPayload: {},
        candidates: [],
      }).success,
    ).toBe(false);

    expect(
      addressCanonPostalCodeLookupResponseSchema.safeParse({
        contractVersion: ADDRESS_CANON_CONTRACT_VERSION,
        query: { postalCode: "0001" },
        resolutionLevel: "postal_code",
        sources: [SOURCE],
        candidates: [],
      }).success,
    ).toBe(false);
  });
});
