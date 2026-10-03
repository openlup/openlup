import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { StandardSchemaV1, StandardTypedV1 } from "@openlup/core/standard-schema";

// A schema written by hand against the copied type, with no schema library.
const positiveCount: StandardSchemaV1<unknown, number> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? { value }
        : { issues: [{ message: "expected a positive integer", path: [{ key: "count" }] }] },
  },
};

async function validate<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<Schema>>> {
  return schema["~standard"].validate(value);
}

describe("standard-schema standalone", () => {
  it("accepts a hand-written schema without a dependency", async () => {
    await expect(validate(positiveCount, 3)).resolves.toEqual({ value: 3 });
    await expect(validate(positiveCount, -1)).resolves.toEqual({
      issues: [{ message: "expected a positive integer", path: [{ key: "count" }] }],
    });
    expectTypeOf<StandardSchemaV1.InferOutput<typeof positiveCount>>().toEqualTypeOf<number>();
  });

  it("accepts a schema library's schema structurally", async () => {
    const item = z.object({ sku: z.string().min(1), quantity: z.number().int() });
    const schema: StandardSchemaV1<unknown, { sku: string; quantity: number }> = item;
    const typed: StandardTypedV1 = item;

    await expect(validate(schema, { sku: "ITEM-1", quantity: 2 })).resolves.toEqual({
      value: { sku: "ITEM-1", quantity: 2 },
    });
    const refused = await validate(schema, { sku: "", quantity: 1.5 });
    expect("issues" in refused && refused.issues?.length).toBe(2);
    expect(typed["~standard"].version).toBe(1);
    expectTypeOf<StandardSchemaV1.InferOutput<typeof item>>().toEqualTypeOf<{ sku: string; quantity: number }>();
  });
});
