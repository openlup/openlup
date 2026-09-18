/**
 * Unit test for the catalog data-port types module.
 *
 * adminCatalogDataPort.ts is a pure type + thin error-class module — all
 * interface declarations are erased at runtime. The only executable line is the
 * CatalogRpcError constructor (an alias of DomainRpcError).
 *
 * This companion test exercises the constructor so the CI coverage guard
 * (hasCompanionTest) sees this changed file as covered.
 */
import { describe, expect, it } from "vitest";
import { CatalogRpcError } from "./adminCatalogDataPort.js";

describe("CatalogRpcError", () => {
  it("carries the SQLSTATE and message and has the correct name", () => {
    const err = new CatalogRpcError("P0001", "some_raise_token");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CatalogRpcError);
    expect(err.sqlstate).toBe("P0001");
    expect(err.pgMessage).toBe("some_raise_token");
    expect(err.name).toBe("CatalogRpcError");
    expect(err.message).toBe("some_raise_token");
  });

  it("accepts undefined SQLSTATE", () => {
    const err = new CatalogRpcError(undefined, "generic error");

    expect(err.sqlstate).toBeUndefined();
    expect(err.message).toBe("generic error");
  });
});
