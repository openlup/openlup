import { describe, expect, it, vi } from "vitest";
import { createSupabaseOrderFeedbackTokenCheckPort } from "../../src/commerce/server/orderFeedbackTokenCheck.js";

describe("orderFeedbackTokenCheckPort", () => {
  it("checks token state through the read-only RPC boundary", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "ready" }, error: null }));
    const port = createSupabaseOrderFeedbackTokenCheckPort({ rpc });

    await expect(port.check({ token: "tok_abc123" })).resolves.toEqual({ status: "ready" });
    expect(rpc).toHaveBeenCalledWith("check_order_feedback_token", { p_token: "tok_abc123" });
  });

  it("throws when the RPC boundary returns an error", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    const port = createSupabaseOrderFeedbackTokenCheckPort({ rpc });

    await expect(port.check({ token: "tok_abc123" })).rejects.toThrow("boom");
  });
});
