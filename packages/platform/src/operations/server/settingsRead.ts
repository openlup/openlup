import type { SettingDescriptor, SettingRefusal } from "../contracts/index.js";
import { loadSettingsCatalogue, settingsListRequest, settingsVersion } from "./settingsCatalog.js";
import { fileObservationSchema, settingsCheckResult, settingsToolOutputSchema, toolInputSchema } from "./toolSchema.js";
import { z } from "zod";

type JsonValue = z.infer<ReturnType<typeof z.json>>;
type ListResult = {
  schemaVersion: 1;
  entries: Pick<SettingDescriptor, "key" | "goal" | "kind" | "runtime" | "change">[];
};
type FileObservation = z.infer<typeof fileObservationSchema>;
type Observation =
  | FileObservation
  | { state: "offline" }
  | { state: "fallback"; value: JsonValue }
  | { state: "override"; value: JsonValue; revision: string | null }
  | { state: "absent"; absentMeans: string; source: string; value: JsonValue };
type ShowResult = { schemaVersion: 1; setting: SettingDescriptor; observation: Observation; fileObservation?: FileObservation };

export type SettingsFileBinding = {
  configuration: string;
  entries: Readonly<Record<string, { value: unknown; location?: { file: string; symbol: string } }>>;
  validate?: () => void | Promise<void>;
};

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  // Check the original data. JSON encoding would otherwise omit or replace some values.
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return false;
  ancestors.add(value);
  const valid = keys.every((key, index) => {
    if (array && key === "length") return true;
    if (typeof key !== "string" || (array && key !== String(index))) return false;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, "value") && isJsonValue(property.value, ancestors);
  });
  ancestors.delete(value);
  return valid;
}

function fileValue(setting: SettingDescriptor, file?: SettingsFileBinding) {
  if (!file || !Object.hasOwn(file.entries, setting.key)) return;
  const { value, location } = file.entries[setting.key]!;
  const source = location ? { location } : "file" in setting.change ? { catalogueReference: setting.change } : {};
  try {
    if (isJsonValue(value)) return { ...source, value };
  } catch { /* The value cannot be inspected as JSON. */ }
  return source;
}

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
    const text = `${entry.goal} ${entry.key} ${entry.domain} ${searchTerms[entry.key] ?? searchTerms[entry.domain] ?? ""}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  return listResult.parse({
    schemaVersion: settingsVersion,
    entries: matches.map(({ key, goal, kind, runtime, change }) => ({ key, goal, kind, runtime, change })),
  });
}

type ValueEntry = Extract<ReturnType<typeof loadSettingsCatalogue>["entries"][number], { rules: unknown }>;

function absentObservation(setting: ValueEntry, effective?: JsonValue): Observation {
  const absent = setting.absentMeans;
  return absent
    ? { state: "absent", absentMeans: absent.description, source: absent.source,
      value: effective === undefined ? absent.value : effective }
    : { state: "fallback", value: setting.fallback };
}

async function observe(setting: ReturnType<typeof loadSettingsCatalogue>["entries"][number], read?: SettingReader): Promise<Observation | { refusal: SettingRefusal }> {
  if (!read || setting.kind !== "installed") return { state: "offline" };
  const observed = await read();
  if ("refusal" in observed) return refuse(observed.refusal);
  if (!observed.present) return absentObservation(setting, observed.effective);
  return { state: "override", value: observed.value, revision: observed.revision };
}

/** @experimental Describe a setting and its reported file or installed value. */
export async function showSetting(
  input: unknown, readers: Readonly<Record<string, SettingReader>> = {}, file?: SettingsFileBinding,
): Promise<ShowResult | { refusal: SettingRefusal }> {
  const { entries, showRequest, showResult } = loadSettingsCatalogue();
  const parsed = showRequest.safeParse(input);
  if (!parsed.success) return refuse("commerce_setting_unknown");
  const setting = entries.find(entry => entry.key === parsed.data.key);
  if (!setting) return refuse("commerce_setting_unknown");
  try {
    const observation = await observe(setting, Object.hasOwn(readers, setting.key) ? readers[setting.key] : undefined);
    if ("refusal" in observation) return observation;
    const result = showResult.parse({ schemaVersion: settingsVersion, setting, observation });
    const reported = fileValue(setting, file);
    if (!reported) return result;
    if (!("value" in reported) || reported.value === undefined) {
      const { refusal } = refuse("commerce_setting_read_unavailable");
      return { refusal: { ...refusal, hint: "The app file binding must report a JSON value. Run settings check to locate the invalid value." } };
    }
    // Parse the envelope with a placeholder. Zod's JSON parser can strip own properties from the original.
    const fileObservation = {
      ...fileObservationSchema.parse({ state: "file", configuration: file!.configuration, ...reported, value: null }),
      value: reported.value,
    };
    return observation.state === "offline" ? { ...result, observation: fileObservation } : { ...result, fileObservation };
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

type PreviewRefusal = { schemaVersion: 1; refusal: SettingRefusal };

/** @experimental Use the same preview refusal document for host and domain failures. */
export function refuseSettingsPreview(code: string, detail?: Pick<SettingRefusal, "path" | "hint">): PreviewRefusal {
  const { refusal } = refuse(code);
  return { schemaVersion: settingsVersion, refusal: { ...refusal, ...detail } };
}

export const settingsPreviewRequest = z.strictObject({
  key: z.string().min(1),
  proposed: z.json(),
  skus: z.array(z.string().min(1)).optional(),
  asOf: z.iso.datetime().optional(),
});

/** @experimental A read-only domain preview bound by the host to its store. */
export type SettingPreviewer<Result extends { schemaVersion: 1 }> = (proposed: JsonValue, input: {
  asOf: string; skus: readonly string[]; refuse: typeof refuseSettingsPreview;
}) => Promise<Result | PreviewRefusal>;

function hasNonfiniteNumber(proposed: unknown): boolean {
  const pending = [proposed];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "number" && !Number.isFinite(value)) return true;
    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  return false;
}

/** @experimental Shared dispatcher for CLI and host-mounted MCP preview. */
export async function previewSetting<Result extends { schemaVersion: 1 } = never>(
  input: unknown, previewers: Readonly<Record<string, SettingPreviewer<Result>>> = {},
): Promise<Result | PreviewRefusal> {
  // Inspect and forward the original proposal, including its own __proto__ keys.
  const { proposed } = (input ?? {}) as { proposed: JsonValue };
  const parsed = hasNonfiniteNumber(proposed) ? undefined : settingsPreviewRequest.safeParse(input);
  if (!parsed?.success) {
    const field = parsed ? parsed.error.issues[0]?.path[0] : "proposed";
    const hint = field === "key" ? "Supply a setting key from the catalogue."
      : field === "proposed" ? "Supply a decoded JSON value with finite numbers."
      : field === "skus" ? "Supply nonempty SKU strings."
      : field === "asOf" ? "Supply an ISO timestamp in UTC, ending in Z."
      : "Supply the preview arguments shown in help.";
    return refuseSettingsPreview("commerce_setting_preview_input_invalid", { path: typeof field === "string" ? [field] : [], hint });
  }
  const { key, skus = [], asOf = new Date().toISOString() } = parsed.data;
  const setting = loadSettingsCatalogue().entries.find(entry => entry.key === key);
  if (!setting) return refuseSettingsPreview("commerce_setting_unknown");
  if (!("previewSchema" in setting) || !setting.previewSchema) return refuseSettingsPreview("commerce_setting_preview_unsupported");
  const preview = Object.hasOwn(previewers, key) ? previewers[key] : undefined;
  if (!preview) return refuseSettingsPreview("commerce_setting_preview_connection_required");
  try {
    return await preview(proposed, { skus: [...new Set(skus)], asOf, refuse: refuseSettingsPreview });
  } catch {
    return refuseSettingsPreview("commerce_setting_preview_unexpected");
  }
}

type CheckDocument = z.infer<typeof settingsCheckResult>;
type RowValidation = CheckDocument["rows"][number]["validation"];

function validateFileValue(value: JsonValue | undefined, schema: Record<string, JsonValue> | null): RowValidation {
  if (value === undefined) return { state: "invalid", paths: [[]], message: "Value cannot be reported as JSON." };
  if (!schema) return { state: "not-validated" };
  try {
    const parsed = z.fromJSONSchema(schema).safeParse(value);
    return parsed.success ? { state: "valid" }
      : { state: "invalid", paths: parsed.error.issues.map(issue => issue.path.map(String)) };
  } catch { return { state: "not-validated" }; }
}

async function checkApp(file?: SettingsFileBinding): Promise<CheckDocument["appValidation"]> {
  if (!file) return { state: "not-provided", hint: "Add file: { configuration, entries } to your existing createSettingsBindings return value, then rerun settings check." };
  if (!file.validate) return { state: "not-provided" };
  try {
    await file.validate();
    return { state: "passed" };
  } catch (error) {
    const message = typeof error === "string" ? error
      : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
    return { state: "failed", message: message.replace(/\s+/gu, " ").trim().slice(0, 180) || "Application validation failed." };
  }
}

export async function checkFileSettings(file?: SettingsFileBinding): Promise<CheckDocument> {
  const appValidation = await checkApp(file);
  const { entries } = loadSettingsCatalogue();
  const unknownKeys = Object.keys(file?.entries ?? {}).filter(key => !entries.some(entry => entry.key === key));
  const rows = entries.flatMap((entry): CheckDocument["rows"] => {
    if (entry.kind !== "code" && entry.kind !== "installed") return [];
    const reported = fileValue(entry, file);
    const common = {
      key: entry.key,
      file: reported ? { state: "present" as const, ...reported } : { state: "not-reported" as const },
      validation: reported ? validateFileValue("value" in reported ? reported.value : undefined, entry.schema ?? null) : { state: "not-validated" as const },
      effect: entry.effect.appliesTo,
    };
    return entry.kind === "code" ? [{ ...common, kind: entry.kind, takesEffect: "deploy" }] : [{
      ...common, kind: entry.kind, takesEffect: Object.values(entry.change).join(" "), store: { state: "not-checked" },
      note: "The starter checks its installed file policies for drift at boot, and preview shows the effect where supported.",
    }];
  });
  const state = !file ? "unknown" : appValidation.state === "failed" || unknownKeys.length || rows.some(row => row.validation.state === "invalid")
    ? "invalid" : "checked";
  return settingsCheckResult.parse({
    schemaVersion: settingsVersion, configuration: file?.configuration ?? null, state, appValidation, rows,
    ...(unknownKeys.length ? { unknownKeys, unknownKeysHint: "Use settings list to find the catalogue key, then correct or remove these entries in the app file binding." } : {}),
  });
}

function createSettingsToolSchemas() {
  const { listResult, showRequest, showResult, refusalSchema } = loadSettingsCatalogue();
  return {
    listOutput: settingsToolOutputSchema(listResult, refusalSchema),
    showInput: toolInputSchema(showRequest),
    showOutput: settingsToolOutputSchema(showResult, refusalSchema),
  };
}

let toolSchemas: ReturnType<typeof createSettingsToolSchemas> | undefined;

/** @experimental MCP definitions for adopters composing a read-only settings head. */
export const settingsReadTools = [
  {
    name: "settings__list",
    description: "Find a key by business goal, then use settings__show for value details or a reason and reference.",
    inputSchema: toolInputSchema(settingsListRequest),
    get outputSchema() { return (toolSchemas ??= createSettingsToolSchemas()).listOutput; },
    annotations: { readOnlyHint: true },
  },
  {
    name: "settings__show",
    description: "Call settings__list if you need the key. Read value details or a reason and reference. If refused, read remediation.",
    get inputSchema() { return (toolSchemas ??= createSettingsToolSchemas()).showInput; },
    get outputSchema() { return (toolSchemas ??= createSettingsToolSchemas()).showOutput; },
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
