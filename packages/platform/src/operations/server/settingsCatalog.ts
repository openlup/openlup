import { readFileSync } from "node:fs";
import { z } from "zod";

export const settingsVersion = 1;
const packageData = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8"));

const catalogue = z.strictObject({
  schemaVersion: z.literal(settingsVersion),
  entries: z.array(z.record(z.string(), z.unknown()).and(z.object({ key: z.string() }))),
  searchTerms: z.record(z.string(), z.string()),
}).parse(packageData("settings-catalog.json"));

const refusalData = z.strictObject({
  schemaVersion: z.literal(settingsVersion),
  refusals: z.array(z.object({ code: z.string() }).passthrough()),
}).parse(packageData("settings-refusals.json"));

export const { searchTerms } = catalogue;

const keySchema = z.enum(catalogue.entries.map(entry => entry.key));
export const settingsListRequest = z.strictObject({ goal: z.string().trim().min(1).optional() });
export const settingsShowRequest = z.strictObject({ key: keySchema });
const runtimeSchema = z.union([
  z.strictObject({ level: z.literal("ready") }),
  z.strictObject({ level: z.enum(["read-only", "preview"]), reason: z.string() }),
]);
const summarySchema = z.strictObject({
  key: keySchema,
  goal: z.string(),
  kind: z.enum(["installed", "code", "callback", "cap", "invariant"]),
  runtime: runtimeSchema,
  change: z.union([
    z.strictObject({ operation: z.string() }),
    z.strictObject({ file: z.string(), symbol: z.string() }),
    z.strictObject({ reference: z.string() }),
  ]),
});
const observedValue = z.strictObject({
  state: z.literal("override"),
  value: z.json(),
  revision: z.string().nullable(),
});
const observationSchema = z.discriminatedUnion("state", [
  observedValue,
  z.strictObject({ state: z.literal("fallback"), value: z.json() }),
  z.strictObject({ state: z.literal("absent"), absentMeans: z.string(), source: z.string(), value: z.json() }),
  z.strictObject({ state: z.literal("offline") }),
]);
export const settingsListResult = z.strictObject({
  schemaVersion: z.literal(settingsVersion),
  entries: z.array(summarySchema),
});
export const settingsShowResult = z.strictObject({
  schemaVersion: z.literal(settingsVersion),
  setting: summarySchema.extend({
    domain: z.string(),
    schemaVersion: z.number(),
    schema: z.record(z.string(), z.json()).nullable(),
    previewSchema: z.record(z.string(), z.json()).nullable(),
    rules: z.array(z.strictObject({ code: z.string(), path: z.array(z.string()), description: z.string() })),
    examples: z.array(z.strictObject({ value: z.json(), code: z.string().optional() })),
    fallback: z.json(),
    absentMeans: z.strictObject({ description: z.string(), source: z.string(), value: z.json() }).optional(),
    defaultBasis: z.strictObject({ kind: z.enum(["neutral", "reference-code", "reference-live"]) }),
    whyThisDefault: z.string(),
    effect: z.strictObject({ appliesTo: z.string(), frozenOn: z.array(z.string()), impact: z.enum(["money", "customer-promise", "operations"]) }),
  }),
  observation: observationSchema,
});

export const settingRefusalSchema = z.strictObject({
  code: z.enum(refusalData.refusals.map(refusal => refusal.code)),
  path: z.array(z.string()),
  rule: z.string(),
  hint: z.string(),
  remediation: z.strictObject({ retry: z.boolean(), action: z.string(), command: z.string() }),
});
export const settingsRefusalResult = z.strictObject({ refusal: settingRefusalSchema });

export const settingsCatalogue = z.array(settingsShowResult.shape.setting).parse(catalogue.entries);
export const settingRefusals = z.array(settingRefusalSchema).parse(refusalData.refusals);
