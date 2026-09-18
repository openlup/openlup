import { describe, expect, it } from "vitest";
import { readCustomerJourneyEvidence } from "./customerJourneyEvidenceStatus.js";

describe("customer journey evidence status", () => {
  it("distinguishes observed emptiness, a source cap, and a failed query", async () => {
    await expect(readCustomerJourneyEvidence("checkout_outbox", Promise.resolve({ data: [], error: null }), 20))
      .resolves.toMatchObject({ state: "observed_empty", warning: null });
    await expect(readCustomerJourneyEvidence("checkout_outbox", Promise.resolve({ data: [{ id: "event" }], error: null }), 1))
      .resolves.toMatchObject({ state: "windowed", warning: "evidence_window_limited:checkout_outbox" });
    await expect(readCustomerJourneyEvidence("checkout_outbox", Promise.resolve({ data: null, error: { message: "connection failed" } }), 20))
      .resolves.toMatchObject({ state: "unavailable", value: [], warning: "evidence_unavailable:checkout_outbox" });
    await expect(readCustomerJourneyEvidence("checkout_outbox", Promise.resolve({ data: null, error: null }), 20))
      .resolves.toMatchObject({ state: "unavailable", value: [], warning: "evidence_unavailable:checkout_outbox" });
  });
});
