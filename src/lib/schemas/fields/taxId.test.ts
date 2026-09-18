import { describe, expect, it } from "vitest";
import {
  formatPolishNip,
  isValidPolishNip,
  normalizeOptionalPolishNipForStorage,
  normalizePolishNip,
  routeInvoiceByTaxId,
} from "./taxId.js";

describe("canonical tax id fields", () => {
  it("normalizes and formats Polish NIP", () => {
    expect(normalizePolishNip("123-456-32-18")).toBe("1234563218");
    expect(normalizePolishNip("1234563218")).toBe("1234563218");
    expect(normalizePolishNip("PL1234563218")).toBe("1234563218");
    expect(normalizePolishNip("PL 123-456-32-18")).toBe("1234563218");
    expect(normalizePolishNip("pl-123 456 32 18")).toBe("1234563218");
    expect(formatPolishNip("1234563218")).toBe("123-456-32-18");
    expect(formatPolishNip("123")).toBe("123");
    expect(normalizePolishNip("   ")).toBeNull();
  });

  it("validates Polish NIP checksum", () => {
    expect(isValidPolishNip("1234563218")).toBe(true);
    expect(isValidPolishNip("5130251193")).toBe(false);
    expect(isValidPolishNip("525-000-00-00")).toBe(false);
    expect(isValidPolishNip(null)).toBe(false);
  });

  it("routes invoice handling by tax id presence and checksum", () => {
    expect(routeInvoiceByTaxId(null)).toEqual({
      ok: true,
      documentKind: "b2c_named",
      normalizedTaxId: null,
      governmentClearanceRequired: false,
    });
    expect(routeInvoiceByTaxId("123-456-32-18")).toEqual({
      ok: true,
      documentKind: "b2b_vat",
      normalizedTaxId: "1234563218",
      governmentClearanceRequired: true,
    });
    expect(routeInvoiceByTaxId("PL1234563218")).toEqual({
      ok: true,
      documentKind: "b2b_vat",
      normalizedTaxId: "1234563218",
      governmentClearanceRequired: true,
    });
    expect(routeInvoiceByTaxId("123")).toEqual({
      ok: false,
      reason: "invalid_tax_id",
      normalizedTaxId: "123",
    });
  });

  it("normalizes optional storage values and rejects invalid NIP", () => {
    expect(normalizeOptionalPolishNipForStorage(undefined)).toBeNull();
    expect(normalizeOptionalPolishNipForStorage("123 456 32 18")).toBe("1234563218");
    expect(() => normalizeOptionalPolishNipForStorage("123")).toThrow("invalid_polish_nip");
  });
});
