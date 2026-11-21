#!/usr/bin/env node
// Tool-only Node entry; importing platform engine entries never starts this CLI.
import { Console } from "node:console";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const help = `openlup upgrade plan|apply --root DIR --from SNAPSHOT.json --to SNAPSHOT.json --schema-version N [--json]
openlup verify [--app ./application-observations.mjs] [--json]
openlup catalogue check --packs ./owned/catalogue.json [--json]
openlup catalogue project --trusted-packs ./owned/catalogue.ts [--json]
openlup settings list|show|preview|explain [--help] [--json] (experimental)
openlup settings mcp [--app <module>] [--configuration <id>] [--database-url <url>] (experimental, read-only stdio)
openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)

Upgrade snapshots use the existing AppVersionSnapshot contract. All unlisted paths are application-owned; upstream-unchanged files preserve local edits. Apply requires an exclusive maintenance window. Rerun identical inputs to resume. No SQL, package installation or hooks run.
Verify loads no app implicitly. --app explicitly trusts and imports application code exporting createVerificationInput(); that module must only assemble observations and read-only probes, must not write stdout, and must close its own resources before returning/report completion. The CLI does not sandbox that module. Only the supplied schema observer is invoked by diagnosis; routes and jobs never run.
Catalogue check reads inert JSON. Catalogue project imports an explicitly trusted module exporting catalogueConformance with the operator’s process permissions and checks an external scratch subject. PASS grants no install, migration, publication or activation authority.
Settings reads the catalogue offline by default. Connected show and preview use --database-url and explicit --app bindings where needed. Preview takes --value <json> or --value - for stdin. Settings JSON uses schemaVersion=1. A completed preview with an invalid policy exits 0, refusals exit 1, invalid syntax/input exits 64, and unavailable operations exit 74. For settings check, a missing app module or factory export exits 74, while a module that throws during loading or binding exits 1 with the cause.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 2 unknown, 64 invalid invocation/JSON, 74 unavailable operation. JSON uses formatVersion=1, one object on stdout.
`;
let json = process.argv.slice(2).includes("--json");
let validatingInput = true;
let appStage = 0;
let inventorySettingKey;

function emit(value, text) {
  process.stdout.write(json ? `${JSON.stringify({ formatVersion: 1, ...value })}\n` : `${text}\n`);
  process.exitCode = value.exitCode;
}

function renderFinding(finding) {
  return `${finding.code}${finding.package ? ` ${finding.package}${finding.module ? `/${finding.module}` : ""} ${finding.subject}` : ""}\nObserved: ${finding.observed}\nCause: ${finding.cause}\nFix: ${finding.fix}\nRecheck: ${finding.recheck}\nDeclared: ${finding.evidence.declared}\nBound: ${finding.evidence.bound}\nChecked: ${finding.evidence.checked}\nUnknown: ${finding.evidence.unknown.join(" ")}`;
}

function refuse(exitCode, code, observed, fix, cause = exitCode === 64 ? "Invalid command or input syntax." : "Snapshot admission, a filesystem operation or trusted application loading failed.") {
  const finding = { code, observed, cause, fix, recheck: "Rerun the same command after repair.", evidence: { declared: "Not established", bound: "Not established", checked: "The command could not complete", unknown: ["Remaining application and filesystem state"] } };
  emit({ command: "openlup", state: exitCode === 64 ? "refused" : "failed", exitCode, findings: [finding] }, `${renderFinding(finding)}\n${help}`);
}

async function bindSettings({ database, app, configuration }) {
  let db;
  if (database) {
    const { Pool, Client } = await import("pg");
    if (typeof Client.prototype.getStartupConf !== "function") throw new Error("NODE_PG_FORCE_NATIVE");
    db = new Pool(database);
  }
  db?.on("error", () => {});
  const close = async () => { await db?.end(); };
  try {
    let overrides = {};
    if (app) {
      const { createSettingsBindings } = await import(pathToFileURL(resolve(app)).href);
      overrides = await createSettingsBindings({ db, configuration });
    }
    if (!db || "configurationIds" in overrides) return { ...overrides, close };
    // eslint-disable-next-line no-restricted-syntax -- tool entry composes existing installed capabilities only for connected settings
    const { describeRenewalStockProtectionSetting, readRenewalStockProtectionOverride, previewRenewalStockProtection } = await import("@openlup/platform/inventory");
    const inventory = describeRenewalStockProtectionSetting().key;
    inventorySettingKey = inventory;
    return {
      readers: {
        [inventory]: async () => {
          const policy = await readRenewalStockProtectionOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        ...overrides.readers,
      },
      previewers: {
        ...(overrides.stockSourceKey ? {
          [inventory]: (value, options) => previewRenewalStockProtection(inventory, value, { ...options, db, sourceKey: overrides.stockSourceKey }),
        } : {}),
        ...overrides.previewers,
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

async function loadSettingsCheck({ app, configuration }) {
  const path = resolve(app);
  try { await fs.access(path); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  }
  const { createSettingsBindings } = await import(pathToFileURL(path).href);
  if (typeof createSettingsBindings !== "function") return undefined;
  return { ...await createSettingsBindings({ db: undefined, configuration }) };
}

function formatSettingsPreview(result) {
  if (!inventorySettingKey || result.key !== inventorySettingKey) return JSON.stringify(result, null, 2);
  const { key, asOf, current, proposed, difference, validation, effect, uncertainty } = result;
  return [
    `${key} at ${asOf}`,
    `Current: ${JSON.stringify(current)}`,
    `Proposed: ${JSON.stringify(proposed)}`,
    `Horizon difference in days: ${difference?.renewalProtectionDays ?? "unavailable"}`,
    `Validation: ${validation.state}`,
    ...(validation.state === "valid" ? [`Normalized: ${JSON.stringify(validation.value)}`]
      : [validation.code, validation.rule, validation.hint, validation.remediation.action, validation.remediation.command]),
    "Existing reservations keep their quantities and expiry times.",
    `New purchase availability: ${effect.newPurchaseAvailability}`,
    ...effect.skus.map(row => `${row.sku}: ${row.currentAvailableForNewPurchases ?? "unavailable"} currently available, ${row.proposedAvailableForNewPurchases ?? "unavailable"} estimated under the proposal (${row.source}${row.stale ? ", stale" : ""})`),
    uncertainty,
  ].join("\n");
}

async function main(args) {
  if (args[0] === "settings") {
    validatingInput = false;
    const host = { bind: bindSettings, loadCheck: loadSettingsCheck, formatPreview: formatSettingsPreview };
    // eslint-disable-next-line no-restricted-syntax -- tool entry loads the existing installed server subpath only for settings
    const { runSettingsCommand } = await import("@openlup/platform/operations/server");
    const readStdin = async () => {
      process.stdin.setEncoding("utf8");
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      return text;
    };
    const io = { write: text => process.stdout.write(text), warn: text => process.stderr.write(text), readStdin };
    const settingsArgs = args.slice(1);
    let commandIndex = 0;
    while (/^--(?:app|configuration|database-url)(?:=|$)/u.test(settingsArgs[commandIndex] ?? "")) {
      const inline = settingsArgs[commandIndex].includes("=");
      if (!inline && /^-./u.test(settingsArgs[commandIndex + 1] ?? "")) break;
      commandIndex += inline ? 1 : 2;
    }
    if (settingsArgs[commandIndex] === "mcp") {
      const mcpArgs = ["mcp", ...settingsArgs.slice(0, commandIndex), ...settingsArgs.slice(commandIndex + 1)];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = process.stderr.write.bind(process.stderr);
      globalThis.console = new Console(process.stderr);
      // eslint-disable-next-line no-restricted-syntax -- tool entry uses the same public preview contract as the catalogue generator
      const { renewalStockProtectionPreviewResult } = await import("@openlup/platform/inventory");
      process.exitCode = await runSettingsCommand(mcpArgs, { ...io, write, input: process.stdin },
        { ...host, previewResultSchema: renewalStockProtectionPreviewResult });
    } else {
      process.exitCode = await runSettingsCommand(settingsArgs, io, host);
    }
    return;
  }
  const { values, positionals } = parseArgs({
    args, options: {
      json: { type: "boolean" }, help: { type: "boolean" },
      root: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      "schema-version": { type: "string" }, app: { type: "string" }, packs: { type: "string" }, "trusted-packs": { type: "string" },
    }, strict: true, allowPositionals: true,
  });
  json = values.json === true;
  if (values["trusted-packs"] !== undefined && (positionals[0] !== "catalogue" || positionals[1] !== "project" || values.packs !== undefined || values.app !== undefined)) {
    refuse(64, "OPENLUP_E_CLI_INPUT", "Trusted pack paths are exclusive to catalogue project.", "Use one documented catalogue input flag.");
  } else if (values.help) {
    emit({ command: "help", state: "complete", exitCode: 0, help }, help.trimEnd());
  } else if (positionals[0] === "upgrade" && ["plan", "apply"].includes(positionals[1]) && positionals.length === 2 && values.app === undefined && values.packs === undefined && values.root && values.from && values.to && /^(0|[1-9][0-9]*)$/u.test(values["schema-version"] ?? "") && Number.isSafeInteger(Number(values["schema-version"]))) {
    const command = `upgrade ${positionals[1]}`;
    const requestedRoot = resolve(values.root);
    const stat = await fs.lstat(requestedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("invalid_root");
    const input = {
      root: await fs.realpath(requestedRoot),
      from: JSON.parse(await fs.readFile(resolve(values.from), "utf8")),
      to: JSON.parse(await fs.readFile(resolve(values.to), "utf8")),
      schemaVersion: Number(values["schema-version"]),
    };
    validatingInput = false;
    // eslint-disable-next-line no-restricted-syntax -- tool entry, not a platform module: it loads the installed package's published entry by name, exactly as an adopter's process would; the module graph forbids this for modules, and the file lives in lifecycle only because src holds module directories only
    const { planAppUpgrade, applyAppUpgrade, AppUpgradeConflictError } = await import("@openlup/platform/lifecycle");
    const boundary = "Only explicit snapshot paths are upgrade-managed. All unlisted files are application-owned. Upstream-unchanged paths preserve local edits. No SQL, installs, deployment, version marker or hooks run. Apply needs exclusive access; a complete upgrade is not atomic.";
    const describe = plan => plan.files.map(file => ({ ...file, ownership: file.action === "preserved" || file.action === "unchanged" ? "locally-customizable" : "upgrade-managed" }));
    try {
      const result = positionals[1] === "plan" ? { plan: await planAppUpgrade(input), applied: [] } : await applyAppUpgrade(input);
      const exitCode = result.plan.conflicts.length ? 1 : 0;
      emit({ command, state: exitCode ? "refused" : "complete", exitCode, boundary, ownership: { unlisted: "application-owned" }, ...result, files: describe(result.plan) }, `${command}: ${exitCode ? "refused" : "complete"}\n${boundary}\n${describe(result.plan).map(file => `${file.path}: ${file.action} (${file.ownership})`).join("\n")}\n${result.plan.conflicts.map(item => `${item.path || "schema"}: ${item.reason}`).join("\n")}`.trimEnd());
    } catch (error) {
      if (!(error instanceof AppUpgradeConflictError)) throw error;
      emit({ command, state: "refused", exitCode: 1, boundary, conflicts: error.conflicts, applied: [] }, `${command}: refused before any write\n${boundary}\n${error.conflicts.map(item => `${item.path || "schema"}: ${item.reason}`).join("\n")}\nFix: reconcile touched files with the predecessor or candidate snapshot, then rerun the same command.`);
    }
  } else if (positionals.length === 1 && positionals[0] === "verify" && ![values.packs, values.root, values.from, values.to, values["schema-version"]].some(value => value !== undefined)) {
    if (values.app === "") throw new TypeError("empty_app_path");
    validatingInput = false;
    // eslint-disable-next-line no-restricted-syntax -- tool entry, not a platform module: it loads the installed package's published entry by name, exactly as an adopter's process would; the module graph forbids this for modules, and the file lives in lifecycle only because src holds module directories only
    const { verifyApp, APP_VERIFICATION_BOUNDARY } = await import("@openlup/platform/lifecycle");
    const boundary = `${APP_VERIFICATION_BOUNDARY} Explicit --app imports trusted application code, which must not boot a host or execute effects; this is not a sandbox.`;
    if (values.app === undefined) {
      const finding = { code: "OPENLUP_E_APP_UNKNOWN", observed: "No application observations were loaded.", cause: "The CLI does not discover or start application code implicitly.", fix: "Create an application-owned module exporting createVerificationInput(), returning your existing ReadinessInput (actual selected contributions, binding identities and read-only schema observer); pass its path with --app.", recheck: "openlup verify --app ./application-observations.mjs", evidence: { declared: "Unknown", bound: "Unknown", checked: "Nothing loaded", unknown: ["Application composition and schema"] } };
      emit({ command: "verify", state: "unknown", exitCode: 2, boundary, findings: [finding] }, `verify: unknown\n${boundary}\n${renderFinding(finding)}`);
    } else {
      appStage = 1;
      const application = await import(pathToFileURL(resolve(values.app)).href);
      appStage = 2;
      if (typeof application.createVerificationInput !== "function") throw new TypeError("missing_createVerificationInput");
      appStage = 3;
      const input = await application.createVerificationInput();
      appStage = 0;
      const report = await verifyApp(input);
      const appArgument = "'" + values.app.replaceAll("'", "'\"'\"'") + "'";
      const findings = report.findings.map(finding => ({ ...finding, recheck: `openlup verify --app ${appArgument}${json ? " --json" : ""}` }));
      const exitCode = report.state === "ready" ? 0 : report.state === "unknown" ? 2 : 1;
      emit({ command: "verify", exitCode, ...report, findings, boundary }, `verify: ${report.state}\n${boundary}\n${findings.map(renderFinding).join("\n")}`.trimEnd());
    }
  } else if (positionals.length === 2 && positionals[0] === "catalogue"
    && (positionals[1] === "check" ? values.packs : positionals[1] === "project" && values["trusted-packs"])
    && ![values.app, values.root, values.from, values.to, values["schema-version"]].some(value => value !== undefined)) {
    validatingInput = false;
    const { runCatalogue } = await import("./catalogueProject.mjs");
    await runCatalogue(positionals.join(" "), args, values.packs ?? values["trusted-packs"], json, { emit, refuse, renderFinding });
  } else {
    refuse(64, "OPENLUP_E_CLI_INPUT", "Command or required options do not match the public syntax.", "Use openlup --help and explicit input paths.");
  }
}

try { await main(process.argv.slice(2)); } catch (error) {
  // Never print raw application errors, configured values, connection strings or file contents.
  if (appStage === 1) {
    refuse(74, "OPENLUP_E_CLI_FAILURE", "The --app module could not be loaded; raw application errors are withheld.", "Check that the --app path exists, resolves its imports and evaluates without top-level errors.", "Importing the trusted --app module failed before createVerificationInput() could be checked.");
  } else if (appStage === 2) {
    refuse(74, "OPENLUP_E_CLI_FAILURE", "The loaded --app module does not export a createVerificationInput() function.", "Export a createVerificationInput() function returning ReadinessInput from the --app module.", "The trusted --app module loaded, but createVerificationInput was absent or not a function.");
  } else if (appStage === 3) {
    refuse(74, "OPENLUP_E_CLI_FAILURE", "createVerificationInput() failed while assembling observations; raw application errors are withheld.", "Ensure createVerificationInput() assembles read-only ReadinessInput observations and closes its own resources without throwing.", "Executing createVerificationInput() in the trusted --app module failed before readiness evaluation.");
  } else {
    const invalid = validatingInput && (error instanceof SyntaxError || error instanceof TypeError || (typeof error?.code === "string" && error.code.startsWith("ERR_PARSE_ARGS")));
    refuse(invalid ? 64 : 74, invalid ? "OPENLUP_E_CLI_INPUT" : "OPENLUP_E_CLI_FAILURE", "The operation could not complete; raw input and application errors are withheld.", "Check the command, readable JSON snapshots and schema ordinal, the catalogue JSON, or the trusted --app module and its documented export. After a partial upgrade, rerun the identical snapshots under exclusive access.");
  }
}
