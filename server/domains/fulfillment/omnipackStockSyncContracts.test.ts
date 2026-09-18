import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  OmnipackInventoryClass,
  OmnipackStockMismatchKind,
  OmnipackStockSyncResult,
} from "./omnipackStockSyncContracts.js";

describe("OmniPack stock sync contracts", () => {
  it("keeps stock classification and mismatch vocabulary closed", () => {
    const inventoryClasses: OmnipackInventoryClass[] = ["sellable", "packaging"];
    const mismatch: OmnipackStockMismatchKind = "none";

    expect(inventoryClasses).toEqual(["sellable", "packaging"]);
    expect(mismatch).toBe("none");
    expectTypeOf<OmnipackStockSyncResult["reservationCoverage"]>().toEqualTypeOf<number>();
  });
});
