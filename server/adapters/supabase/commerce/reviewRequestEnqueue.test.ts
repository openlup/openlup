import { describe, expect, it, vi } from "vitest";
import { createSupabaseReviewRequestEnqueuePort } from "./reviewRequestEnqueue.js";

describe("createSupabaseReviewRequestEnqueuePort", () => {
  it("maps both review enqueue RPC counts", async () => {
    const rpc = vi.fn((name: string) =>
      Promise.resolve({ data: name === "enqueue_review_requests" ? 7 : 2, error: null }),
    );
    const port = createSupabaseReviewRequestEnqueuePort({ rpc });

    await expect(port.enqueueRequests(200)).resolves.toBe(7);
    await expect(port.enqueueEffects(200)).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith("enqueue_review_requests", { p_limit: 200 });
    expect(rpc).toHaveBeenCalledWith("enqueue_review_effects", { p_limit: 200 });
  });

  it("throws sanitized RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(createSupabaseReviewRequestEnqueuePort({ rpc }).enqueueRequests(10)).rejects.toThrow("boom");
  });
});
