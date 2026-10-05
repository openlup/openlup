import { expect, it } from "vitest";
import type { StandardSchemaV1 } from "../src/standard-schema/index.js";
it("accepts a structural validator without a validator-library type", async () => {
  const schema: StandardSchemaV1<unknown, number> = { "~standard": { vendor: "example", version: 1, validate: (value) => typeof value === "number" ? { value } : { issues: [{ message: "number required" }] } } };
  expect(await schema["~standard"].validate(2)).toEqual({ value: 2 });
});
