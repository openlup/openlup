import { readFileSync } from "node:fs";
import { z } from "zod";
import { settingRefusalSchema, settingsToolOutputSchema, settingsVersion } from "./toolSchema.js";
const packageData = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8"));

export const settingsListRequest = z.strictObject({ goal: z.string().trim().min(1).optional() });
const observationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("override"), value: z.json(), revision: z.string().nullable() }),
  z.strictObject({ state: z.literal("fallback"), value: z.json() }),
  z.strictObject({ state: z.literal("absent"), absentMeans: z.string(), source: z.string(), value: z.json() }),
  z.strictObject({ state: z.literal("offline") }),
]);

let catalogue: ReturnType<typeof readSettingsCatalogue> | undefined;
export function loadSettingsCatalogue() {
  return catalogue ??= readSettingsCatalogue();
}

function readSettingsCatalogue() {
  const { descriptor } = settingsToolOutputSchema;
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
  const refusalSchema = settingRefusalSchema(refusals.map(({ code }) => code));
  const byCode = new Map(z.array(refusalSchema).parse(refusals).map(refusal => [refusal.code, refusal]));

  const key = z.enum(entries.map(entry => entry.key));
  const setting = descriptor.extend({ key });
  const showRequest = z.strictObject({ key });
  const showResult = z.strictObject({ schemaVersion: z.literal(settingsVersion), setting, observation: observationSchema });
  const listResult = z.strictObject({
    schemaVersion: z.literal(settingsVersion),
    entries: z.array(setting.pick({ key: true, goal: true, kind: true, runtime: true, change: true })),
  });
  return { entries, searchTerms, previewOutputSchema, byCode, refusalSchema, showRequest, showResult, listResult };
}
