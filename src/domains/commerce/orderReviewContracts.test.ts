import { describe, expect, it } from "vitest";
import {
  orderReviewMediaSchema,
  orderReviewAdminDetailSchema,
  orderReviewReadResultSchema,
  orderReviewMediaIntentResultSchema,
  orderReviewMediaIntentSchema,
  orderReviewSubmitSchema,
} from "./orderReviewContracts.js";

const GRANT = "review-grant:11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);

describe("order review contracts", () => {
  it("accepts bounded neutral review and media commands", () => {
    expect(orderReviewSubmitSchema.parse({ grant: GRANT, rating: 5, fingerprint: DIGEST }).rating).toBe(5);
    expect(orderReviewMediaIntentSchema.parse({
      grant: GRANT, contentType: "image/png", byteLength: 20 * 1024 * 1024,
      capabilityDigest: DIGEST, commandKey: "review.media.1",
    }).contentType).toBe("image/png");
  });

  it("distinguishes an eligible first submission from an existing review", () => {
    expect(orderReviewReadResultSchema.parse({ review: null, media: [] })).toEqual({ review: null, media: [] });
  });

  it("bounds discoverable media and rejects server-only locators", () => {
    const review = { contractVersion: "commerce.order-review.v1", reviewRef: "order-review:22222222-2222-4222-8222-222222222222",
      rating: 5, comment: null, moderation: "pending", createdAt: "2026-08-16T00:00:00.000Z" };
    expect(orderReviewAdminDetailSchema.parse({ review, media: [] })).toEqual({ review, media: [] });
    expect(() => orderReviewAdminDetailSchema.parse({ review, media: [], objectKey: "review/private" })).toThrow();
    expect(() => orderReviewAdminDetailSchema.parse({ review, media: Array.from({ length: 11 }, () => ({
      mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222", declaredContentType: "image/png",
      declaredByteLength: 24, observedContentType: null, observedByteLength: null, observedDigest: null, state: "pending",
    })) })).toThrow();
  });

  it("rejects an oversized media declaration and non-opaque grant", () => {
    expect(() => orderReviewMediaIntentSchema.parse({
      grant: "order:1", contentType: "image/png", byteLength: 20 * 1024 * 1024 + 1,
      capabilityDigest: DIGEST, commandKey: "review.media.1",
    })).toThrow();
  });

  it("never permits clear upload capability in the BFF result", () => {
    const media = {
      mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222",
      declaredContentType: "image/png",
      declaredByteLength: 24,
      observedContentType: null,
      observedByteLength: null,
      observedDigest: null,
      state: "pending",
    };
    expect(orderReviewMediaIntentResultSchema.parse({
      media, uploadExpiresAt: "2026-08-16T00:00:00.000Z", replayed: false,
    })).toMatchObject({ media });
    expect(() => orderReviewMediaIntentResultSchema.parse({
      media, uploadCapability: "order-review-upload:22222222-2222-4222-8222-222222222222",
      uploadExpiresAt: "2026-08-16T00:00:00.000Z", replayed: false,
    })).toThrow();
  });

  it("requires an observed hash only after bytes were stored", () => {
    const base = {
      mediaRef: "order-review-media:22222222-2222-4222-8222-222222222222",
      declaredContentType: "image/png" as const,
      declaredByteLength: 24,
    };
    expect(orderReviewMediaSchema.parse({ ...base, state: "pending", observedContentType: null, observedByteLength: null, observedDigest: null }).state).toBe("pending");
    expect(() => orderReviewMediaSchema.parse({ ...base, state: "stored", observedContentType: null, observedByteLength: null, observedDigest: null })).toThrow();
    expect(orderReviewMediaSchema.parse({ ...base, state: "stored", observedContentType: "image/png", observedByteLength: 24, observedDigest: DIGEST }).state).toBe("stored");
  });
});
