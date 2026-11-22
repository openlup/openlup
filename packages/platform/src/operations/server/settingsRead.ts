import type { SettingDescriptor, SettingRefusal } from "../contracts/index.js";
import { listCatalogueSettings, loadSettingsCatalogue, settingsVersion } from "./settingsCatalog.js";
import { hasNonfiniteNumber } from "./settingsCommandSupport.js";
import { z } from "zod";

type JsonValue = z.infer<ReturnType<typeof z.json>>;
type ListResult = {
  schemaVersion: 1;
  entries: Pick<SettingDescriptor, "key" | "goal" | "kind" | "runtime" | "change">[];
  appBindingWarning?: string;
  partialMatch?: true;
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

type CatalogueRefusal = SettingRefusal & { remediation: { command: string } };

function refuse(code: string): { refusal: CatalogueRefusal } {
  const refusal = loadSettingsCatalogue().byCode.get(code);
  if (!refusal) throw new Error(`Unknown internal settings refusal ${code}`);
  return { refusal };
}

function refuseUnboundCoverageRead() {
  const { refusal } = refuse("commerce_setting_read_unavailable");
  const action = "Use a qualified native PostgreSQL installation; managed installations do not supply tax coverage history (documented limitation).";
  return { refusal: { ...refusal, hint: "Bind the native reader to the intended installation and account.",
    remediation: { ...refusal.remediation, action,
      command: "openlup settings show tax.coverage --app <module> --database-url <read-capable-url> --json" } } };
}

export function refuseCoverageRead(cause: unknown, hint?: string): { refusal: SettingRefusal } {
  const code = cause !== null && typeof cause === "object" && "code" in cause ? cause.code : cause;
  if (code === "tax_coverage_reader_unbound") return refuseUnboundCoverageRead();
  const { refusal } = refuse("commerce_setting_read_unavailable");
  const action = code === "42501"
    ? "Grant EXECUTE on public.tax_coverage_read_v1(text,text) to the runtime role, then run the same command again"
    : "Restore the database connection, then run the same command again with the same --app and --configuration";
  return { refusal: { ...refusal, hint: hint ?? refusal.hint, remediation: { retry: true, action } } };
}

/** @experimental List matching entries from the installed package, offline. */
export function listSettings(input: unknown): ListResult | { refusal: SettingRefusal } {
  return listCatalogueSettings(input);
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
  if ("refusal" in observed) return setting.key === "tax.coverage"
    && (observed.refusal === "tax_coverage_reader_unbound" || observed.refusal === "commerce_setting_read_unavailable")
    ? refuseCoverageRead(observed.refusal) : refuse(observed.refusal);
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
  } catch (error) {
    return setting.key === "tax.coverage" ? refuseCoverageRead(error) : refuse("commerce_setting_read_unavailable");
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

type PreviewRefusal = { schemaVersion: 1; refusal: CatalogueRefusal };

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

/** @experimental Dispatch a preview to the selected domain previewer. */
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
