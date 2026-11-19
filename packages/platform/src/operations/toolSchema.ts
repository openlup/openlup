import { z, type ZodType } from "zod";

/** Project a tool contract as inline Draft 7 JSON Schema. */
export function toolInputSchema(schema: ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-07", io, reused: "inline" });
}

/** @experimental Schema shared by packaged settings projections and their data reader. */
export function settingRefusalSchema(codes: readonly string[]) {
  return z.strictObject({
    code: z.enum(codes),
    path: z.array(z.string()),
    rule: z.string(),
    hint: z.string(),
    remediation: z.strictObject({ retry: z.boolean(), action: z.string(), command: z.string() }),
  });
}

/** @experimental Derive the success/refusal union and advertise the object root required by MCP. */
export function settingsToolOutputSchema(result: ZodType, refusal: ReturnType<typeof settingRefusalSchema>): Record<string, unknown> {
  return { type: "object", ...toolInputSchema(z.union([result, z.strictObject({ refusal })]), "output") };
}
