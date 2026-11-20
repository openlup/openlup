import { expect, it } from "vitest";
import * as facade from "./orderMoney.js";
import * as commerce from "@openlup/platform/commerce";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "ORDER_HEADER_MONEY_COLUMNS",
    "ORDER_ITEM_MONEY_COLUMNS",
    "deriveOrderMoney",
    "emitOrderMoneyDiagnostic",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
});
