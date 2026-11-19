import { z, type ZodType } from "zod";
import type { SettingDescriptor } from "../contracts/settings.js";

/** Project a tool contract as inline Draft 7 JSON Schema. */
export function toolInputSchema(schema: ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-07", io, reused: "inline" });
}

const schemaObject = () => z.record(z.string(), z.json()).nullable().optional();
const settingDescriptorSchema = z.strictObject({
  key: z.string().min(1),
  domain: z.string(),
  kind: z.enum(["installed", "code", "callback", "cap", "invariant"]),
  goal: z.string(),
  searchTerms: z.string().optional(),
  schemaVersion: z.literal(1),
  schema: schemaObject(),
  previewSchema: schemaObject(),
  rules: z.array(z.strictObject({ code: z.string(), path: z.array(z.string()), description: z.string() })),
  examples: z.array(z.strictObject({ value: z.json(), code: z.string().optional() })),
  fallback: z.json(),
  absentMeans: z.strictObject({ description: z.string(), source: z.string(), value: z.json() }).optional(),
  defaultBasis: z.strictObject({ kind: z.enum(["neutral", "reference-code", "reference-live"]) }),
  whyThisDefault: z.string(),
  effect: z.strictObject({
    appliesTo: z.string(),
    frozenOn: z.array(z.string()),
    impact: z.enum(["money", "customer-promise", "operations"]),
  }),
  runtime: z.union([
    z.strictObject({ level: z.literal("ready") }),
    z.strictObject({ level: z.enum(["read-only", "preview"]), reason: z.string() }),
  ]),
  change: z.union([
    z.strictObject({ operation: z.string() }),
    z.strictObject({ file: z.string(), symbol: z.string() }),
    z.strictObject({ reference: z.string() }),
  ]),
}) satisfies z.ZodType<SettingDescriptor>;

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
export const settingsToolOutputSchema = Object.assign(
  (result: ZodType, refusal: ReturnType<typeof settingRefusalSchema>, schemaVersion?: 1): Record<string, unknown> => {
    const refused = schemaVersion === undefined
      ? z.strictObject({ refusal })
      : z.strictObject({ schemaVersion: z.literal(schemaVersion), refusal });
    return { type: "object", ...toolInputSchema(z.union([result, refused]), "output") };
  },
  { descriptor: settingDescriptorSchema },
);
