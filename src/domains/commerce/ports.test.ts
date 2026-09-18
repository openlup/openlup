import { describe, expect, it } from "vitest";
import { CommerceNotEnabledError, CommerceQuoteSnapshotError } from "./ports.js";

describe("commerce ports", () => {
  it("makes disabled commerce features explicit", () => {
    const error = new CommerceNotEnabledError("checkout");
    const orderDraft = new CommerceNotEnabledError("order draft");

    expect(error.name).toBe("CommerceNotEnabledError");
    expect(error.message).toBe("Commerce checkout is not enabled yet");
    expect(orderDraft.message).toBe("Commerce order draft is not enabled yet");
  });

  it("carries quote snapshot mismatch details across the BFF boundary", () => {
    const error = new CommerceQuoteSnapshotError(
      "QUOTE_SNAPSHOT_MISMATCH",
      "Commerce quote snapshot does not match current catalog pricing",
      { sku: "OPENLUP-DOG-DUCK-CAN-400G" },
    );

    expect(error.name).toBe("CommerceQuoteSnapshotError");
    expect(error.code).toBe("QUOTE_SNAPSHOT_MISMATCH");
    expect(error.details).toEqual({ sku: "OPENLUP-DOG-DUCK-CAN-400G" });
  });
});
