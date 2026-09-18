import { describe, expect, it } from "vitest";

import { makeDiagnostics, makeStore } from "./outboxDispatchWorkerTestKit.js";

describe("outbox dispatch worker test kit", () => {
  it("keeps the store fake to the neutral four-operation contract", async () => {
    const store = makeStore();

    expect(Object.keys(store).sort()).toEqual([
      "claimBatch",
      "markFailed",
      "markProcessed",
      "releaseUnprocessed",
    ]);
    await expect(store.claimBatch({} as never)).resolves.toEqual([]);
    await expect(store.releaseUnprocessed([{ eventId: "event", claimToken: "token" }], 0)).resolves.toBe(1);
  });

  it("keeps optional queue diagnostics outside the store contract", async () => {
    const diagnostics = makeDiagnostics();

    await expect(diagnostics.queueStats()).resolves.toEqual({ pending: 0 });
  });
});
