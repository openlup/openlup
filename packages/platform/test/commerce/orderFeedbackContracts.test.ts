import { describe, expect, it } from "vitest";
import {
  ORDER_FEEDBACK_CHECK_RPC_NAME, ORDER_FEEDBACK_SUBMIT_RPC_NAME,
  orderFeedbackSubmitRequestSchema, orderFeedbackSubmitResponseSchema, orderFeedbackSubmitStatusSchema,
  orderFeedbackTokenCheckRequestSchema, orderFeedbackTokenCheckResponseSchema, orderFeedbackTokenCheckStatusSchema,
} from "../../src/commerce/index.js";

describe("hosted feedback contracts (separate from native order reviews)", () => {
  it("pins managed-only RPC names and exact status sets", () => {
    expect(ORDER_FEEDBACK_CHECK_RPC_NAME).toBe("check_order_feedback_token");
    expect(ORDER_FEEDBACK_SUBMIT_RPC_NAME).toBe("submit_order_feedback");
    expect(orderFeedbackTokenCheckStatusSchema.options).toEqual(["ready", "already_submitted", "not_found"]);
    expect(orderFeedbackSubmitStatusSchema.options).toEqual(["submitted", "already_submitted", "not_found"]);
  });
  it("accepts strict responses for every status and refuses cross-lifecycle or extra fields", () => {
    for (const [schema, statuses] of [
      [orderFeedbackTokenCheckResponseSchema, orderFeedbackTokenCheckStatusSchema.options],
      [orderFeedbackSubmitResponseSchema, orderFeedbackSubmitStatusSchema.options],
    ] as const) {
      for (const status of statuses) {
        expect(schema.parse({ status })).toEqual({ status });
        expect(schema.safeParse({ status, review: {} }).success).toBe(false);
      }
      for (const status of ["pending", "visible", "hidden", "revoked", "unknown", null]) {
        expect(schema.safeParse({ status }).success).toBe(false);
      }
    }
    expect(orderFeedbackTokenCheckResponseSchema.safeParse({ status: "submitted" }).success).toBe(false);
    expect(orderFeedbackSubmitResponseSchema.safeParse({ status: "ready" }).success).toBe(false);
  });
  it("bounds opaque tokens, rating, optional comment and refuses untrusted extra keys", () => {
    expect(orderFeedbackTokenCheckRequestSchema.parse({ token: "opaque-token" })).toEqual({ token: "opaque-token" });
    expect(orderFeedbackSubmitRequestSchema.parse({ token: "opaque-token", rating: 5 })).toEqual({ token: "opaque-token", rating: 5 });
    expect(orderFeedbackSubmitRequestSchema.parse({ token: "a".repeat(128), rating: 1, comment: "a".repeat(2000) }).comment).toHaveLength(2000);
    expect(orderFeedbackSubmitRequestSchema.parse({ token: "opaque-token", rating: 4, comment: "" }).comment).toBe("");
    for (const token of ["", "a".repeat(129), null]) {
      expect(orderFeedbackTokenCheckRequestSchema.safeParse({ token }).success).toBe(false);
      expect(orderFeedbackSubmitRequestSchema.safeParse({ token, rating: 3 }).success).toBe(false);
    }
    expect(orderFeedbackTokenCheckRequestSchema.safeParse({ token: "opaque-token", actorRef: "operator" }).success).toBe(false);
    for (const input of [{ rating: 0 }, { rating: 6 }, { rating: 1.5 }, { rating: 4, comment: "a".repeat(2001) }, { rating: 4, grant: "native-grant" }]) {
      expect(orderFeedbackSubmitRequestSchema.safeParse({ token: "opaque-token", ...input }).success).toBe(false);
    }
  });
});
