import { z, type ZodType } from "zod";

/** @experimental Derive inline JSON Schema from the Zod contract used by a tool. */
export function toolInputSchema(schema: ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-07", io, reused: "inline" });
}
