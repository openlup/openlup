import { expect, it } from "vitest";
import * as contracts from "../../src/account-support/contracts/index.js";

it("exposes only types", () => {
  expect(Object.keys(contracts)).toEqual([]);
});
