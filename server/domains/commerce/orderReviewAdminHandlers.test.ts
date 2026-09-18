import { describe, expect, it } from "vitest";
import { createOrderReviewAdminHandlers } from "./orderReviewAdminHandlers.js";

describe("order review admin handlers", () => {
  it("rejects an absent actor before querying", async () => {
    const handlers = createOrderReviewAdminHandlers({} as never, {
      list: async () => { throw new Error("must not run"); },
      read: async () => { throw new Error("must not run"); },
    });
    await expect(handlers.list("", {})).resolves.toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("bounds list page size", async () => {
    const handlers = createOrderReviewAdminHandlers({} as never, {
      list: async (input) => ({ items: [], nextCursor: String(input.limit) }),
      read: async () => null,
    });
    await expect(handlers.list("operator:1", { limit: 999 })).resolves.toMatchObject({ ok: true, value: { nextCursor: "100" } });
  });

  it("uses exact admin read rather than cursor/list inference", async () => {
    const read = async (input: { actorRef: string; reviewRef: string }) => input.reviewRef === "order-review:22222222-2222-4222-8222-222222222222"
      ? { review: { contractVersion: "commerce.order-review.v1" as const, reviewRef: input.reviewRef, rating: 5, comment: null, moderation: "pending" as const, createdAt: "2026-08-16T00:00:00.000Z" }, media: [] }
      : null;
    const handlers = createOrderReviewAdminHandlers({} as never, { list: async () => ({ items: [] }), read });
    await expect(handlers.read("operator:1", "order-review:22222222-2222-4222-8222-222222222222")).resolves.toMatchObject({ ok: true });
    await expect(handlers.read("operator:1", "not-a-review")).resolves.toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("rejects malformed revoke input before persistence", async () => {
    const revoke = async () => { throw new Error("must not run"); };
    const handlers = createOrderReviewAdminHandlers({ revoke } as never, { list: async () => ({ items: [] }), read: async () => null });
    await expect(handlers.revoke("operator:1", { reviewRef: "wrong", idempotencyKey: "x" })).resolves.toEqual({ ok: false, error: { kind: "invalid" } });
  });
});
