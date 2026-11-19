import type { SettingDescriptor, SettingRefusal } from "../contracts/settings.js";
import { settingsToolOutputSchema, toolInputSchema } from "./toolSchema.js";
import { loadSettingsCatalogue, settingsListRequest, settingsVersion } from "./settingsCatalog.js";
import { z } from "zod";

type JsonValue = z.infer<ReturnType<typeof z.json>>;
type CatalogueEntry = ReturnType<typeof loadSettingsCatalogue>["entries"][number];
type ListResult = {
  schemaVersion: 1;
  entries: Pick<SettingDescriptor, "key" | "goal" | "kind" | "runtime" | "change">[];
};
type Observation =
  | { state: "offline" }
  | { state: "fallback"; value: JsonValue }
  | { state: "override"; value: JsonValue; revision: string | null }
  | { state: "absent"; absentMeans: string; source: string; value: JsonValue };
type ShowResult = { schemaVersion: 1; setting: SettingDescriptor; observation: Observation };

/** @experimental The host observes an installed row using its own authorized reader. */
export type SettingReader = () => Promise<
  | { present: true; value: JsonValue; revision: string | null }
  | { present: false; effective?: JsonValue }
  | { refusal: string }
>;

function refuse(code: string): { refusal: SettingRefusal } {
  const refusal = loadSettingsCatalogue().byCode.get(code);
  if (!refusal) throw new Error(`Unknown internal settings refusal ${code}`);
  return { refusal };
}

/** @experimental List matching entries from the installed package, offline. */
export function listSettings(input: unknown): ListResult | { refusal: SettingRefusal } {
  const parsed = settingsListRequest.safeParse(input);
  if (!parsed.success) return refuse("commerce_setting_read_input_invalid");
  const words = parsed.data.goal?.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const { entries, listResult, searchTerms } = loadSettingsCatalogue();
  const matches = entries.filter(entry => {
    const text = `${entry.goal} ${entry.key} ${entry.domain} ${entry.searchTerms ?? searchTerms[entry.domain] ?? ""}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  return listResult.parse({
    schemaVersion: settingsVersion,
    entries: matches.map(({ key, goal, kind, runtime, change }) => ({ key, goal, kind, runtime, change })),
  });
}

function absentObservation(setting: CatalogueEntry, effective?: JsonValue): Observation {
  const absent = setting.absentMeans;
  return absent
    ? { state: "absent", absentMeans: absent.description, source: absent.source,
      value: effective === undefined ? absent.value : effective }
    : { state: "fallback", value: setting.fallback };
}

async function observe(setting: CatalogueEntry, read?: SettingReader): Promise<Observation | { refusal: SettingRefusal }> {
  if (!read || setting.kind !== "installed") return { state: "offline" };
  const observed = await read();
  if ("refusal" in observed) return refuse(observed.refusal);
  if (!observed.present) return absentObservation(setting, observed.effective);
  return { state: "override", value: observed.value, revision: observed.revision };
}

/** @experimental Describe the key and, when a reader is supplied, its observed installed value. */
export async function showSetting(input: unknown, readers: Readonly<Record<string, SettingReader>> = {}): Promise<ShowResult | { refusal: SettingRefusal }> {
  const { entries, showRequest, showResult } = loadSettingsCatalogue();
  const parsed = showRequest.safeParse(input);
  if (!parsed.success) return refuse("commerce_setting_unknown");
  const setting = entries.find(entry => entry.key === parsed.data.key);
  if (!setting) return refuse("commerce_setting_unknown");
  try {
    const observation = await observe(setting, Object.hasOwn(readers, setting.key) ? readers[setting.key] : undefined);
    if ("refusal" in observation) return observation;
    return showResult.parse({ schemaVersion: settingsVersion, setting, observation });
  } catch {
    return refuse("commerce_setting_read_unavailable");
  }
}

/** @experimental Explain a refusal code or the offline behavior when a key is absent. */
export function explainSetting(codeOrKey: string): { explanation: SettingRefusal } | ShowResult | { refusal: SettingRefusal } {
  const { byCode, entries, showResult } = loadSettingsCatalogue();
  const explanation = byCode.get(codeOrKey);
  if (explanation) return { explanation };
  const setting = entries.find(entry => entry.key === codeOrKey);
  if (!setting) return refuse("commerce_setting_refusal_unknown");
  return showResult.parse({
    schemaVersion: settingsVersion,
    setting,
    observation: setting.kind === "installed" ? absentObservation(setting) : { state: "offline" },
  });
}

/** @experimental Reuse the same refusal envelope for local CLI syntax errors. */
export function invalidSettingsCommand(): { refusal: SettingRefusal } {
  return refuse("commerce_setting_read_input_invalid");
}

export const settingsPreviewRequest = z.strictObject({
  key: z.string().min(1),
  proposed: z.json(),
  skus: z.array(z.string().trim().min(1)).max(200).optional(),
  asOf: z.iso.datetime().optional(),
});

/** @experimental A domain preview bound by the host to its intended store. */
export type SettingPreviewer<Result> = (proposed: JsonValue, input: {
  asOf: string; skus: readonly string[];
}) => Promise<Result>;

/** @experimental Shared dispatcher for CLI and MCP preview. */
export async function previewSetting<Result = never>(
  input: unknown, previewers: Readonly<Record<string, SettingPreviewer<Result>>> = {},
): Promise<Result | { refusal: SettingRefusal }> {
  const parsed = settingsPreviewRequest.safeParse(input);
  if (!parsed.success) return invalidSettingsCommand();
  const { key, proposed, skus = [], asOf = new Date().toISOString() } = parsed.data;
  const setting = loadSettingsCatalogue().entries.find(entry => entry.key === key);
  if (!setting) return refuse("commerce_setting_unknown");
  if (!setting.previewSchema) return refuse("commerce_setting_preview_unsupported");
  const preview = Object.hasOwn(previewers, key) ? previewers[key] : undefined;
  if (!preview) return refuse("commerce_setting_preview_connection_required");
  try {
    return await preview(proposed, { skus: [...new Set(skus)], asOf });
  } catch {
    return refuse("commerce_setting_preview_unavailable");
  }
}

/** @experimental MCP definitions for adopters composing a read-only settings head. */
export const settingsReadTools = [
  {
    name: "settings__list",
    description: "Start here to find a setting by business goal. Then call settings__show with its key to read its schema and effect.",
    inputSchema: toolInputSchema(settingsListRequest),
    get outputSchema() {
      const { listResult, refusalSchema } = loadSettingsCatalogue();
      return settingsToolOutputSchema(listResult, refusalSchema);
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "settings__show",
    description: "Call settings__list first if you need the key. Read the effect, frozen records and change mechanism. If refused, read remediation.",
    get inputSchema() { return toolInputSchema(loadSettingsCatalogue().showRequest); },
    get outputSchema() {
      const { showResult, refusalSchema } = loadSettingsCatalogue();
      return settingsToolOutputSchema(showResult, refusalSchema);
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "settings__preview",
    description: "Call before any change to the setting. Use settings__show for the value schema. If the value is invalid or preview is refused, read remediation.",
    inputSchema: toolInputSchema(settingsPreviewRequest),
    get outputSchema() { return loadSettingsCatalogue().previewOutputSchema; },
    annotations: { readOnlyHint: true },
  },
] as const;
