import { describe, expect, it, vi } from "vitest";

import { finalizePreparedProviderAttempt } from "./preparedProviderAttemptFinalization.js";

describe("prepared provider-attempt finalization", () => {
  it("replays one identical local finalizer after a lost response", async () => {
    const finalize = vi.fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({ paymentAttemptId: "attempt-1" });

    await expect(finalizePreparedProviderAttempt(finalize)).resolves.toEqual({
      paymentAttemptId: "attempt-1",
    });
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls[0]).toEqual(finalize.mock.calls[1]);
  });

  it("does not replay a successful finalizer", async () => {
    const finalize = vi.fn().mockResolvedValue({ paymentAttemptId: "attempt-1" });

    await expect(finalizePreparedProviderAttempt(finalize)).resolves.toEqual({
      paymentAttemptId: "attempt-1",
    });
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
