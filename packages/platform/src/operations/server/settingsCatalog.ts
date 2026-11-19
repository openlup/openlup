import { readFileSync } from "node:fs";
import { z } from "zod";
import { settingDescriptorSchema as descriptor, settingRefusalSchema } from "./toolSchema.js";

export const settingsVersion = 1;
const packageData = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8"));

export const settingsListRequest = z.strictObject({ goal: z.string().trim().min(1).optional() });

let catalogue: ReturnType<typeof readSettingsCatalogue> | undefined;
export function loadSettingsCatalogue() {
  return catalogue ??= readSettingsCatalogue();
}

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
function readSettingsCatalogue() {
  const { entries, searchTerms, previewOutputSchema } = z.strictObject({
    schemaVersion: z.literal(settingsVersion),
    entries: z.array(descriptor),
    searchTerms: z.record(z.string(), z.string()),
    previewOutputSchema: z.record(z.string(), z.unknown()),
  }).parse(packageData("settings-catalog.json"));
  const { refusals } = z.strictObject({
    schemaVersion: z.literal(settingsVersion),
    refusals: z.array(z.object({ code: z.string() }).passthrough()),
  }).parse(packageData("settings-refusals.json"));
  const allRefusals = settingRefusalSchema(refusals.map(({ code }) => code));
  const byCode = new Map(z.array(allRefusals).parse(refusals).map(refusal => [refusal.code, refusal]));
  const refusalSchema = settingRefusalSchema(refusals.map(({ code }) => code)
    .filter(code => !code.startsWith("commerce_setting_preview_")));

  const key = z.enum(entries.map(entry => entry.key));
  const summary = descriptor.pick({ key: true, goal: true, kind: true, runtime: true, change: true }).extend({ key });
  const { domain, schema, previewSchema, rules, examples, fallback, absentMeans, defaultBasis, whyThisDefault, effect } = descriptor.shape;
  // Keep the existing show contract and its field order in CLI and MCP JSON.
  const setting = summary.extend({
    domain, schemaVersion: z.number(), schema: schema.unwrap(), previewSchema: previewSchema.unwrap(),
    rules, examples, fallback, absentMeans, defaultBasis, whyThisDefault, effect,
  });
  const showRequest = z.strictObject({ key });
  const showResult = z.strictObject({ schemaVersion: z.literal(settingsVersion), setting, observation: observationSchema });
  const listResult = z.strictObject({ schemaVersion: z.literal(settingsVersion), entries: z.array(summary) });
  return { entries: z.array(setting).parse(entries), searchTerms, previewOutputSchema, byCode, refusalSchema, showRequest, showResult, listResult };
}
