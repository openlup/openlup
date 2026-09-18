import { describe, expect, it } from "vitest";
import { createPostgresOrderReviewAdminReadPort, createPostgresOrderReviewLifecyclePort } from "./orderReviewLifecycle.js";

const GRANT = "review-grant:11111111-1111-4111-8111-111111111111";
const REVIEW = { contractVersion: "commerce.order-review.v1", reviewRef: "order-review:22222222-2222-4222-8222-222222222222", rating: 5, comment: null, moderation: "pending", createdAt: "2026-08-16T00:00:00.000Z" };
const MEDIA = { mediaRef: "order-review-media:33333333-3333-4333-8333-333333333333", declaredContentType: "image/png", declaredByteLength: 24,
  observedContentType: "image/png", observedByteLength: 24, observedDigest: "a".repeat(64), state: "confirmed" };

describe("postgres order review lifecycle", () => {
  it("uses the private read routine and maps no-row to unavailable", async () => {
    const queries: string[] = [];
    const port = createPostgresOrderReviewLifecyclePort({ query: async (sql) => { queries.push(sql); return { rows: [{ response: null }] }; } });
    await expect(port.read(GRANT)).resolves.toBeNull();
    expect(queries[0]).toContain("public.order_review_read");
  });

  it("preserves a valid grant with no review as a successful nullable read", async () => {
    const port = createPostgresOrderReviewLifecyclePort({ query: async () => ({ rows: [{ response: { review: null, media: [] } }] }) });
    await expect(port.read(GRANT)).resolves.toEqual({ review: null, media: [] });
  });

  it("parses bounded customer media without storage locators", async () => {
    const port = createPostgresOrderReviewLifecyclePort({ query: async () => ({ rows: [{ response: { review: REVIEW, media: [MEDIA] } }] }) });
    await expect(port.read(GRANT)).resolves.toEqual({ review: REVIEW, media: [MEDIA] });
  });

  it("preserves exact replay from the submit routine", async () => {
    const { comment: _omitted, ...databaseReview } = REVIEW;
    const port = createPostgresOrderReviewLifecyclePort({ query: async () => ({ rows: [{ response: { ...databaseReview, replayed: true } }] }) });
    await expect(port.submit({ grant: GRANT, rating: 5, fingerprint: "a".repeat(64) })).resolves.toMatchObject({ replayed: true, value: REVIEW });
  });

  it("maps null mutation rows to unavailable instead of invalid input", async () => {
    const port = createPostgresOrderReviewLifecyclePort({ query: async () => ({ rows: [{ response: null }] }) });
    await expect(port.submit({ grant: GRANT, rating: 5, fingerprint: "a".repeat(64) })).rejects.toMatchObject({ code: "order_review_unavailable" });
    await expect(port.createMediaIntent({ grant: GRANT, contentType: "image/png", byteLength: 24,
      capabilityDigest: "a".repeat(64), commandKey: "intent:1" })).rejects.toMatchObject({ code: "order_review_unavailable" });
    await expect(port.confirmMedia({ grant: GRANT, mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222",
      digest: "a".repeat(64), commandKey: "confirm:1" })).rejects.toMatchObject({ code: "order_review_unavailable" });
  });

  it("uses exact private admin list/read routines", async () => {
    const queries: string[] = [];
    const port = createPostgresOrderReviewAdminReadPort({ query: async (sql) => {
      queries.push(sql);
      return { rows: [{ response: sql.includes("_list") ? { items: [REVIEW], nextCursor: "next" } : { review: REVIEW, media: [MEDIA] } }] };
    } });
    await expect(port.list({ actorRef: "operator:1", limit: 25 })).resolves.toMatchObject({ items: [REVIEW], nextCursor: "next" });
    await expect(port.read({ actorRef: "operator:1", reviewRef: REVIEW.reviewRef })).resolves.toEqual({ review: REVIEW, media: [MEDIA] });
    expect(queries).toEqual([expect.stringContaining("order_review_admin_list"), expect.stringContaining("order_review_admin_read")]);
  });
});
