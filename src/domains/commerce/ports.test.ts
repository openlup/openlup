import { expect, it } from "vitest";
import { CommerceOrderDraftPriceChangedError as PackageError } from "@openlup/platform/commerce";
import { CommerceOrderDraftPriceChangedError } from "./ports.js";

it("shares the nominal package error through the reference port facade", () => {
  const error = new CommerceOrderDraftPriceChangedError();
  expect(error).toBeInstanceOf(PackageError);
});
