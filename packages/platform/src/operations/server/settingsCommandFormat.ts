import type { z } from "zod";
import type { CheckDocument } from "./settingsAppCheck.js";
import type { catalogueWithAppSettings } from "./settingsCatalog.js";
import type { explainSetting, listSettings, previewSetting, showSetting } from "./settingsRead.js";

type PreviewDocument = { schemaVersion: 1 };

export type SettingsCommandResult = Awaited<ReturnType<typeof previewSetting<PreviewDocument>>>
  | ReturnType<typeof listSettings>
  | Awaited<ReturnType<typeof showSetting>>
  | ReturnType<typeof explainSetting>
  | z.infer<ReturnType<typeof catalogueWithAppSettings>["appShowResult"]>;

const help = `openlup settings (experimental) list [--goal <text>] | show <key> | preview <key> --value <json-or-> | explain <refusal-code-or-key> | check --app <module> [--configuration <id>]
openlup settings mcp [--app <module>] [--configuration <id>] [--database-url <url>]
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
  npm --silent run settings -- explain commerce_setting_unknown
  npm --silent run settings -- check --app <module> [--configuration <id>] --json`;

const listHelp = `openlup settings (experimental) list [--goal <text>] [--app <module>] [--configuration <id>] [--json]
Search platform and declared application settings by goal words, or omit --goal to list everything.
Exit codes: 0 completed, 1 refused, 64 invalid syntax or input, 74 operation unavailable.

Examples:
  npm --silent run settings -- list --goal "renewal stock protection horizon"
  npm --silent run settings -- list --app <module> --json`;

const showHelp = `openlup settings (experimental) show <key> [--app <module>] [--configuration <id>] [--database-url <read-capable-url>] [--json]
Read one setting by key: owner, rules, default behavior, and current observation (offline, file, or connected database).
Exit codes: 0 completed, 1 refused, 64 invalid syntax or input, 74 operation unavailable.

Examples:
  npm --silent run settings -- show inventory_renewal_protection --json
  npm --silent run settings -- show inventory_renewal_protection --database-url <read-capable-url> --json`;

const previewHelp = `openlup settings (experimental) preview <key> --value <json-or-> --database-url <read-capable-url> [--app <module>] [--configuration <id>] [--sku <sku>]... [--as-of <UTC-ISO-instant>] [--json]
Preview the effect of a proposed value without writing anything.
Pass --value - to read one JSON value from stdin or --value=-1 for a negative number.
Exit codes: 0 completed (including invalid-policy preview), 1 refused, 64 invalid syntax or input, 74 operation unavailable.

Example:
  npm --silent run settings -- preview inventory_renewal_protection --value '{"revision":"store-1","renewalProtectionDays":21}' --database-url <read-capable-url> --sku <sku> --json`;

const explainHelp = `openlup settings (experimental) explain <refusal-code-or-key> [--app <module>] [--configuration <id>] [--json]
Explain a refusal code returned by another command, or the offline behavior of a setting key.
Exit codes: 0 completed, 1 refused, 64 invalid syntax or input, 74 operation unavailable.

Examples:
  npm --silent run settings -- explain commerce_setting_unknown
  npm --silent run settings -- explain checkout_recovery_reminders --json`;

export const mcpHelp = `openlup settings (experimental) mcp [--app <module>] [--configuration <id>] [--database-url <read-capable-url>]
Run the read-only JSON-RPC stdio MCP server exposing settings_list, settings_show, settings_explain, settings_check, and settings_preview.
Exit codes: 0 completed, 64 invalid syntax or configuration, 74 app module or factory not found.`;

const checkHelp = `openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)
Check reported file values against available setting schemas and run the application's optional startup validation.
Exit codes: 0 checked, 1 invalid, 2 no file member, 64 invalid syntax or configuration, 74 app module or factory not found.`;

const helpByCommand: Record<string, string> = {
  list: listHelp,
  show: showHelp,
  preview: previewHelp,
  explain: explainHelp,
  mcp: mcpHelp,
  check: checkHelp,
};

export function settingsHelpText(command?: string): string {
  return (command && Object.hasOwn(helpByCommand, command) ? helpByCommand[command] : undefined) ?? help;
}

export function formatConfigurationHint(configuration: string | undefined, ids: readonly string[]): string {
  const id = configuration ?? "";
  return `Unknown configuration ${id.includes("://") ? "ID" : JSON.stringify(id)}. Use one of these IDs: ${ids.join(", ")}.`;
}

export function formatSettingsText(
  result: SettingsCommandResult,
  host?: { formatPreview?(result: PreviewDocument): string },
): string {
  if ("refusal" in result || "explanation" in result) {
    const { code, rule, hint, remediation } = "refusal" in result ? result.refusal : result.explanation;
    return [code, rule, hint, remediation.action, remediation.command].filter(line => line !== undefined).join("\n");
  }
  if ("entries" in result) {
    const lines: string[] = [];
    if (result.appBindingWarning) {
      lines.push(`Warning: application settings unavailable — ${result.appBindingWarning}`);
    }
    if (result.entries.length) {
      if (result.partialMatch) {
        lines.push("Partial matches (not all goal words matched):");
      }
      lines.push(...result.entries.map(({ key, kind, runtime, goal, change }) => [
        `${key} (${kind}, ${runtime.level})`, `  ${goal}`,
        ...((kind === "cap" || kind === "invariant") && "reason" in runtime ? [`  ${runtime.reason}`] : []),
        `  Change: ${Object.values(change).join(" ")}`,
      ].join("\n")));
    } else {
      lines.push("No settings matched the goal.\nTry fewer or different words, or run list without --goal.");
    }
    return lines.join("\n");
  }
  if (!("setting" in result)) return host?.formatPreview?.(result) ?? JSON.stringify(result, null, 2);
  const { setting, observation } = result;
  return [setting.key + " — " + setting.goal, `Owner: ${setting.domain}`,
    `Kind: ${setting.kind} (${setting.runtime.level})`,
    ...("reason" in setting.runtime ? [setting.runtime.reason] : []),
    ...("effect" in setting ? [
      `Default: ${setting.fallback === null ? "none (see behavior below)" : JSON.stringify(setting.fallback)}`,
      `Basis: ${setting.defaultBasis.kind}${setting.defaultBasis.kind === "reference-code" ? " (matches the reference deployment’s code)" : ""}`,
      setting.whyThisDefault, ...(setting.absentMeans ? [setting.absentMeans.description] : []),
      `Schema: ${JSON.stringify(setting.schema)}`, `Effect: ${setting.effect.appliesTo}`,
      `Frozen on: ${setting.effect.frozenOn.join(" ") || "No records named"}`,
    ] : []),
    `Change: ${Object.values(setting.change).join(" ")}`, `Observation: ${JSON.stringify(observation)}`].join("\n");
}

export function formatCheckText({ appValidation, configuration, rows, state }: CheckDocument): string {
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
          ? ` at ${row.validation.paths.map((path, index) => {
            const label = row.key === "tax.coverage" ? "/" + path.join("/") : path.join(".") || "<value>";
            const message = row.validation.state === "invalid" ? row.validation.messages?.[index] : undefined;
            return message ? `${label}: ${message}` : label;
          }).join(", ")}` : ""}`,
        ...(source ? [`  ${source.file} · ${source.symbol}`] : []),
        ...(file.state === "present" ? [`  Value: ${JSON.stringify(file.value)}`] : file.state === "unreportable" ? [`  ${file.message}`] : []),
        `  Effect: ${row.effect} Change: ${row.takesEffect}`,
        ...(row.store ? [`  Store: not checked. ${row.note}`] : []),
      ];
    }),
  ].join("\n");
}
