import { describe, expect, it, vi } from "vitest";
import { inventoryAtpRequestSchema } from "../../src/domains/inventory/contracts.js";
import { companyIdentityLookupRequestSchema, isValidCompanyIdentifier } from "../../src/domains/company-identity/companyIdentityContracts.js";
import { companyIdentityLookupRequestSchema as coreLookupSchema } from "@openlup/core/company-identity";
import { createAdminInventoryAtpCheckRouteHandler } from "../bff/admin/inventory/atp-check.js";
import type { VercelRequest, VercelResponse } from "./types/vercel.js";

const atpRequest = {
  contractVersion: "inventory.v0", requestedAt: "2026-09-26T00:00:00Z", orderMode: "one_time",
  lines: [{ skuId: "00000000-0000-4000-8000-000000000001", sku: "EXAMPLE", quantity: 1 }],
};

describe("shared core schemas and local configuration", () => {
  it("admits open regions without inventing a country when omitted", () => {
    expect(inventoryAtpRequestSchema.parse(atpRequest).region).toBeUndefined();
    expect(inventoryAtpRequestSchema.parse({ ...atpRequest, region: " EU-NORTH " }).region).toBe("EU-NORTH");
    expect(inventoryAtpRequestSchema.safeParse({ ...atpRequest, region: "" }).success).toBe(false);
  });

  it.each([
    [" EU-NORTH ", undefined, "EU-NORTH"],
    ["EU-NORTH", "DE", "DE"],
    [undefined, undefined, undefined],
  ])("uses region configuration %s and explicit input %s", async (configured, explicit, expected) => {
    const checkAtp = vi.fn().mockResolvedValue({
      contractVersion: "inventory.v0", status: "fulfillable", reason: null,
      locationId: null, locationCode: null, lines: [],
    });
    const handler = createAdminInventoryAtpCheckRouteHandler(
      () => ({ readPort: { checkAtp }, authorizeAdmin: async () => ({ ok: true, userId: "fixture-admin" }) }) as never,
      { INVENTORY_REGION: configured },
    );
    const res = response();
    await handler({ method: "POST", body: { ...atpRequest, ...(explicit ? { region: explicit } : {}) }, headers: {}, query: {} } as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(checkAtp).toHaveBeenCalledWith(expect.objectContaining({ region: expected }));
  });

  it("refuses malformed configured regions before the inventory port", async () => {
    const checkAtp = vi.fn();
    const handler = createAdminInventoryAtpCheckRouteHandler(
      () => ({ readPort: { checkAtp }, authorizeAdmin: async () => ({ ok: true, userId: "fixture-admin" }) }) as never,
      { INVENTORY_REGION: " " },
    );
    const res = response();
    await handler({ method: "POST", body: atpRequest, headers: {}, query: {} } as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(checkAtp).not.toHaveBeenCalled();
  });

  it("preserves registry extensions and national normalization outside core", () => {
    const request = { country: " pl ", identifierKind: "pl_nip", identifierValue: "123-456-32-18", purpose: "checkout_invoice" };
    expect(coreLookupSchema.parse(request).identifierValue).toBe("123-456-32-18");
    const parsed = companyIdentityLookupRequestSchema.parse({ ...request,
      manualCompany: { legalName: "Example Company", registeredAddress: null, regon: "123456789", vatStatus: "active" },
    });
    expect(parsed.identifierValue).toBe("1234563218");
    expect(parsed.manualCompany).toMatchObject({ country: "PL", identifierValue: "1234563218",
      identifierKind: "pl_nip", registryStatus: "manual", regon: "123456789", vatStatus: "active" });
    expect(isValidCompanyIdentifier("PL", "pl_nip", "1234563218")).toBe(true);
    expect(isValidCompanyIdentifier("PL", "pl_nip", "1234563219")).toBe(false);
    expect(companyIdentityLookupRequestSchema.safeParse({ ...request, unexpected: true }).success).toBe(false);
    expect(companyIdentityLookupRequestSchema.safeParse({ ...request, manualCompany: { unknown: true } }).success).toBe(false);
    expect(companyIdentityLookupRequestSchema.parse({ ...request, country: "DE", identifierKind: "custom", identifierValue: " EXAMPLE-ID " }).identifierValue).toBe("EXAMPLE-ID");
  });
});

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}
