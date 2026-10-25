import { describe, expect, it, vi } from "vitest";
import { createOrderReviewHandlers } from "../../src/commerce/server/index.js";
import { createOrderReviewAdminHandlers } from "../../src/commerce/server/index.js";
import { createPostgresOrderReviewLifecyclePort, createPostgresOrderReviewAdminReadPort } from "../../src/commerce/server/index.js";

// Package conformance: compose real handlers and native receipt validation.
// Fake DB receipts do not claim SQL execution or simulate database transitions.
const ID = "11111111-1111-4111-8111-111111111111", grant = `review-grant:${ID}`;
const reviewRef = `order-review:${ID}`, mediaRef = `order-review-media:${ID}`;
const review = { contractVersion: "commerce.order-review.v1" as const, reviewRef, rating: 5, comment: "Example",
  moderation: "pending" as const, createdAt: "2026-10-22T10:00:00Z" };
const observed = { mediaRef, declaredContentType: "image/png", declaredByteLength: 20,
  observedContentType: "image/png", observedByteLength: 20, observedDigest: "c".repeat(64) };
function fixture(receipts: unknown[]) {
  const query = vi.fn();
  for (const response of receipts) query.mockResolvedValueOnce({ rows: [{ response }] });
  const executor = { query };
  const port = createPostgresOrderReviewLifecyclePort(executor as never);
  return { query, customer: createOrderReviewHandlers(port),
    admin: createOrderReviewAdminHandlers(port, createPostgresOrderReviewAdminReadPort(executor as never)) };
}
describe("commerce review and media visibility characterization", () => {
  it("carries pending creation and subsequent eligible read through native receipt validation", async () => {
    const f = fixture([{ ...review, replayed: false }, { review, media: [] }]);
    expect(await f.customer.submit({ grant, rating: 5, comment: "  Example  ", fingerprint: "a".repeat(64) }))
      .toEqual({ ok: true, value: review, replayed: false });
    expect(await f.customer.read(grant)).toEqual({ ok: true, value: { review, media: [] } });
    expect(f.query.mock.calls).toEqual([
      ["SELECT public.order_review_submit($1::text,$2::integer,$3::text,$4::text,now()) AS response", [grant, 5, "Example", "a".repeat(64)]],
      ["SELECT public.order_review_read($1::text, now()) AS response", [grant]],
    ]);
  });
  it("projects publish and hide receipts without conflating moderation with grant revocation", async () => {
    const visible = { ...review, moderation: "visible" }, hidden = { ...review, moderation: "hidden" };
    const f = fixture([{ ...visible, replayed: false }, { ...hidden, replayed: true }]);
    expect(await f.admin.moderate("operator", { reviewRef, action: "publish", idempotencyKey: "publish-example" }))
      .toEqual({ ok: true, value: visible, replayed: false });
    expect(await f.admin.moderate("operator", { reviewRef, action: "hide", idempotencyKey: "hide-example" }))
      .toEqual({ ok: true, value: hidden, replayed: true });
    expect(f.query.mock.calls.map(([, args]) => args)).toEqual([
      [reviewRef, "publish", "operator", "publish-example"], [reviewRef, "hide", "operator", "hide-example"]]);
  });
  it("carries revocation and unavailable read without projecting a public review", async () => {
    const f = fixture([{ replayed: true }, null]);
    expect(await f.admin.revoke("operator", { reviewRef, idempotencyKey: "revoke-example" }))
      .toEqual({ ok: true, value: { replayed: true }, replayed: true });
    expect(await f.customer.read(grant)).toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(f.query.mock.calls[0]).toEqual(["SELECT public.order_review_revoke_access($1::text,$2::text,$3::text,now()) AS response",
      [reviewRef, "operator", "revoke-example"]]);
  });
  it("admits confirmed observed media but refuses a confirmed receipt with only pending declarations", async () => {
    const stored = { ...observed, state: "stored" }, confirmed = { ...observed, state: "confirmed" };
    const f = fixture([{ review, media: [stored] }, { ...confirmed, replayed: true },
      { ...confirmed, observedDigest: null, observedByteLength: null, observedContentType: null }]);
    expect(await f.customer.read(grant)).toEqual({ ok: true, value: { review, media: [stored] } });
    const input = { grant, mediaRef, digest: observed.observedDigest, commandKey: "confirm-example" };
    expect(await f.customer.confirmMedia(input)).toEqual({ ok: true, value: confirmed, replayed: true });
    expect(await f.customer.confirmMedia(input)).toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(f.query.mock.calls[1]).toEqual(["SELECT public.order_review_confirm_media($1::text,$2::text,$3::text,$4::text,now()) AS response",
      [grant, mediaRef, observed.observedDigest, "confirm-example"]]);
  });
});
