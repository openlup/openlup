import { parseArgs } from "node:util";
import { type z, type ZodType } from "zod";
import type { SettingDescriptor, SettingRefusal } from "../contracts/settings.js";
import { catalogueWithAppSettings, listCatalogueSettings, loadSettingsCatalogue, moneyLimitsOwnerReaderKey, moneyLimitsSettingKey, moneyLimitsUnbound, moneyLimitsUnavailable } from "./settingsCatalog.js";
import {
  appFileValue, appUnavailable, checkApp, checkDocument, checkErrorMessage, declaredSettings, errorMessage, loadAppBindings,
  type AppSetting, type FileBinding,
} from "./settingsAppCheck.js";
import { formatCheckText, formatConfigurationHint, formatSettingsText, mcpHelp, settingsHelpText, type SettingsCommandResult } from "./settingsCommandFormat.js";
import { admitDatabaseUrl, bindSettingsPasswordDescriptor, refuseCoverageRead, refuseMoneyLimitsRead, type AppValidation } from "./settingsCommandSupport.js";
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
  ssl: false | { rejectUnauthorized: true; host: string };
};
type SettingsHost = {
  bind(input: { database?: SettingsDatabase; app?: string; configuration?: string }): Promise<SettingsAppBindings & { close?(): Promise<void> }>;
  loadCheck?(input: { app: string; configuration?: string }): Promise<SettingsAppBindings | undefined>;
  formatPreview?(result: PreviewDocument): string;
  previewResultSchema?: ZodType;
  runTool?(argv: readonly string[], stdin: string): Promise<{ exit: number; stdout: string }>;
};
type SettingsIo = { write(text: string): void; warn?(text: string): void; readStdin(): Promise<string>; input?: AsyncIterable<Buffer> };

const missingAppHint = "Check the --app path and the createSettingsBindings export.";

/** @experimental Run the settings CLI without owning process I/O or application bindings. */
export async function runSettingsCommand(argv: readonly string[], io: SettingsIo, host?: SettingsHost): Promise<number> {
  let json = argv.includes("--json");
  const emit = (result: SettingsCommandResult, code = "refusal" in result ? 1 : 0) => {
    io.write((json ? JSON.stringify("schemaVersion" in result ? result : { schemaVersion: 1, ...result }) : formatSettingsText(result, host)) + "\n");
    return code;
  };
  let preview = false;
  const invalid = (field?: string, hint?: string) => {
    const result = preview ? refuseSettingsPreview("commerce_setting_preview_input_invalid") : invalidSettingsCommand();
    return emit(field && hint ? { ...result, refusal: { ...result.refusal, path: [field], hint } } : result, 64);
  };
  if (argv[0] === "mcp") {
    if (argv.includes("--help")) {
      io.write((json ? JSON.stringify({ schemaVersion: 1, help: mcpHelp }) : mcpHelp) + "\n");
      return 0;
    }
    if (argv.some(arg => /^--database-password-fd(?:=|$)/u.test(arg))) return invalid();
    // Hosts must route process output away from the protocol stream they pass as io.write.
    // Hosts must supply a strict preview result schema, since the output gate accepts what that schema admits.
    if (!io.input || !host?.previewResultSchema) return invalid();
    // Load the loop after CLI initialization. Tools call this command for the ordinary settings operations.
    const { runSettingsMcp, settingsMcpContext } = await import("./settingsMcp.js");
    const { context, hint } = settingsMcpContext(argv.slice(1));
    if (!context) {
      io.warn?.(hint + "\n");
      return 64;
    }
    if (context.app && host.loadCheck) {
      const loaded = await loadAppBindings(host, context.app, context.configuration);
      if (loaded.status === "missing" || loaded.status === "failed") {
        const failure = loaded.status === "failed" ? errorMessage(loaded.error, "") || missingAppHint : missingAppHint;
        io.warn?.(`Settings app: ${failure}\n`);
        return 74;
      }
      if (loaded.status === "unknown-configuration") {
        io.warn?.(`${formatConfigurationHint(context.configuration, loaded.configurationIds)}\n`);
        return 64;
      }
    }
    await runSettingsMcp(io.input, line => io.write(line), context, host, host.previewResultSchema);
    return 0;
  }
  const parser = {
    args: [...argv], allowPositionals: true, tokens: true as const,
    options: {
      goal: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
      value: { type: "string", multiple: true }, "database-url": { type: "string" }, "database-password-fd": { type: "string", multiple: true }, app: { type: "string" },
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
    const usage = settingsHelpText(command);
    io.write((json ? JSON.stringify({ schemaVersion: 1, help: usage }) : usage) + "\n");
    return 0;
  }
  const passwordFd = values["database-password-fd"];
  if (passwordFd && (passwordFd.length !== 1 || passwordFd[0] !== "3" || (command !== "show" && command !== "preview")))
    return invalid("database-password-fd", "Use descriptor 3 only with connected show or preview.");
  const invalidConfiguration = (ids: readonly string[]) => ({ refusal: { ...invalidSettingsCommand().refusal,
    path: ["configuration"], hint: formatConfigurationHint(values.configuration, ids) } });
  if (command === "check") {
    if (values["database-url"] !== undefined) return invalid("database-url", "Settings check is offline. Use settings preview with --database-url for connected effects.");
    if (!values.app) return invalid("app", "Pass --app <module> that exports createSettingsBindings.");
    if (key !== undefined) return invalid("key", "Settings check reports all catalogue keys. Omit the key.");
    const unsupported = (["goal", "value", "sku", "as-of"] as const).find(flag => values[flag] !== undefined);
    if (unsupported) return invalid(unsupported, `Omit --${unsupported} when running settings check.`);
    const report = async (file: FileBinding | undefined, validation: AppValidation, declarations?: ReadonlyMap<string, AppSetting>) => {
      const result = await checkDocument(file, validation, declarations);
      io.write((json ? JSON.stringify(result) : formatCheckText(result)) + "\n");
      return result.state === "checked" ? 0 : result.state === "invalid" ? 1 : 2;
    };
    const loaded = await loadAppBindings(host, values.app, values.configuration);
    if (loaded.status === "failed") {
      return report(undefined, { state: "failed", phase: "load", message: checkErrorMessage(loaded.error) });
    }
    if (loaded.status === "missing") {
      const refusal = loadSettingsCatalogue().byCode.get("commerce_setting_read_unavailable")!;
      return emit({ refusal: { ...refusal, path: ["app"], rule: "The settings app must supply a binding factory.",
        hint: missingAppHint,
        remediation: { retry: true, action: "Fix the module path or export and rerun.", command: "openlup settings check --help" },
      } }, 74);
    }
    if (loaded.status === "unknown-configuration") {
      return emit(invalidConfiguration(loaded.configurationIds), 64);
    }
    const admitted = declaredSettings(loaded.bindings.file, io.warn);
    if ("refusal" in admitted) return emit(admitted, 64);
    return report(loaded.bindings.file, await checkApp(loaded.bindings.file), admitted.declarations);
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
    || (!preview && (values.value !== undefined || values.sku || (values.configuration !== undefined && !values.app) || values["as-of"] !== undefined))
    || values.app === "") return invalid();
  if (!preview && invalidDatabase) return invalid("database-url", invalidDatabase.hint);
  if (command !== "list" && command !== "explain" && command !== "show" && !preview) return invalid();

  if (passwordFd) {
    const hint = "Supply one UTF-8 password line through the pipe on descriptor 3 with a passwordless TCP database URL.";
    if (!database || parsed.tokens.filter(token => token.kind === "option" && token.name === "database-url").length !== 1
      || typeof database.password !== "function" || /^[^:]+:\/\/[^@/]*:/u.test(databaseUrl!))
      return invalid("database-password-fd", hint);
    try { database.password = await bindSettingsPasswordDescriptor(3); }
    catch { return invalid("database-password-fd", hint); }
  }

  const listInput = { goal: values.goal };
  const offline = command === "list" ? listSettings(listInput)
    : command === "explain" ? explainSetting(key!)
    : command === "show" ? await showSetting({ key }) : undefined;
  if (offline && (command !== "show" || !databaseUrl || "refusal" in offline
    || !("setting" in offline) || offline.setting.kind !== "installed")) {
    const exit = command === "list" && "refusal" in offline ? 64 : undefined;
    const packaged = command !== "list" && !("refusal" in offline);
    if (!values.app || exit !== undefined || (values.configuration === undefined && (!host?.loadCheck || packaged))) {
      return emit(offline, exit);
    }
    const loadFailure = (hint: string, status: number) => {
      if (command === "list") {
        io.warn?.(`Settings app: ${hint}\n`);
        return emit("entries" in offline ? { ...offline, appBindingWarning: hint } : offline, exit);
      }
      return emit(appUnavailable(["app"], hint, `openlup settings ${command} <key> --app <module>`), status);
    };
    const loaded = await loadAppBindings(host, values.app, values.configuration);
    if (loaded.status === "failed") return loadFailure(errorMessage(loaded.error), 1);
    if (loaded.status === "missing") return loadFailure(missingAppHint, 74);
    if (values.configuration !== undefined && loaded.status === "unknown-configuration") {
      return emit(invalidConfiguration(loaded.configurationIds), 64);
    }
    if (packaged) return emit(offline, exit);
    const file = loaded.status === "loaded" ? loaded.bindings.file : undefined;
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
  const unavailable = (detail?: string | Partial<Pick<SettingRefusal, "path" | "rule" | "hint" | "remediation">>) => {
    const refusal = loadSettingsCatalogue().byCode.get("commerce_setting_read_unavailable")!;
    return {
      refusal: typeof detail === "string" ? { ...refusal, hint: detail } : detail ? { ...refusal, ...detail } : refusal,
    };
  };
  const needsApp = (field = "app") => refuseSettingsPreview("commerce_setting_preview_connection_required", {
    path: [field], hint: "Pass --app <module> for the shop's stock source and configuration.",
  });
  const appUnsupported = async (): Promise<[SettingsCommandResult, number?] | undefined> => {
    if (!key || !values.app || !host?.loadCheck || loadSettingsCatalogue().entries.some(entry => entry.key === key)) {
      return undefined;
    }
    const loaded = await loadAppBindings(host, values.app, values.configuration);
    if (loaded.status === "loaded") {
      const admitted = declaredSettings(loaded.bindings.file);
      if ("declarations" in admitted && admitted.declarations.has(key)) {
        return [refuseSettingsPreview("commerce_setting_preview_unsupported", {
          path: ["key"],
          hint: `${key} is an application setting without a preview. Read it with settings show ${key} and validate an edit with settings check.`,
        })];
      }
    }
    return undefined;
  };
  async function dispatch(): Promise<[SettingsCommandResult, number?]> {
    const resolveConfiguration = preview && values.configuration !== undefined;
    if (preview && !resolveConfiguration && !invalidDatabase) {
      const offline = await previewSetting(input);
      if (offline.refusal.code === "commerce_setting_unknown") {
        return (await appUnsupported()) ?? [offline];
      }
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
        if (!preview) return [invalidConfiguration(bindings.configurationIds), 64];
        return [refuseSettingsPreview("commerce_setting_preview_configuration_unknown", {
          path: ["configuration"], hint: formatConfigurationHint(values.configuration, bindings.configurationIds),
        }), 64];
      }
      if (preview) {
        if (invalidDatabase) return [refuseSettingsPreview("commerce_setting_preview_input_invalid", invalidDatabase), 64];
        const result = await previewSetting(input, database ? bindings?.previewers : undefined);
        if ("refusal" in result) {
          if (result.refusal.code === "commerce_setting_preview_input_invalid") return [result, 64];
          if (result.refusal.code === "commerce_setting_preview_unexpected") return [result, 74];
          if (result.refusal.code === "commerce_setting_unknown") return (await appUnsupported()) ?? [result];
          if (databaseUrl && !values.app && result.refusal.code === "commerce_setting_preview_connection_required") return [needsApp()];
        }
        return [result];
      }
      const readers = bindings?.readers;
      const limitsShow = key === moneyLimitsSettingKey;
      const readerKey = limitsShow ? moneyLimitsOwnerReaderKey : key!;
      if (!readers || !Object.hasOwn(readers, readerKey) || typeof readers[readerKey] !== "function") {
        if (limitsShow) return [refuseMoneyLimitsRead(undefined, true), 74];
        if (key === "tax.coverage") return [refuseCoverageRead(undefined), 74];
        return [unavailable(host && !values.app ? {
          rule: "A connected read requires an application settings reader for this key.",
          hint: "Pass --app <module> that supplies a reader for this setting.",
          remediation: {
            retry: true,
            action: "Pass --app <module> with a reader for this key, or omit --database-url for offline discovery.",
            command: "npm --silent run settings -- show <key> --json",
          },
        } : {
          rule: "No connected reader is registered for this setting key.",
          hint: "No connected reader exists for this key. Omit --database-url for offline discovery.",
          remediation: {
            retry: false,
            action: "Omit --database-url to inspect this setting offline.",
            command: "npm --silent run settings -- show <key> --json",
          },
        })];
      }
      const result = await showSetting({ key }, limitsShow ? { [moneyLimitsSettingKey]: readers[readerKey]! } : readers);
      const failed = "refusal" in result && ["commerce_setting_read_unavailable", moneyLimitsUnbound, moneyLimitsUnavailable].includes(result.refusal.code);
      return [result, failed ? 74 : undefined];
    } finally { await bindings?.close?.(); }
  }
  let outcome: [SettingsCommandResult, number?];
  try { outcome = await dispatch(); }
  catch (error) {
    if (!preview && key === moneyLimitsSettingKey) return emit(refuseMoneyLimitsRead(error), 74);
    if (!preview && key === "tax.coverage") return emit(refuseCoverageRead(error), 74);
    const hint = error instanceof Error && error.message === "NODE_PG_FORCE_NATIVE"
      ? "Unset NODE_PG_FORCE_NATIVE for this command to use the JavaScript PostgreSQL client, then retry."
      : "Check the read-capable database connection and that --app exports createSettingsBindings.";
    outcome = [preview ? refuseSettingsPreview("commerce_setting_preview_unexpected", { path: [], hint }) : unavailable(hint), 74];
  }
  return emit(...outcome);
}
