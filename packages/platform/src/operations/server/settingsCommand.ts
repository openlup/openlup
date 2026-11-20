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

const help = `openlup settings list [--goal <text>] | show <key> | preview <key> --value <json-or-> | explain <refusal-code-or-key>
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
    `Default: ${JSON.stringify(setting.fallback)}`, `Basis: ${setting.defaultBasis.kind}`,
    setting.whyThisDefault, ...(setting.absentMeans ? [setting.absentMeans.description] : []),
    `Schema: ${JSON.stringify(setting.schema)}`, `Effect: ${setting.effect.appliesTo}`,
    `Frozen on: ${setting.effect.frozenOn.join(" ") || "No records named"}`,
    `Change: ${Object.values(setting.change).join(" ")}`, `Observation: ${JSON.stringify(observation)}`].join("\n");
}

/** @experimental Run the settings CLI without owning process I/O or application bindings. */
export async function runSettingsCommand(argv: readonly string[], io: SettingsIo, host?: SettingsHost): Promise<number> {
  let json = argv.includes("--json");
  const emit = (result: Result, code = "refusal" in result ? 1 : 0) => {
    io.write((json ? JSON.stringify("schemaVersion" in result ? result : { schemaVersion: 1, ...result }) : text(result, host)) + "\n");
    return code;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv], allowPositionals: true, strict: true,
      options: {
        goal: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
        value: { type: "string" }, "database-url": { type: "string" }, app: { type: "string" },
        sku: { type: "string", multiple: true }, configuration: { type: "string" }, "as-of": { type: "string" },
      },
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_"))) throw error;
    return emit(invalidSettingsCommand(), 64);
  }
  const { values, positionals: [command, key, ...extra] } = parsed;
  json = values.json === true;
  if (values.help) {
    io.write((json ? JSON.stringify({ schemaVersion: 1, help }) : help) + "\n");
    return 0;
  }
  const preview = command === "preview";
  const invalid = (field?: string, hint?: string) => emit(preview
    ? refuseSettingsPreview("commerce_setting_preview_input_invalid", field && hint ? { path: [field], hint } : undefined)
    : invalidSettingsCommand(), 64);
  const databaseUrl = values["database-url"];
  if (extra.length || (command === "list" ? key !== undefined : !key)
    || (values.goal !== undefined && command !== "list") || (databaseUrl !== undefined && command !== "show" && !preview)
    || (!preview && (values.value !== undefined || values.sku || values.configuration !== undefined || values["as-of"] !== undefined))
    || values.app === "" || values.configuration === "") return invalid();
  if (databaseUrl !== undefined) {
    const url = URL.parse(databaseUrl);
    if (!url?.hostname || !["postgres:", "postgresql:"].includes(url.protocol))
      return invalid("database-url", "Supply a PostgreSQL URL with the intended store's host.");
  }
  if (command === "list") return emit(listSettings({ goal: values.goal }), values.goal?.trim() === "" ? 64 : undefined);
  if (command === "explain") return emit(explainSetting(key!));
  if (command !== "show" && !preview) return invalid();

  let proposed: unknown;
  if (preview) {
    if (values.value === undefined) return invalid("proposed", "Pass the proposed JSON with --value.");
    try { proposed = JSON.parse(values.value === "-" ? await io.readStdin() : values.value); }
    catch (error) {
      return emit(refuseSettingsPreview("commerce_setting_preview_json_invalid"), error instanceof SyntaxError ? 64 : 74);
    }
  }
  const input = { key, proposed, skus: values.sku, asOf: values["as-of"] };
  const unavailable = (hint?: string) => {
    const refusal = loadSettingsCatalogue().byCode.get("commerce_setting_read_unavailable")!;
    return { refusal: hint ? { ...refusal, hint } : refusal };
  };
  const needsApp = () => refuseSettingsPreview("commerce_setting_preview_connection_required", {
    path: ["app"], hint: "Pass --app <module> for the shop's stock source and configuration.",
  });
  async function dispatch(): Promise<[Result, number?]> {
    if (command === "show") {
      const offline = await showSetting({ key });
      if (!databaseUrl || "refusal" in offline || offline.setting.kind !== "installed") return [offline];
    }
    if (preview) {
      const offline = await previewSetting(input);
      if (offline.refusal.code !== "commerce_setting_preview_connection_required") {
        return [offline, offline.refusal.code === "commerce_setting_preview_input_invalid" ? 64 : undefined];
      }
      if (values.configuration !== undefined && !values.app) return [needsApp()];
    }
    if (databaseUrl && !host) return [preview ? needsApp() : unavailable(), 74];
    const bindings = (databaseUrl || (values.app && values.configuration !== undefined))
      ? await host?.bind({ databaseUrl, app: values.app, configuration: values.configuration }) : undefined;
    try {
      if (bindings && "configurationIds" in bindings) {
        const id = values.configuration ?? "";
        return [refuseSettingsPreview("commerce_setting_preview_configuration_unknown", {
          path: ["configuration"], hint: `Unknown configuration ${id.includes("://") ? "ID" : JSON.stringify(id)}. Use one of these IDs: ${bindings.configurationIds.join(", ")}.`,
        }), 64];
      }
      if (preview) {
        const result = await previewSetting(input, bindings?.previewers);
        if ("refusal" in result) {
          if (result.refusal.code === "commerce_setting_preview_unexpected") return [result, 74];
          if (databaseUrl && !values.app && result.refusal.code === "commerce_setting_preview_connection_required") return [needsApp()];
        }
        return [result];
      }
      if (key === "checkout_recovery_reminders" && !bindings?.readers?.[key])
        return [unavailable("Pass --app <module> for the shop's checkout reminder policy.")];
      const result = await showSetting({ key }, bindings?.readers);
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
