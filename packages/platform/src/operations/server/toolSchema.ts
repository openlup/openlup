import { z, type ZodType } from "zod";
import type { SettingDescriptor } from "../contracts/settings.js";

/** Project a tool contract as inline Draft 7 JSON Schema. */
export function toolInputSchema(schema: ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-07", io, reused: "inline" });
}

const schemaObject = () => z.record(z.string(), z.json()).nullable().optional();
export const settingDescriptorSummary = z.strictObject({
  key: z.string().min(1),
  goal: z.string(),
  kind: z.enum(["installed", "code", "callback", "cap", "invariant"]),
  runtime: z.union([
    z.strictObject({ level: z.literal("ready") }),
    z.strictObject({ level: z.enum(["read-only", "preview"]), reason: z.string() }),
  ]),
  change: z.union([
    z.strictObject({ operation: z.string() }),
    z.strictObject({ file: z.string(), symbol: z.string() }),
    z.strictObject({ reference: z.string() }),
  ]),
});
const descriptorBase = settingDescriptorSummary.extend({ domain: z.string(), schemaVersion: z.literal(1) });
const settingValueDescriptor = descriptorBase.extend({
  kind: z.enum(["installed", "code", "callback"]),
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
});
const settingFactDescriptor = descriptorBase.extend({
  kind: z.enum(["cap", "invariant"]),
  runtime: z.strictObject({ level: z.literal("read-only"), reason: z.string() }),
  change: z.strictObject({ reference: z.string() }),
});

/** @experimental Describe the data written to and loaded from the settings catalogue. */
export const settingDescriptorSchema = z.discriminatedUnion("kind", [
  settingValueDescriptor, settingFactDescriptor,
]) satisfies z.ZodType<SettingDescriptor>;

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
export function settingsToolOutputSchema(
  result: ZodType, refusal: ReturnType<typeof settingRefusalSchema>, schemaVersion?: 1,
): Record<string, unknown> {
  const refused = schemaVersion === undefined
    ? z.strictObject({ refusal })
    : z.strictObject({ schemaVersion: z.literal(schemaVersion), refusal });
  return { type: "object", ...toolInputSchema(z.union([result, refused]), "output") };
}

const fileLocation = z.strictObject({ file: z.string(), symbol: z.string() });
const fileSource = { location: fileLocation.optional(), catalogueReference: fileLocation.optional() };
export const fileObservationSchema = z.strictObject({
  state: z.literal("file"), configuration: z.string(), ...fileSource, value: z.json(),
});

const checkRow = z.strictObject({
  key: z.string(),
  file: z.discriminatedUnion("state", [
    // The file binding checks JSON compatibility before assembly. Keep the original value here.
    z.strictObject({ state: z.literal("present"), ...fileSource, value: z.unknown().optional() }),
    z.strictObject({ state: z.literal("not-reported") }),
  ]),
  validation: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("valid") }),
    z.strictObject({ state: z.literal("invalid"), paths: z.array(z.array(z.string())), message: z.string().optional() }),
    z.strictObject({ state: z.literal("not-validated") }),
  ]),
  effect: z.string(),
  takesEffect: z.string(),
});
export const settingsCheckResult = z.strictObject({
  schemaVersion: z.literal(1),
  configuration: z.string().nullable(),
  state: z.enum(["checked", "invalid", "unknown"]),
  appValidation: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("passed") }),
    z.strictObject({ state: z.literal("failed"), message: z.string().max(180) }),
    z.strictObject({ state: z.literal("not-provided"), hint: z.string().optional() }),
  ]),
  rows: z.array(z.discriminatedUnion("kind", [
    checkRow.extend({ kind: z.literal("code") }),
    checkRow.extend({ kind: z.literal("installed"), store: z.strictObject({ state: z.literal("not-checked") }), note: z.string() }),
  ])),
  unknownKeys: z.array(z.string()).optional(),
  unknownKeysHint: z.string().optional(),
});
