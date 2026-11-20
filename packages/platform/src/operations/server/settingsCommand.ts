import { parseArgs } from "node:util";
import { loadSettingsCatalogue } from "./settingsCatalog.js";
import {
  explainSetting, invalidSettingsCommand, listSettings, previewSetting, refuseSettingsPreview, showSetting,
  type SettingPreviewer, type SettingReader,
} from "./settingsRead.js";

type PreviewDocument = { schemaVersion: 1 };
/** @experimental Read-only bindings supplied by an explicitly loaded settings app. */
export type SettingsAppBindings = {
  readers?: Readonly<Record<string, SettingReader>>;
  previewers?: Readonly<Record<string, SettingPreviewer<PreviewDocument>>>;
  stockSourceKey?: string;
} | { configurationIds: readonly string[] };

type SettingsHost = {
  bind(input: { databaseUrl?: string; app?: string; configuration?: string }): Promise<SettingsAppBindings & { close?(): Promise<void> }>;
  formatPreview?(result: PreviewDocument): string;
};
type SettingsIo = { write(text: string): void; readStdin(): Promise<string> };
type Result = Awaited<ReturnType<typeof previewSetting<PreviewDocument>>>
  | ReturnType<typeof listSettings> | Awaited<ReturnType<typeof showSetting>> | ReturnType<typeof explainSetting>;

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
    ? result.entries.map(({ key, kind, runtime, goal, change }) =>
      `${key} (${kind}, ${runtime.level})\n  ${goal}\n  Change: ${Object.values(change).join(" ")}`).join("\n")
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
    io.write((json ? JSON.stringify({ schemaVersion: 1, help }) : help) + "\n");
    return 0;
  }
  preview = command === "preview";
  const databaseUrl = values["database-url"];
  if (values.goal !== undefined && command !== "list") return invalid("goal", "Use --goal with list.");
  const url = databaseUrl === undefined ? undefined : URL.parse(databaseUrl);
  const invalidDatabase = databaseUrl !== undefined && (!url?.hostname || !["postgres:", "postgresql:"].includes(url.protocol))
    ? { path: ["database-url"], hint: databaseUrl ? "Supply a PostgreSQL URL for the intended store." : "Supply a read-capable database URL." }
    : undefined;
  if (preview && databaseUrl === "" && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (preview && !key) return invalid("key", "Pass the setting key and one proposed JSON value with --value.");
  if (preview && extra.length) return invalid("proposed", "Pass one proposed JSON value with --value.");
  if (extra.length || (command === "list" ? key !== undefined : !key)
    || (databaseUrl !== undefined && command !== "show" && !preview)
    || (!preview && (values.value !== undefined || values.sku || values.configuration !== undefined || values["as-of"] !== undefined))
    || values.app === "") return invalid();
  if (!preview && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (command === "list") return emit(listSettings({ goal: values.goal }), values.goal?.trim() === "" ? 64 : undefined);
  if (command === "explain") return emit(explainSetting(key!));
  if (command !== "show" && !preview) return invalid();

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
    if (command === "show") {
      const offline = await showSetting({ key });
      if (!databaseUrl || "refusal" in offline || offline.setting.kind !== "installed") return [offline];
    }
    const resolveConfiguration = preview && values.configuration !== undefined;
    if (preview && !resolveConfiguration && !invalidDatabase) {
      const offline = await previewSetting(input);
      if (!databaseUrl || offline.refusal.code !== "commerce_setting_preview_connection_required") {
        return [offline, offline.refusal.code === "commerce_setting_preview_input_invalid" ? 64 : undefined];
      }
    }
    if (resolveConfiguration && !values.app) return [needsApp("configuration")];
    const connectedUrl = invalidDatabase ? undefined : databaseUrl;
    if (preview && connectedUrl && !host) return [needsApp(), 74];
    // An explicit configuration can be resolved without a pool, including before a URL refusal.
    const bindings = (connectedUrl || resolveConfiguration)
      ? await host?.bind({ databaseUrl: connectedUrl, app: values.app, configuration: values.configuration }) : undefined;
    try {
      if (bindings && "configurationIds" in bindings) {
        const id = values.configuration ?? "";
        return [refuseSettingsPreview("commerce_setting_preview_configuration_unknown", {
          path: ["configuration"], hint: `Unknown configuration ${id.includes("://") ? "ID" : JSON.stringify(id)}. Use one of these IDs: ${bindings.configurationIds.join(", ")}.`,
        }), 64];
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
