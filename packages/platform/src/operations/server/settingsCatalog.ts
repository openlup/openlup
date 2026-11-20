import { readFileSync } from "node:fs";
import { z } from "zod";
import { settingDescriptorSchema as descriptor, settingDescriptorSummary, settingRefusalSchema } from "./toolSchema.js";

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

  return { entries, searchTerms, previewOutputSchema, byCode, refusalSchema, ...settingsDocuments(entries) };
}

function settingsDocuments(entries: readonly z.infer<typeof descriptor>[]) {
  const key = z.enum(entries.map(entry => entry.key));
  const [value, ...facts] = descriptor.options;
  const summaryFields = Object.fromEntries(
    settingDescriptorSummary.keyof().options.map(field => [field, true]),
  ) as Record<keyof typeof settingDescriptorSummary.shape, true>;
  const summary = z.discriminatedUnion(descriptor.def.discriminator, [
    value.pick(summaryFields).extend({ key }), ...facts.map(branch => branch.pick(summaryFields).extend({ key })),
  ]);
  // The generator materializes both schema fields on value entries, even when null.
  const setting = z.discriminatedUnion(descriptor.def.discriminator, [
    value.required({ schema: true, previewSchema: true }).extend({ key }), ...facts.map(branch => branch.extend({ key })),
  ]);
  const showRequest = z.strictObject({ key });
  const showResult = z.strictObject({ schemaVersion: z.literal(settingsVersion), setting, observation: observationSchema });
  const listResult = z.strictObject({ schemaVersion: z.literal(settingsVersion), entries: z.array(summary) });
  return { showRequest, showResult, listResult };
}

const fileObservationSchema = z.discriminatedUnion("state", [
  ...observationSchema.options,
  z.strictObject({ state: z.literal("file"), configuration: z.string(), value: z.json() }),
]);

export function settingsEntriesWithAppSettings(additions: readonly z.infer<typeof descriptor>[] = []) {
  const { entries } = loadSettingsCatalogue();
  return additions.length ? [...entries, ...additions].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : entries;
}

export function catalogueWithAppSettings(additions: readonly z.infer<typeof descriptor>[]) {
  const catalogue = loadSettingsCatalogue();
  const entries = settingsEntriesWithAppSettings(additions);
  const documents = additions.length ? settingsDocuments(entries) : catalogue;
  return { ...catalogue, ...documents, entries, appShowResult: documents.showResult.extend({ observation: fileObservationSchema }) };
}

export function listCatalogueSettings(input: unknown, catalogue?: ReturnType<typeof loadSettingsCatalogue>) {
  const parsed = settingsListRequest.safeParse(input);
  if (!parsed.success) return { refusal: loadSettingsCatalogue().byCode.get("commerce_setting_read_input_invalid")! };
  const words = parsed.data.goal?.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const { entries, listResult, searchTerms } = catalogue ?? loadSettingsCatalogue();
  const matches = entries.filter(entry => {
    const text = `${entry.goal} ${entry.key} ${entry.domain} ${searchTerms[entry.key] ?? searchTerms[entry.domain] ?? ""}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  return listResult.parse({
    schemaVersion: settingsVersion,
    entries: matches.map(({ key, goal, kind, runtime, change }) => ({ key, goal, kind, runtime, change })),
  });
}
