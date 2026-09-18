import { describe, expect, it } from "vitest";

import {
  archiveCatalogProductRequestSchema,
  cloneCatalogDraftRequestSchema,
  deactivateCatalogProductRequestSchema,
  restoreCatalogProductRequestSchema,
} from "./adminCatalogLifecycleContracts.js";

describe("admin catalog lifecycle contracts", () => {
  it("archive/restore/deactivate accept a bare slug and default mode to commit", () => {
    for (const schema of [
      archiveCatalogProductRequestSchema,
      restoreCatalogProductRequestSchema,
      deactivateCatalogProductRequestSchema,
    ]) {
      const r = schema.safeParse({ slug: "duck" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.mode).toBe("commit");
    }
  });

  it("clone_draft requires sourceSlug + new slug + new sku", () => {
    expect(
      cloneCatalogDraftRequestSchema.safeParse({
        sourceSlug: "duck",
        slug: "duck-copy",
        sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G",
      }).success,
    ).toBe(true);
    // missing sku
    expect(
      cloneCatalogDraftRequestSchema.safeParse({ sourceSlug: "duck", slug: "duck-copy" }).success,
    ).toBe(false);
    // missing sourceSlug
    expect(
      cloneCatalogDraftRequestSchema.safeParse({ slug: "duck-copy", sku: "OPENLUP-DOG-X-CAN-400G" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict) and malformed slugs", () => {
    expect(
      archiveCatalogProductRequestSchema.safeParse({ slug: "duck", surprise: 1 }).success,
    ).toBe(false);
    expect(archiveCatalogProductRequestSchema.safeParse({ slug: "Bad Slug!" }).success).toBe(false);
    expect(
      cloneCatalogDraftRequestSchema.safeParse({
        sourceSlug: "duck",
        slug: "Bad Slug!",
        sku: "OPENLUP-DOG-X-CAN-400G",
      }).success,
    ).toBe(false);
  });

  it("accepts dry_run mode + a uuid idempotency key, rejects a bad key", () => {
    expect(
      archiveCatalogProductRequestSchema.safeParse({
        slug: "duck",
        mode: "dry_run",
        idempotencyKey: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      }).success,
    ).toBe(true);
    expect(
      archiveCatalogProductRequestSchema.safeParse({ slug: "duck", idempotencyKey: "nope" }).success,
    ).toBe(false);
  });
});
