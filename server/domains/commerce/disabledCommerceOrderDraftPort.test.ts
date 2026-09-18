import { describe, expect, it } from "vitest";
import { createDisabledCommerceOrderDraftPort } from "./disabledCommerceOrderDraftPort.js";

describe("disabled commerce order draft port", () => {
  it("keeps order draft persistence explicitly inactive", async () => {
    await expect(
      createDisabledCommerceOrderDraftPort().createOrderDraft({} as never),
    ).rejects.toMatchObject({
      name: "CommerceNotEnabledError",
      message: "Commerce order draft is not enabled yet",
    });
  });
});
