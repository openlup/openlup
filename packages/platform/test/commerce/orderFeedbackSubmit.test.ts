import { describe, expect, it, vi } from "vitest";
import { createSupabaseOrderFeedbackSubmitPort } from "../../src/commerce/server/orderFeedbackSubmit.js";

describe("orderFeedbackSubmitPort", () => {
  it("submits order feedback through the RPC boundary", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "submitted" }, error: null }));
    const port = createSupabaseOrderFeedbackSubmitPort({ rpc });

    await expect(
      port.submit({ token: "tok_abc123", rating: 5, comment: "Example" }),
    ).resolves.toEqual({ status: "submitted" });

    expect(rpc).toHaveBeenCalledWith("submit_order_feedback", {
      p_token: "tok_abc123",
      p_rating: 5,
      p_comment: "Example",
    });
  });

  it("normalizes an omitted comment to null", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "already_submitted" }, error: null }));
    const port = createSupabaseOrderFeedbackSubmitPort({ rpc });

    await port.submit({ token: "tok_abc123", rating: 4 });

    expect(rpc).toHaveBeenCalledWith("submit_order_feedback", {
      p_token: "tok_abc123",
      p_rating: 4,
      p_comment: null,
    });
  });

  it("throws when the RPC boundary returns an error", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    const port = createSupabaseOrderFeedbackSubmitPort({ rpc });

    await expect(port.submit({ token: "tok_abc123", rating: 1 })).rejects.toThrow("boom");
  });
});
