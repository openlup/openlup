import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import {
  lookupAddressCanonLocalities,
  lookupAddressCanonPostalCode,
  lookupAddressCanonStreets,
} from "./addressCanonClient";

const EMPTY_POSTAL_RESPONSE = {
  contractVersion: "address.canon.v1" as const,
  query: { postalCode: "00-001" },
  resolutionLevel: "postal_code" as const,
  candidates: [],
  sources: [],
};

describe("address canon client", () => {
  beforeEach(() => {
    requestBff.mockReset();
    requestBff.mockResolvedValue(EMPTY_POSTAL_RESPONSE);
  });

  it("GETs postal-code candidates with capped query params", async () => {
    await lookupAddressCanonPostalCode({ postalCode: "00-001", limit: 10 });

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/address-canon/postal-code?postalCode=00-001&limit=10");
    expect(options.method).toBe("GET");
  });

  it("GETs locality candidates with encoded query params", async () => {
    await lookupAddressCanonLocalities({ q: "Warszawa Mokotow", limit: 5 });

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/address-canon/localities?q=Warszawa+Mokotow&limit=5");
    expect(options.method).toBe("GET");
  });

  it("GETs street candidates with optional prefix query", async () => {
    await lookupAddressCanonStreets({
      localityId: "11111111-1111-1111-1111-111111111111",
      q: "Prosta",
      limit: 20,
    });

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe(
      "/api/bff/address-canon/streets?localityId=11111111-1111-1111-1111-111111111111&limit=20&q=Prosta",
    );
    expect(options.method).toBe("GET");
  });
});
