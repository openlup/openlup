import { describe, expect, it } from "vitest";
import { BundleCatalogReadError } from "./bundleCatalogReadPort.js";

describe("bundleCatalogReadPort", () => {
  it("carries a stable error name and message through the read boundary", () => {
    const error = new BundleCatalogReadError("bundle read failed");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BundleCatalogReadError");
    expect(error.message).toBe("bundle read failed");
  });
});
