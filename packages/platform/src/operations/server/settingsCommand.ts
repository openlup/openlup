import { parseArgs } from "node:util";
import { loadSettingsCatalogue } from "./settingsCatalog.js";
import {
  checkFileSettings, explainSetting, invalidSettingsCommand, listSettings, previewSetting, refuseSettingsPreview, showSetting,
  type SettingsFileBinding, type SettingPreviewer, type SettingReader,
} from "./settingsRead.js";

type PreviewDocument = { schemaVersion: 1 };
/** @experimental Read-only bindings supplied by an explicitly loaded settings app. */
export type SettingsAppBindings = {
  readers?: Readonly<Record<string, SettingReader>>;
  previewers?: Readonly<Record<string, SettingPreviewer<PreviewDocument>>>;
  stockSourceKey?: string;
  file?: SettingsFileBinding;
} | { configurationIds: readonly string[] };

type SettingsHost = {
  bind(input: { databaseUrl?: string; app?: string; configuration?: string }): Promise<SettingsAppBindings & { close?(): Promise<void> }>;
  formatPreview?(result: PreviewDocument): string;
};
type SettingsIo = { write(text: string): void; readStdin(): Promise<string> };
type Result = Awaited<ReturnType<typeof previewSetting<PreviewDocument>>>
  | ReturnType<typeof listSettings> | Awaited<ReturnType<typeof showSetting>> | ReturnType<typeof explainSetting>
  | Awaited<ReturnType<typeof checkFileSettings>>;

const help = `openlup settings (experimental) list [--goal <text>] | show <key> | preview <key> --value <json-or-> | explain <refusal-code-or-key>
openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)
Use --json for a versioned settings document. Use check after editing owned config and preview for connected effects.
Pass --value - to read one JSON value from stdin or --value=-1 for a negative number.
For connected show or preview, pass --database-url <read-capable-url>.
Use --app <module> for app-owned read bindings. Show, preview and check accept --configuration <id>.
Preview accepts repeatable --sku and --as-of <UTC-ISO-instant>.
Exit codes: 0 completed (including invalid-policy preview), 1 refused or invalid check, 2 check has no file binding, 64 invalid syntax or input, 74 operation unavailable.

Examples:
  npm --silent run settings -- list --goal "renewal stock protection horizon"
  npm --silent run settings -- show inventory_renewal_protection --json
  npm --silent run settings -- check --json
  npm --silent run settings -- preview inventory_renewal_protection --value '{"revision":"store-1","renewalProtectionDays":21}' --database-url <read-capable-url> --sku <sku> --json
  npm --silent run settings -- explain commerce_setting_unknown`;

type FileObservation = NonNullable<Extract<Result, { setting: unknown }>["fileObservation"]>;

function fileLocationText({ location, catalogueReference }: Pick<FileObservation, "location" | "catalogueReference">): string {
  if (location) return `${location.file} · ${location.symbol}`;
  return catalogueReference ? `File location unreported (starter catalogue reference — ${catalogueReference.file} · ${catalogueReference.symbol})`
    : "File location unreported";
}

function checkText(result: Awaited<ReturnType<typeof checkFileSettings>>): string {
  const { appValidation, configuration, rows, state } = result;
  return [
    `Settings check (${configuration ?? "configuration unreported"}): ${state}`,
    `App startup validation: ${appValidation.state}${appValidation.state === "failed" ? ` — ${appValidation.message}` : ""}`,
    ...("hint" in appValidation && appValidation.hint ? [appValidation.hint] : []),
    ...(result.unknownKeys ? [`Unknown file keys: ${result.unknownKeys.join(", ")}`, result.unknownKeysHint] : []),
    "Catalogue checks cover the published schemas. Unreported values and unavailable schemas are not validated.",
    ...rows.flatMap(row => [
      `${row.key}: file ${row.file.state}, schema ${row.validation.state}${row.validation.state === "invalid"
        ? ` at ${row.validation.paths.map(path => path.join(".") || "<value>").join(", ")}` : ""}`,
      ...(row.validation.state === "invalid" && row.validation.message ? [`  ${row.validation.message}`] : []),
      ...(row.file.state === "present" ? [`  ${fileLocationText(row.file)}${row.file.value === undefined ? "" : ` = ${JSON.stringify(row.file.value)}`}`] : []),
      `  Effect: ${row.effect} Change: ${row.takesEffect}`,
      ...("store" in row ? [`  Store: not checked. ${row.note}`] : []),
    ]),
  ].join("\n");
}

function fileText(file: FileObservation): string {
  return `File as loaded (${file.configuration}) — ${fileLocationText(file)} = ${JSON.stringify(file.value)}.`;
}

function text(result: Result, command?: string, host?: SettingsHost): string {
  if ("refusal" in result || (command === "explain" && "explanation" in result)) {
    const { code, rule, hint, remediation } = "refusal" in result ? result.refusal : result.explanation;
    return [code, rule, hint, remediation.action, remediation.command].join("\n");
  }
  if (command === "preview" && "schemaVersion" in result) return host?.formatPreview?.(result) ?? JSON.stringify(result, null, 2);
  if (command === "check" && "rows" in result) return checkText(result);
  if (command === "list" && "entries" in result) return result.entries.length
    ? result.entries.map(({ key, kind, runtime, goal, change }) => [
      `${key} (${kind}, ${runtime.level})`, `  ${goal}`,
      ...((kind === "cap" || kind === "invariant") && "reason" in runtime ? [`  ${runtime.reason}`] : []),
      `  Change: ${Object.values(change).join(" ")}`,
    ].join("\n")).join("\n")
    : "No settings matched the goal.";
  if ((command !== "show" && command !== "explain") || !("setting" in result)) return JSON.stringify(result, null, 2);
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
    `Change: ${Object.values(setting.change).join(" ")}`,
    observation.state === "file" ? `${fileText(observation)} Running store not observed.`
      : `Observation: ${JSON.stringify(observation.state === "offline" ? { state: "offline" } : observation)}`,
    ...(observation.state === "offline" && observation.note ? [observation.note] : []),
    ...(result.fileObservation ? [fileText(result.fileObservation)] : []),
    ...(command === "show" && observation.state !== "file" && !result.fileObservation ? ["No file value reported."] : []),
  ].join("\n");
}

/** @experimental Run the settings CLI without owning process I/O or application bindings. */
export async function runSettingsCommand(argv: readonly string[], io: SettingsIo, host?: SettingsHost): Promise<number> {
  let json = argv.includes("--json");
  const emit = (result: Result, code = "refusal" in result ? 1 : 0, command?: string) => {
    io.write((json ? JSON.stringify("schemaVersion" in result ? result : { schemaVersion: 1, ...result }) : text(result, command, host)) + "\n");
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
    const command = parseArgs({ ...parser, strict: false }).positionals[0];
    preview = command === "preview";
    const [, flag, option] = /^[^']*'(-{1,2}([^']+?))(?: <[^'>]+>)?'/u.exec(error.message) ?? [];
    const helpTopic = preview ? "preview help" : command === "check" ? "check help" : "settings help";
    const hint = error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ? `Supply a value for ${flag} as shown in ${helpTopic}.`
      : error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? `Unknown option ${flag}. See ${helpTopic}.` : undefined;
    return invalid(option, hint);
  }
  const { values, positionals: [command, key, ...extra] } = parsed;
  json = values.json === true;
  if (values.help) {
    io.write((json ? JSON.stringify({ schemaVersion: 1, help }) : help) + "\n");
    return 0;
  }
  preview = command === "preview";
  const check = command === "check";
  const databaseUrl = values["database-url"];
  if (values.goal !== undefined && command !== "list") return invalid("goal", "Use --goal with list.");
  if (check) {
    if (databaseUrl !== undefined) return invalid("database-url", "Settings check is offline. Use settings preview with --database-url for connected effects.");
    if (!values.app) return invalid("app", "Pass --app <module> that exports createSettingsBindings.");
    const previewFlag = (["value", "sku", "as-of"] as const).find(flag => values[flag] !== undefined);
    if (previewFlag) return invalid(previewFlag, `Use --${previewFlag} with preview.`);
    if (key !== undefined) return invalid("key", "Settings check reports all catalogue keys. Omit the key.");
  }
  const url = databaseUrl === undefined ? undefined : URL.parse(databaseUrl);
  const invalidDatabase = databaseUrl !== undefined && (!url?.hostname || !["postgres:", "postgresql:"].includes(url.protocol))
    ? { path: ["database-url"], hint: databaseUrl ? "Supply a PostgreSQL URL for the intended store." : "Supply a read-capable database URL." }
    : undefined;
  if (preview && databaseUrl === "" && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (preview && !key) return invalid("key", "Pass the setting key and one proposed JSON value with --value.");
  if (preview && extra.length) return invalid("proposed", "Pass one proposed JSON value with --value.");
  if (extra.length || (command === "list" || check ? key !== undefined : !key)
    || (databaseUrl !== undefined && command !== "show" && !preview)
    || (!preview && (values.value !== undefined || values.sku || values["as-of"] !== undefined))
    || (!preview && !check && values.configuration !== undefined && (command !== "show" || !values.app))
    || values.app === "") return invalid();
  if (!preview && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (command === "list") return emit(listSettings({ goal: values.goal }), values.goal?.trim() === "" ? 64 : undefined, command);
  if (command === "explain") return emit(explainSetting(key!), undefined, command);
  if (command !== "show" && !preview && !check) return invalid();

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
  const unavailableApp = (): Result => ({ refusal: {
    ...unavailable().refusal,
    path: ["app"],
    rule: "The settings app must load and supply createSettingsBindings.",
    hint: "Check the --app path and the createSettingsBindings export.",
    remediation: {
      retry: true, action: "Fix the module path or export and rerun.",
      command: `openlup settings ${command} --help`,
    },
  } });
  const needsApp = (field = "app") => refuseSettingsPreview("commerce_setting_preview_connection_required", {
    path: [field], hint: "Pass --app <module> for the shop's stock source and configuration.",
  });
  async function dispatch(): Promise<[Result, number?]> {
    let offlineShow: Extract<Result, { setting: unknown }> | undefined;
    let showConnected = false;
    if (command === "show") {
      const offline = await showSetting({ key });
      if ("refusal" in offline) return [offline];
      offlineShow = offline;
      showConnected = databaseUrl !== undefined && offline.setting.kind === "installed";
      if (!showConnected && !values.app) return [offline];
    }
    const resolveConfiguration = preview && values.configuration !== undefined;
    if (preview && !resolveConfiguration && !invalidDatabase) {
      const offline = await previewSetting(input);
      if (!databaseUrl || offline.refusal.code !== "commerce_setting_preview_connection_required") {
        return [offline, offline.refusal.code === "commerce_setting_preview_input_invalid" ? 64 : undefined];
      }
    }
    if (resolveConfiguration && !values.app) return [needsApp("configuration")];
    const connectedUrl = invalidDatabase || (command === "show" && !showConnected) ? undefined : databaseUrl;
    if (preview && connectedUrl && !host) return [needsApp(), 74];
    // An explicit configuration can be resolved without a pool, including before a URL refusal.
    let bindings;
    try {
      bindings = (connectedUrl || resolveConfiguration || check || (command === "show" && values.app))
        ? await host?.bind({ databaseUrl: connectedUrl, app: values.app, configuration: values.configuration }) : undefined;
    } catch (error) {
      if (!offlineShow || showConnected) throw error;
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
      const reason = !message.trim() || message.includes("://")
        ? "Check that the app can open its settings binding without a database."
        : message.replace(/\s+/gu, " ").trim().slice(0, 180);
      return [{ ...offlineShow, observation: { state: "offline", note: `App binding could not be loaded offline. ${reason}` } }];
    }
    if (!bindings && check) return [unavailableApp(), 74];
    try {
      if (bindings && "configurationIds" in bindings) {
        const id = values.configuration ?? "";
        const hint = `Unknown configuration ${id.includes("://") ? "ID" : JSON.stringify(id)}. Use one of these IDs: ${bindings.configurationIds.join(", ")}.`;
        if (offlineShow && !showConnected && values.configuration === undefined) return [offlineShow];
        return preview || (showConnected && values.configuration === undefined)
          ? [refuseSettingsPreview("commerce_setting_preview_configuration_unknown", { path: ["configuration"], hint }), 64]
          : [{ refusal: { ...invalidSettingsCommand().refusal, path: ["configuration"], hint } }, 64];
      }
      if (preview) {
        if (invalidDatabase) return [refuseSettingsPreview("commerce_setting_preview_input_invalid", invalidDatabase), 64];
        const result = await previewSetting(input, connectedUrl ? bindings?.previewers : undefined);
        if ("refusal" in result) {
          if (result.refusal.code === "commerce_setting_preview_input_invalid") return [result, 64];
          if (result.refusal.code === "commerce_setting_preview_unexpected") return [result, 74];
          if (databaseUrl && !values.app && result.refusal.code === "commerce_setting_preview_connection_required") return [needsApp()];
        }
        return [result];
      }
      if (check) {
        const result = await checkFileSettings(bindings?.file);
        return [result, result.state === "unknown" ? 2 : result.state === "invalid" ? 1 : 0];
      }
      const readers = bindings?.readers;
      if (showConnected && (!readers || !Object.hasOwn(readers, key!) || typeof readers[key!] !== "function")) {
        return [unavailable(host && !values.app ? "Pass --app <module> that supplies a reader for this setting."
          : "No connected reader exists for this key. Omit --database-url for offline discovery.")];
      }
      const result = await showSetting({ key }, showConnected ? readers : undefined, bindings?.file);
      return [result, "refusal" in result && result.refusal.code === "commerce_setting_read_unavailable" ? 74 : undefined];
    } finally { await bindings?.close?.(); }
  }
  let outcome: [Result, number?];
  try { outcome = await dispatch(); }
  catch {
    const hint = "Check the read-capable database connection and that --app exports createSettingsBindings.";
    const refusal = preview ? refuseSettingsPreview("commerce_setting_preview_unexpected", { path: [], hint })
      : databaseUrl === undefined ? unavailableApp() : unavailable(hint);
    outcome = [refusal, 74];
  }
  return emit(outcome[0], outcome[1], command);
}
