import { readFileSync } from "node:fs";
import { z } from "zod";
import { settingDescriptorSchema as descriptor, settingDescriptorSummary, settingRefusalSchema } from "./toolSchema.js";

export const settingsVersion = 1;
export const moneyLimitsSettingKey = "commerce.money_limits.v2";
export const moneyLimitsOwnerReaderKey = `${moneyLimitsSettingKey}.owner`;
export const moneyLimitsUnbound = "money_limits_reader_unbound";
export const moneyLimitsUnavailable = "money_limits_operation_unavailable";
const commandFreeCodes = [moneyLimitsUnbound, moneyLimitsUnavailable] as const;
type CommandFreeCode = (typeof commandFreeCodes)[number];
function isCommandFreeCode(code: string): code is CommandFreeCode {
  return code === moneyLimitsUnbound || code === moneyLimitsUnavailable;
}
export function commandFreeSettingsRefusalSchema() {
  const base = settingRefusalSchema(commandFreeCodes);
  return base.extend({ code: z.enum(commandFreeCodes), remediation: base.shape.remediation.omit({ command: true }) });
}
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
  const commandRefusals = refusals.filter(({ code }) => !isCommandFreeCode(code));
  const allRefusals = settingRefusalSchema(commandRefusals.map(({ code }) => code));
  const byCode = new Map(z.array(allRefusals).parse(commandRefusals).map(refusal => [refusal.code, refusal]));
  const commandFreeByCode = new Map(z.array(commandFreeSettingsRefusalSchema())
    .parse(refusals.filter(({ code }) => isCommandFreeCode(code))).map(refusal => [refusal.code, refusal]));

  return { entries, searchTerms, previewOutputSchema, byCode, commandFreeByCode, ...settingsDocuments(entries) };
}

export function settingsDocuments(entries?: readonly z.infer<typeof descriptor>[]) {
  const key = entries ? z.enum(entries.map(entry => entry.key)) : z.string().min(1);
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
  const listResult = z.strictObject({
    schemaVersion: z.literal(settingsVersion),
    entries: z.array(summary),
    appBindingWarning: z.string().min(1).optional(),
    partialMatch: z.literal(true).optional(),
  });
  return { showRequest, showResult, listResult };
}

export const fileObservationSchema = z.discriminatedUnion("state", [
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

function searchTokens(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{Nd}]+/gu) ?? [];
}

export function listCatalogueSettings(input: unknown, catalogue?: ReturnType<typeof loadSettingsCatalogue>) {
  const parsed = settingsListRequest.safeParse(input);
  if (!parsed.success) return { refusal: loadSettingsCatalogue().byCode.get("commerce_setting_read_input_invalid")! };
  const { entries, listResult, searchTerms } = catalogue ?? loadSettingsCatalogue();
  const { goal } = parsed.data;
  let matches = entries;
  let partialMatch = false;
  if (goal !== undefined) {
    const words = searchTokens(goal);
    const scored = entries.map(entry => {
      const text = `${entry.goal} ${entry.key} ${entry.domain} ${searchTerms[entry.key] ?? searchTerms[entry.domain] ?? ""}`;
      const splitText = text.replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
      const tokens = [...new Set([...searchTokens(text), ...searchTokens(splitText)])];
      const count = words.filter(word => tokens.some(token => token.startsWith(word))).length;
      return { entry, count };
    }).filter(({ count }) => count > 0);
    const complete = scored.filter(({ count }) => count === words.length);
    partialMatch = scored.length > 0 && complete.length === 0;
    matches = (complete.length > 0 ? complete : scored.sort((a, b) => b.count - a.count).slice(0, 10))
      .map(({ entry }) => entry);
  }
  return listResult.parse({
    schemaVersion: settingsVersion,
    entries: matches.map(({ key, goal, kind, runtime, change }) => ({ key, goal, kind, runtime, change })),
    ...(partialMatch ? { partialMatch: true as const } : {}),
  });
}
