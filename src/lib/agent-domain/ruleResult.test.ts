import { describe, expect, it } from "vitest";
import { z } from "../validation/zod.js";

import { adminModeFields, idempotencyKeyField, paginationFields } from "./ruleResult.js";

describe("agent-domain request field primitives", () => {
  const schema = z.object({ ...adminModeFields, ...idempotencyKeyField }).strict();

  it("defaults mode to commit and leaves idempotencyKey optional", () => {
    expect(schema.parse({})).toEqual({ mode: "commit" });
  });

  it("accepts dry_run + a uuid idempotency key", () => {
    const key = "11111111-1111-1111-1111-111111111111";
    expect(schema.parse({ mode: "dry_run", idempotencyKey: key })).toEqual({
      mode: "dry_run",
      idempotencyKey: key,
    });
  });

  it("rejects an unknown mode and a non-uuid idempotency key", () => {
    expect(schema.safeParse({ mode: "delete" }).success).toBe(false);
    expect(schema.safeParse({ idempotencyKey: "not-a-uuid" }).success).toBe(false);
  });
});

describe("paginationFields", () => {
  const schema = z.object({ ...paginationFields }).strict();

  it("defaults limit=50, offset=0 and coerces string query params", () => {
    expect(schema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(schema.parse({ limit: "10", offset: "20" })).toEqual({ limit: 10, offset: 20 });
  });

  it("rejects out-of-range limit and negative offset", () => {
    expect(schema.safeParse({ limit: "0" }).success).toBe(false);
    expect(schema.safeParse({ limit: "101" }).success).toBe(false);
    expect(schema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});
