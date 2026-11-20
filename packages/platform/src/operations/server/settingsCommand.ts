import { parseArgs } from "node:util";
import { z, type ZodType } from "zod";
import type { SettingDescriptor, SettingRefusal } from "../contracts/settings.js";
import { catalogueWithAppSettings, listCatalogueSettings, loadSettingsCatalogue, settingsEntriesWithAppSettings } from "./settingsCatalog.js";
import { settingDescriptorSchema, toolInputSchema } from "./toolSchema.js";
import {
  explainSetting, invalidSettingsCommand, listSettings, previewSetting, refuseSettingsPreview, showSetting,
  type SettingPreviewer, type SettingReader,
} from "./settingsRead.js";

type PreviewDocument = { schemaVersion: 1 };
type ValueDescriptor = Extract<SettingDescriptor, { effect: unknown }>;
type Location = Extract<ValueDescriptor["change"], { file: string }>;
/** @experimental A file value reported by an application settings binding. */
export type SettingsFileEntry = { value: unknown; location?: Location; descriptor?: never } | {
  value: unknown;
  location: Location;
  descriptor: Pick<ValueDescriptor, "domain" | "goal" | "effect">
    & Partial<Pick<ValueDescriptor, "rules" | "examples" | "fallback" | "defaultBasis" | "whyThisDefault">>
    & { schema?: ZodType };
};
/** @experimental Read-only bindings supplied by an explicitly loaded settings app. */
export type SettingsAppBindings = {
  readers?: Readonly<Record<string, SettingReader>>;
  previewers?: Readonly<Record<string, SettingPreviewer<PreviewDocument>>>;
  stockSourceKey?: string;
  file?: {
    configuration: string;
    entries: Readonly<Record<string, SettingsFileEntry>>;
    validate?: () => void | Promise<void>;
  };
} | { configurationIds: readonly string[] };

type SettingsDatabase = {
  host: string; port: number; user: string; password: string | (() => string); database: string;
  ssl: false | { rejectUnauthorized: true; host: string }; sslnegotiation: "postgres";
  options: string; replication: "false"; client_encoding: "utf8"; application_name: string; connectionTimeoutMillis: 0;
};
type SettingsHost = {
  bind(input: { database?: SettingsDatabase; app?: string; configuration?: string }): Promise<SettingsAppBindings & { close?(): Promise<void> }>;
  loadCheck?(input: { app: string; configuration?: string }): Promise<SettingsAppBindings | undefined>;
  formatPreview?(result: PreviewDocument): string;
};
type SettingsIo = { write(text: string): void; warn?(text: string): void; readStdin(): Promise<string> };
type Result = Awaited<ReturnType<typeof previewSetting<PreviewDocument>>>
  | ReturnType<typeof listSettings> | Awaited<ReturnType<typeof showSetting>> | ReturnType<typeof explainSetting>
  | z.infer<ReturnType<typeof catalogueWithAppSettings>["appShowResult"]>;

const help = `openlup settings (experimental) list [--goal <text>] | show <key> | preview <key> --value <json-or-> | explain <refusal-code-or-key>
Use --json for a versioned settings document. Preview before any change.
Pass --value - to read one JSON value from stdin or --value=-1 for a negative number.
For connected show or preview, pass --database-url <read-capable-url>.
Use --app <module> for app-owned read bindings. Preview accepts repeatable --sku,
--as-of <UTC-ISO-instant>, and --configuration <id> for the selected app.
Exit codes: 0 completed (including invalid-policy preview), 1 refused, 64 invalid syntax or input, 74 operation unavailable.

Examples:
  npm --silent run settings -- list --goal "renewal stock protection horizon"
  npm --silent run settings -- show inventory_renewal_protection --json
  npm --silent run settings -- preview inventory_renewal_protection --value '{"revision":"store-1","renewalProtectionDays":21}' --database-url <read-capable-url> --sku <sku> --json
  npm --silent run settings -- explain commerce_setting_unknown`;

function text(result: Result, host?: SettingsHost): string {
  if ("refusal" in result || "explanation" in result) {
    const { code, rule, hint, remediation } = "refusal" in result ? result.refusal : result.explanation;
    return [code, rule, hint, remediation.action, remediation.command].join("\n");
  }
  if ("entries" in result) return result.entries.length
    ? result.entries.map(({ key, kind, runtime, goal, change }) => [
      `${key} (${kind}, ${runtime.level})`, `  ${goal}`,
      ...((kind === "cap" || kind === "invariant") && "reason" in runtime ? [`  ${runtime.reason}`] : []),
      `  Change: ${Object.values(change).join(" ")}`,
    ].join("\n")).join("\n")
    : "No settings matched the goal.";
  if (!("setting" in result)) return host?.formatPreview?.(result) ?? JSON.stringify(result, null, 2);
  const { setting, observation } = result;
  return [setting.key + " — " + setting.goal, `Owner: ${setting.domain}`,
    `Kind: ${setting.kind} (${setting.runtime.level})`,
    ...("reason" in setting.runtime ? [setting.runtime.reason] : []),
    ...("effect" in setting ? [
      `Default: ${JSON.stringify(setting.fallback)}`,
      `Basis: ${setting.defaultBasis.kind}${setting.defaultBasis.kind === "reference-code" ? " (matches the reference deployment’s code)" : ""}`,
      setting.whyThisDefault, ...(setting.absentMeans ? [setting.absentMeans.description] : []),
      `Schema: ${JSON.stringify(setting.schema)}`, `Effect: ${setting.effect.appliesTo}`,
      `Frozen on: ${setting.effect.frozenOn.join(" ") || "No records named"}`,
    ] : []),
    `Change: ${Object.values(setting.change).join(" ")}`, `Observation: ${JSON.stringify(observation)}`].join("\n");
}

const checkHelp = `openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)
Check reported file values against available setting schemas and run the application's optional startup validation.
Exit codes: 0 checked, 1 invalid, 2 no file member, 64 invalid syntax or configuration, 74 app module or factory not found.`;

type JsonValue = z.infer<ReturnType<typeof z.json>>;
type FileBinding = NonNullable<Extract<SettingsAppBindings, { file?: unknown }>["file"]>;
type FileValue = { state: "not-reported" }
  | ({ location?: Location } & ({ state: "present"; value: JsonValue } | { state: "unreportable"; message: string }));
type Validation = { state: "valid" | "not-validated" } | { state: "invalid"; paths: string[][] };
type AppValidation = { state: "passed" } | { state: "not-provided"; hint?: string }
  | { state: "failed"; message: string; phase?: "load" };

type DeclaredFileEntry = Extract<SettingsFileEntry, { descriptor: unknown }>;
type AppSetting = { setting: z.infer<typeof settingDescriptorSchema>; entry: DeclaredFileEntry; schema?: ZodType };

function appRefusal(code: string, path: string[], rule: string, hint: string, action: string, command: string): { refusal: SettingRefusal } {
  return { refusal: { code, path, rule, hint, remediation: { retry: true, action, command } } };
}

function appUnavailable(path: string[], hint: string, command: string) {
  return appRefusal("commerce_setting_read_unavailable", path, "The application setting could not be read.",
    hint, "Correct the application binding and retry.", command);
}

function inMemberOrder<T extends object>(ordered: T, original: Readonly<Record<string, unknown>>): T {
  return Object.fromEntries(Object.keys(ordered).map(key => [key, original[key]])) as T;
}

function declaredSettings(file?: FileBinding, warn?: SettingsIo["warn"]) {
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

function errorMessage(error: unknown): string {
  try {
    const message = typeof error === "string" ? error
      : error && typeof error === "object" && "message" in error ? error.message : undefined;
    if (typeof message === "string") return message.replace(/\s+/gu, " ").trim().slice(0, 180) || "Application validation failed.";
  } catch { /* A thrown value need not have a readable message. */ }
  return "Application validation failed.";
}

async function checkApp(file?: FileBinding): Promise<AppValidation> {
  if (!file) return { state: "not-provided", hint: "Add file: { configuration, entries } to your existing createSettingsBindings return value, then rerun settings check." };
  if (!file.validate) return { state: "not-provided" };
  try {
    await file.validate();
    return { state: "passed" };
  } catch (error) {
    return { state: "failed", message: errorMessage(error) };
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

function appFileValue(entry: DeclaredFileEntry): FileValue {
  try { return reportedFileValue(entry); }
  catch {
    const { file, symbol } = entry.location;
    return { state: "unreportable", location: { file, symbol }, message: "Value cannot be reported as JSON." };
  }
}

async function validateFileValue(file: FileValue, schema: Record<string, JsonValue> | null, appSchema?: ZodType): Promise<Validation> {
  if (file.state !== "present" || (!appSchema && !schema)) return { state: "not-validated" };
  try {
    const parsed = appSchema ? await appSchema.safeParseAsync(file.value) : z.fromJSONSchema(schema!).safeParse(file.value);
    return parsed.success ? { state: "valid" }
      : { state: "invalid", paths: parsed.error.issues.map(issue => issue.path.map(String)) };
  } catch { return appSchema ? { state: "invalid", paths: [[]] } : { state: "not-validated" }; }
}

async function checkDocument(file: FileBinding | undefined, appValidation: AppValidation, declarations?: ReadonlyMap<string, AppSetting>) {
  const entries = settingsEntriesWithAppSettings(declarations && [...declarations.values()].map(({ setting }) => setting));
  const rows = await Promise.all(entries.flatMap(entry => {
    if (entry.kind !== "code" && entry.kind !== "installed") return [];
    const reported = file && Object.hasOwn(file.entries, entry.key) ? file.entries[entry.key] : undefined;
    const declaration = declarations?.get(entry.key);
    const value = declaration ? appFileValue(declaration.entry) : reportedFileValue(reported);
    const location = declaration?.entry.location;
    const takesEffect = location ? `${location.file} ${location.symbol}` : Object.values(entry.change).join(" ");
    return [validateFileValue(value, entry.schema ?? null, declaration?.schema).then(validation => ({
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

function checkText({ appValidation, configuration, rows, state }: Awaited<ReturnType<typeof checkDocument>>): string {
  return [
    `Settings check (${configuration ?? "configuration unreported"}): ${state}`,
    appValidation.state === "failed" && appValidation.phase === "load"
      ? `Application configuration rejected while loading — ${appValidation.message}`
      : `App startup validation: ${appValidation.state}${appValidation.state === "failed" ? ` — ${appValidation.message}` : ""}`,
    ...("hint" in appValidation && appValidation.hint ? [appValidation.hint] : []),
    "Catalogue checks cover reported JSON values with an executable schema.",
    ...rows.flatMap(row => {
      const file = row.file;
      const source = file.state === "not-reported" ? undefined : file.location;
      return [
        `${row.key}: file ${file.state}, schema ${row.validation.state}${row.validation.state === "invalid"
          ? ` at ${row.validation.paths.map(path => path.join(".") || "<value>").join(", ")}` : ""}`,
        ...(source ? [`  ${source.file} · ${source.symbol}`] : []),
        ...(file.state === "present" ? [`  Value: ${JSON.stringify(file.value)}`] : file.state === "unreportable" ? [`  ${file.message}`] : []),
        `  Effect: ${row.effect} Change: ${row.takesEffect}`,
        ...(row.store ? [`  Store: not checked. ${row.note}`] : []),
      ];
    }),
  ].join("\n");
}

function admitDatabaseUrl(input: string): SettingsDatabase | { path: string[]; hint: string } {
  const path = ["database-url"];
  if (!input) return { path, hint: "Supply a read-capable database URL." };
  const target = "Supply a postgres:// or postgresql:// URL with a TCP host, username and database.";
  if (input !== input.trim() || /[\p{Cc}#]/u.test(input)) {
    return { path, hint: "Remove surrounding whitespace, control characters and the fragment from the PostgreSQL URL." };
  }
  const [, authority, databasePath] = /^postgres(?:ql)?:\/\/([^/?#]*)(\/[^?#]*)?/iu.exec(input) ?? [];
  const hostPort = authority?.split("@").at(-1) ?? "";
  const portAt = hostPort.lastIndexOf(":");
  const specifiedPort = portAt > hostPort.lastIndexOf("]") ? hostPort.slice(portAt + 1) : undefined;
  const port = specifiedPort === undefined ? 5432 : Number(specifiedPort);
  if (specifiedPort !== undefined && (!/^\d+$/u.test(specifiedPort) || port < 1 || port > 65535)) {
    return { path, hint: "Omit the PostgreSQL URL port or use a port from 1 to 65535." };
  }
  const url = URL.parse(input);
  if (!url?.hostname || url.hostname.includes("%") || !url.username || !databasePath?.slice(1)) return { path, hint: target };
  const sslmode = url.searchParams.get("sslmode");
  if (input.includes("?") && (!url.search || url.search.includes("&") || url.searchParams.size !== 1
    || (sslmode !== "disable" && sslmode !== "require" && sslmode !== "verify-full"))) {
    return { path, hint: "Remove PostgreSQL URL query options or use one sslmode set to disable, require or verify-full." };
  }
  try {
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(databasePath.slice(1));
    if (![user, password, database].some(value => /\p{Cc}/u.test(value))) {
      const host = url.hostname.replace(/^\[|\]$/gu, "");
      return {
        host, port, user, password: password || (() => ""), database,
        ssl: sslmode === "require" || sslmode === "verify-full" ? { rejectUnauthorized: true, host } : false,
        // Truthy no-op startup values prevent pg from inheriting process connection defaults.
        sslnegotiation: "postgres", options: " ", replication: "false", client_encoding: "utf8",
        application_name: "openlup settings", connectionTimeoutMillis: 0,
      };
    }
  } catch { /* Malformed credential or database escapes are refused without echoing input. */ }
  return { path, hint: "Encode the PostgreSQL username, password and database as valid URL components without control characters." };
}

/** @experimental Run the settings CLI without owning process I/O or application bindings. */
export async function runSettingsCommand(argv: readonly string[], io: SettingsIo, host?: SettingsHost): Promise<number> {
  let json = argv.includes("--json");
  const emit = (result: Result, code = "refusal" in result ? 1 : 0) => {
    io.write((json ? JSON.stringify("schemaVersion" in result ? result : { schemaVersion: 1, ...result }) : text(result, host)) + "\n");
    return code;
  };
  let preview = false;
  const invalid = (field?: string, hint?: string) => {
    const result = preview ? refuseSettingsPreview("commerce_setting_preview_input_invalid") : invalidSettingsCommand();
    return emit(field && hint ? { ...result, refusal: { ...result.refusal, path: [field], hint } } : result, 64);
  };
  const parser = {
    args: [...argv], allowPositionals: true,
    options: {
      goal: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
      value: { type: "string", multiple: true }, "database-url": { type: "string" }, app: { type: "string" },
      sku: { type: "string", multiple: true }, configuration: { type: "string" }, "as-of": { type: "string" },
    },
  } as const;
  let parsed;
  try {
    parsed = parseArgs(parser);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_"))) throw error;
    preview = parseArgs({ ...parser, strict: false }).positionals[0] === "preview";
    const [, flag, option] = /^[^']*'(-{1,2}([^']+?))(?: <[^'>]+>)?'/u.exec(error.message) ?? [];
    const helpTopic = preview ? "preview help" : "settings help";
    const hint = error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ? `Supply a value for ${flag} as shown in ${helpTopic}.`
      : error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? `Unknown option ${flag}. See ${helpTopic}.` : undefined;
    return invalid(option, hint);
  }
  const { values, positionals: [command, key, ...extra] } = parsed;
  json = values.json === true;
  if (values.help) {
    const usage = command === "check" ? checkHelp : help;
    io.write((json ? JSON.stringify({ schemaVersion: 1, help: usage }) : usage) + "\n");
    return 0;
  }
  const loadApp = () => host?.loadCheck?.({ app: values.app!, configuration: values.configuration });
  if (command === "check") {
    if (values["database-url"] !== undefined) return invalid("database-url", "Settings check is offline. Use settings preview with --database-url for connected effects.");
    if (!values.app) return invalid("app", "Pass --app <module> that exports createSettingsBindings.");
    if (key !== undefined) return invalid("key", "Settings check reports all catalogue keys. Omit the key.");
    const unsupported = (["goal", "value", "sku", "as-of"] as const).find(flag => values[flag] !== undefined);
    if (unsupported) return invalid(unsupported, `Omit --${unsupported} when running settings check.`);
    const report = async (file: FileBinding | undefined, validation: AppValidation, declarations?: ReadonlyMap<string, AppSetting>) => {
      const result = await checkDocument(file, validation, declarations);
      io.write((json ? JSON.stringify(result) : checkText(result)) + "\n");
      return result.state === "checked" ? 0 : result.state === "invalid" ? 1 : 2;
    };
    let bindings;
    try {
      bindings = await loadApp();
    } catch (error) {
      return report(undefined, { state: "failed", phase: "load", message: errorMessage(error) });
    }
    if (!bindings) {
      const refusal = loadSettingsCatalogue().byCode.get("commerce_setting_read_unavailable")!;
      return emit({ refusal: { ...refusal, path: ["app"], rule: "The settings app must supply a binding factory.",
        hint: "Check the --app path and the createSettingsBindings export.",
        remediation: { retry: true, action: "Fix the module path or export and rerun.", command: "openlup settings check --help" },
      } }, 74);
    }
    if ("configurationIds" in bindings) {
      const id = values.configuration ?? "";
      return invalid("configuration", `Unknown configuration ${id.includes("://") ? "ID" : JSON.stringify(id)}. Use one of these IDs: ${bindings.configurationIds.join(", ")}.`);
    }
    const admitted = declaredSettings(bindings.file, io.warn);
    if ("refusal" in admitted) return emit(admitted, 64);
    return report(bindings.file, await checkApp(bindings.file), admitted.declarations);
  }
  preview = command === "preview";
  const databaseUrl = values["database-url"];
  if (values.goal !== undefined && command !== "list") return invalid("goal", "Use --goal with list.");
  const admission = databaseUrl === undefined ? undefined : admitDatabaseUrl(databaseUrl);
  const invalidDatabase = admission && "hint" in admission ? admission : undefined;
  const database = admission && "host" in admission ? admission : undefined;
  if (preview && databaseUrl === "" && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (preview && !key) return invalid("key", "Pass the setting key and one proposed JSON value with --value.");
  if (preview && extra.length) return invalid("proposed", "Pass one proposed JSON value with --value.");
  if (extra.length || (command === "list" ? key !== undefined : !key)
    || (databaseUrl !== undefined && command !== "show" && !preview)
    || (!preview && (values.value !== undefined || values.sku || values.configuration !== undefined || values["as-of"] !== undefined))
    || values.app === "") return invalid();
  if (!preview && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (command !== "list" && command !== "explain" && command !== "show" && !preview) return invalid();

  const listInput = { goal: values.goal };
  const offline = command === "list" ? listSettings(listInput)
    : command === "explain" ? explainSetting(key!)
    : command === "show" ? await showSetting({ key }) : undefined;
  if (offline && (command !== "show" || !databaseUrl || "refusal" in offline
    || !("setting" in offline) || offline.setting.kind !== "installed")) {
    const exit = command === "list" && "refusal" in offline ? 64 : undefined;
    if (!values.app || !host?.loadCheck || (command === "list" ? "refusal" in offline : !("refusal" in offline))) {
      return emit(offline, exit);
    }
    const missing = "Check the --app path and the createSettingsBindings export.";
    const loadFailure = (hint: string, status: number) => {
      if (command === "list") {
        io.warn?.(`Settings app: ${hint}\n`);
        return emit(offline, exit);
      }
      return emit(appUnavailable(["app"], hint, `openlup settings ${command} <key> --app <module>`), status);
    };
    let bindings;
    try { bindings = await loadApp(); }
    catch (error) { return loadFailure(errorMessage(error), 1); }
    if (!bindings) return loadFailure(missing, 74);
    const file = "configurationIds" in bindings ? undefined : bindings.file;
    const admitted = declaredSettings(file, command === "list" ? io.warn : undefined);
    if ("refusal" in admitted) return emit(admitted, 64);
    const declarations = admitted.declarations;
    if (command === "list") {
      return emit(declarations.size ? listCatalogueSettings(listInput,
        catalogueWithAppSettings([...declarations.values()].map(({ setting }) => setting))) : offline);
    }
    const declaration = declarations.get(key!);
    if (!file || !declaration) return emit(offline);
    let observation: z.infer<ReturnType<typeof catalogueWithAppSettings>["appShowResult"]>["observation"] = { state: "offline" };
    if (command === "show") {
      const reported = appFileValue(declaration.entry);
      if (reported.state === "unreportable") {
        const { location } = declaration.entry;
        return emit(appUnavailable(["file", "entries", key!, "value"], `Could not read ${key} at ${location.file}.`,
          "openlup settings show <key> --app <module>"), 74);
      }
      if (reported.state === "present") observation = { state: "file", configuration: file.configuration, value: reported.value };
    }
    const { appShowResult } = catalogueWithAppSettings([declaration.setting]);
    const result = { schemaVersion: 1 as const, setting: declaration.setting, observation };
    // Validate the envelope without replacing the application's original JSON value.
    appShowResult.parse(result);
    return emit(result);
  }

  let proposed: unknown;
  if (preview) {
    const [value, ...extraValues] = values.value ?? [];
    if (value === undefined) return invalid("proposed", "Pass the proposed JSON with --value.");
    if (extraValues.length) return invalid("value", "Pass --value exactly once.");
    try { proposed = JSON.parse(value === "-" ? await io.readStdin() : value); }
    catch (error) {
      return emit(refuseSettingsPreview("commerce_setting_preview_json_invalid"), error instanceof SyntaxError ? 64 : 74);
    }
  }
  const input = { key, proposed, skus: values.sku, asOf: values["as-of"] };
  const unavailable = (hint?: string) => {
    const refusal = loadSettingsCatalogue().byCode.get("commerce_setting_read_unavailable")!;
    return { refusal: hint ? { ...refusal, hint } : refusal };
  };
  const needsApp = (field = "app") => refuseSettingsPreview("commerce_setting_preview_connection_required", {
    path: [field], hint: "Pass --app <module> for the shop's stock source and configuration.",
  });
  async function dispatch(): Promise<[Result, number?]> {
    const resolveConfiguration = preview && values.configuration !== undefined;
    if (preview && !resolveConfiguration && !invalidDatabase) {
      const offline = await previewSetting(input);
      if (!databaseUrl || offline.refusal.code !== "commerce_setting_preview_connection_required") {
        return [offline, offline.refusal.code === "commerce_setting_preview_input_invalid" ? 64 : undefined];
      }
    }
    if (resolveConfiguration && !values.app) return [needsApp("configuration")];
    if (preview && database && !host) return [needsApp(), 74];
    // An explicit configuration can be resolved without a pool, including before a URL refusal.
    const bindings = (database || resolveConfiguration)
      ? await host?.bind({ database, app: values.app, configuration: values.configuration }) : undefined;
    try {
      if (bindings && "configurationIds" in bindings) {
        const id = values.configuration ?? "";
        return [refuseSettingsPreview("commerce_setting_preview_configuration_unknown", {
          path: ["configuration"], hint: `Unknown configuration ${id.includes("://") ? "ID" : JSON.stringify(id)}. Use one of these IDs: ${bindings.configurationIds.join(", ")}.`,
        }), 64];
      }
      if (preview) {
        if (invalidDatabase) return [refuseSettingsPreview("commerce_setting_preview_input_invalid", invalidDatabase), 64];
        const result = await previewSetting(input, database ? bindings?.previewers : undefined);
        if ("refusal" in result) {
          if (result.refusal.code === "commerce_setting_preview_input_invalid") return [result, 64];
          if (result.refusal.code === "commerce_setting_preview_unexpected") return [result, 74];
          if (databaseUrl && !values.app && result.refusal.code === "commerce_setting_preview_connection_required") return [needsApp()];
        }
        return [result];
      }
      const readers = bindings?.readers;
      if (!readers || !Object.hasOwn(readers, key!) || typeof readers[key!] !== "function") {
        return [unavailable(host && !values.app ? "Pass --app <module> that supplies a reader for this setting."
          : "No connected reader exists for this key. Omit --database-url for offline discovery.")];
      }
      const result = await showSetting({ key }, readers);
      return [result, "refusal" in result && result.refusal.code === "commerce_setting_read_unavailable" ? 74 : undefined];
    } finally { await bindings?.close?.(); }
  }
  let outcome: [Result, number?];
  try { outcome = await dispatch(); }
  catch {
    const hint = "Check the read-capable database connection and that --app exports createSettingsBindings.";
    outcome = [preview ? refuseSettingsPreview("commerce_setting_preview_unexpected", { path: [], hint }) : unavailable(hint), 74];
  }
  return emit(...outcome);
}
