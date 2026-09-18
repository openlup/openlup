import { describe, expect, it } from "vitest";
import {
  isChargeBearingIntentStatus,
  resolvePaymentConfirmedAt,
} from "./orderMoneyPaymentEvidence.js";

describe("order money payment evidence", () => {
  it("anchors invoice timing to immutable trusted success evidence", () => {
    expect(isChargeBearingIntentStatus("succeeded")).toBe(true);
    expect(isChargeBearingIntentStatus("pending")).toBe(false);
    expect(resolvePaymentConfirmedAt({
      events: [{ created_at: "2026-07-14T10:00:00.000Z" } as never],
      reconciliations: [],
      attempt: {
        created_at: "2026-07-14T09:59:00.000Z",
        updated_at: "2026-07-14T11:30:00.000Z",
      } as never,
    })).toBe("2026-07-14T10:00:00.000Z");
  });
});
