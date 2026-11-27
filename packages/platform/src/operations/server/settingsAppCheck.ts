import { z, type ZodType } from "zod";
import type { SettingRefusal } from "../contracts/settings.js";
import { taxCoverageV1Schema } from "../../tax/contracts/index.js";
import { loadSettingsCatalogue, settingsEntriesWithAppSettings } from "./settingsCatalog.js";
import type { SettingsAppBindings, SettingsFileEntry } from "./settingsCommand.js";
import type { AppValidation, FileValue, Validation } from "./settingsCommandSupport.js";
import { settingDescriptorSchema, toolInputSchema } from "./toolSchema.js";

type JsonValue = z.infer<ReturnType<typeof z.json>>;
export type FileBinding = NonNullable<Extract<SettingsAppBindings, { file?: unknown }>["file"]>;
type DeclaredFileEntry = Extract<SettingsFileEntry, { descriptor: unknown }>;
export type AppSetting = { setting: z.infer<typeof settingDescriptorSchema>; entry: DeclaredFileEntry; schema?: ZodType };
export type CheckDocument = Awaited<ReturnType<typeof checkDocument>>;

export type LoadedAppBindings =
  | { status: "loaded"; bindings: Exclude<SettingsAppBindings, { configurationIds: readonly string[] }> }
  | { status: "missing" }
  | { status: "failed"; error: unknown }
  | { status: "unknown-configuration"; configurationIds: readonly string[] };

export async function loadAppBindings(
  host: { loadCheck?(input: { app: string; configuration?: string }): Promise<SettingsAppBindings | undefined> } | undefined,
  app: string,
  configuration?: string,
): Promise<LoadedAppBindings> {
  let bindings: SettingsAppBindings | undefined;
  try {
    bindings = await host?.loadCheck?.({ app, configuration });
  } catch (error) {
    return { status: "failed", error };
  }
  if (!bindings) return { status: "missing" };
  if ("configurationIds" in bindings) {
    return { status: "unknown-configuration", configurationIds: bindings.configurationIds };
  }
  return { status: "loaded", bindings };
}

function appRefusal(code: string, path: string[], rule: string, hint: string, action: string, command: string): { refusal: SettingRefusal } {
  return { refusal: { code, path, rule, hint, remediation: { retry: true, action, command } } };
}

export function appUnavailable(path: string[], hint: string, command: string) {
  return appRefusal("commerce_setting_read_unavailable", path, "The application setting could not be read.",
    hint, "Correct the application binding and retry.", command);
}

function inMemberOrder<T extends object>(ordered: T, original: Readonly<Record<string, unknown>>): T {
  return Object.fromEntries(Object.keys(ordered).map(key => [key, original[key]])) as T;
}

export function declaredSettings(file?: FileBinding, warn?: (text: string) => void) {
  const declarations = new Map<string, AppSetting>();
  const packaged = loadSettingsCatalogue().entries;
  const missingDescriptors: string[] = [];
  for (const [key, entry] of Object.entries(file?.entries ?? {})) {
    const packagedKey = packaged.some(setting => setting.key === key);
    if (entry?.descriptor === undefined) {
      if (warn && entry && !packagedKey) missingDescriptors.push(key);
      continue;
    }
    const refuse = (hint: string) => appRefusal("commerce_setting_read_input_invalid", ["file", "entries", key, "descriptor"],
      "The application setting declaration is invalid.", hint, "Correct the named declaration and retry.",
      "openlup settings list --app <module>");
    if (packagedKey) {
      return refuse(`${key} is a packaged setting. Choose another key or report the installed file value and location without a descriptor.`);
    }
    if (typeof entry.location?.file !== "string" || typeof entry.location.symbol !== "string") {
      return refuse(`Supply a file and symbol for ${key}.`);
    }
    const { schema, ...metadata } = entry.descriptor;
    let displaySchema;
    // The Zod projection also carries non-enumerable Standard Schema metadata.
    try { displaySchema = schema === undefined ? null : { ...toolInputSchema(schema) }; }
    catch {
      return refuse(`The schema for ${key} cannot be displayed. Use a convertible Zod input schema or move the check to the app startup validator.`);
    }
    const setting = {
      rules: [], examples: [], fallback: null, defaultBasis: { kind: "neutral" },
      whyThisDefault: "The application config supplies the value.",
      ...metadata,
      key, kind: "code", schemaVersion: 1, schema: displaySchema, previewSchema: null,
      runtime: { level: "read-only", reason: "Edit the application configuration and deploy." }, change: entry.location,
    };
    const [valueDescriptor] = settingDescriptorSchema.options;
    const admitted = isJsonValue(setting) ? valueDescriptor.safeParse(setting) : undefined;
    if (!admitted?.success) return refuse(`Check the descriptor and file location for ${key}.`);
    // Use the parser's member order and retain the original authored JSON values.
    const { file, symbol } = entry.location;
    const ordered = inMemberOrder(admitted.data, {
      ...setting,
      runtime: admitted.data.runtime,
      change: { file, symbol },
      effect: inMemberOrder(admitted.data.effect, setting.effect),
    });
    declarations.set(key, { setting: ordered, entry, schema });
  }
  if (missingDescriptors.length) {
    const keys = missingDescriptors.sort().map(key => JSON.stringify(key)).join(", ");
    warn?.(`Settings app: value reported without a descriptor for ${keys}. Add a descriptor to each named file.entries entry. See node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md#declare-a-setting-of-your-own.\n`);
  }
  return { declarations };
}

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

export function errorMessage(error: unknown, fallback = "Application validation failed."): string {
  try {
    const message = typeof error === "string" ? error
      : error && typeof error === "object" && "message" in error ? error.message : undefined;
    if (typeof message === "string") return message.replace(/\s+/gu, " ").trim().slice(0, 180) || fallback;
  } catch { /* A thrown value need not have a readable message. */ }
  return fallback;
}

export function checkErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  try {
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
    if (typeof cause === "string" && cause.length > 0 && cause.length <= 300 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(cause)) {
      return `${message} (${cause})`;
    }
  } catch { /* A thrown value need not have a readable cause. */ }
  return message;
}

export async function checkApp(file?: FileBinding): Promise<AppValidation> {
  if (!file) return { state: "not-provided", hint: "Add file: { configuration, entries } to your existing createSettingsBindings return value, then rerun settings check." };
  if (!file.validate) return { state: "not-provided" };
  try {
    await file.validate();
    return { state: "passed" };
  } catch (error) {
    return { state: "failed", message: checkErrorMessage(error) };
  }
}

function reportedFileValue(entry: FileBinding["entries"][string] | undefined): FileValue {
  if (!entry) return { state: "not-reported" };
  const { location, value } = entry;
  if (value === undefined && entry.descriptor !== undefined) return { state: "not-reported" };
  const source = typeof location?.file === "string" && typeof location.symbol === "string"
    ? { location: { file: location.file, symbol: location.symbol } } : {};
  try {
    if (isJsonValue(value)) return { state: "present", ...source, value };
  } catch { /* The value cannot be inspected as JSON. */ }
  return { state: "unreportable", ...source, message: "Value cannot be reported as JSON." };
}

export function appFileValue(entry: DeclaredFileEntry): FileValue {
  try { return reportedFileValue(entry); }
  catch {
    const { file, symbol } = entry.location;
    return { state: "unreportable", location: { file, symbol }, message: "Value cannot be reported as JSON." };
  }
}

async function validateFileValue(key: string, file: FileValue, schema: Record<string, JsonValue> | null, appSchema?: ZodType): Promise<Validation> {
  if (file.state !== "present") return { state: "not-validated" };
  if (key === "tax.coverage") {
    const parsed = taxCoverageV1Schema.safeParse(file.value);
    return parsed.success ? { state: "valid" } : {
      state: "invalid",
      paths: [("coverage" + parsed.error.field).split("/")],
      messages: [parsed.error.message],
    };
  }
  if (!appSchema && !schema) return { state: "not-validated" };
  try {
    const parsed = appSchema ? await appSchema.safeParseAsync(file.value) : z.fromJSONSchema(schema!).safeParse(file.value);
    return parsed.success ? { state: "valid" }
      : {
        state: "invalid",
        paths: parsed.error.issues.map(issue => issue.path.map(String)),
        messages: parsed.error.issues.map(issue => issue.message),
      };
  } catch { return appSchema ? { state: "invalid", paths: [[]], messages: ["Application schema validation failed."] } : { state: "not-validated" }; }
}

export async function checkDocument(file: FileBinding | undefined, appValidation: AppValidation, declarations?: ReadonlyMap<string, AppSetting>) {
  const entries = settingsEntriesWithAppSettings(declarations && [...declarations.values()].map(({ setting }) => setting));
  const rows = await Promise.all(entries.flatMap(entry => {
    if (entry.kind !== "code" && entry.kind !== "installed") return [];
    const reported = file && Object.hasOwn(file.entries, entry.key) ? file.entries[entry.key] : undefined;
    const declaration = declarations?.get(entry.key);
    const value = declaration ? appFileValue(declaration.entry) : reportedFileValue(reported);
    const location = declaration?.entry.location;
    const takesEffect = location ? `${location.file} ${location.symbol}` : Object.values(entry.change).join(" ");
    return [validateFileValue(entry.key, value, entry.schema ?? null, declaration?.schema).then(validation => ({
      key: entry.key, file: value, validation,
      effect: entry.effect.appliesTo, takesEffect, kind: entry.kind,
      ...(entry.kind === "installed" ? {
        store: { state: "not-checked" },
        note: "The starter checks its installed file policies for drift at boot, and preview shows the effect where supported.",
      } : {}),
    }))];
  }));
  const state = appValidation.state === "failed" || rows.some(row => row.file.state === "unreportable" || row.validation.state === "invalid")
    ? "invalid" : file ? "checked" : "unknown";
  return { schemaVersion: 1 as const, configuration: file?.configuration ?? null, state, appValidation, rows };
}
