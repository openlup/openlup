#!/usr/bin/env node
// Tool-only Node entry; importing platform engine entries never starts this CLI.
import { spawn } from "node:child_process";
import { Console } from "node:console";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, types } from "node:util";

const help = `openlup upgrade plan|apply --root DIR --from SNAPSHOT.json --to SNAPSHOT.json --schema-version N [--json]
openlup verify [--app ./application-observations.mjs] [--json]
openlup catalogue schema [--json]
openlup catalogue check --packs ./owned/catalogue.json [--json]
openlup catalogue project --trusted-packs ./owned/catalogue.ts [--json]
openlup settings list|show|preview|explain [--help] [--json] (experimental)
openlup settings mcp [--app <module>] [--configuration <id>] [--database-url <url>] (experimental, read-only stdio)
openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)
openlup recipe list|show|add|scaffold|verify [--help] [--json] (experimental)

Upgrade snapshots use the existing AppVersionSnapshot contract. All unlisted paths are application-owned; upstream-unchanged files preserve local edits. Apply requires an exclusive maintenance window. Rerun identical inputs to resume. No SQL, package installation or hooks run.
Verify loads no app implicitly. --app explicitly trusts and imports application code exporting createVerificationInput(); that module must only assemble observations and read-only probes, must not write stdout, and must close its own resources before returning/report completion. The CLI does not sandbox that module. Only the supplied schema observer is invoked by diagnosis; routes and jobs never run.
Catalogue check reads inert JSON. Catalogue project imports an explicitly trusted module exporting catalogueConformance with the operator’s process permissions and checks an external scratch subject. PASS grants no install, migration, publication or activation authority.
Settings reads the catalogue offline by default. Connected show and preview use --database-url and explicit --app bindings where needed. Preview takes --value <json> or --value - for stdin. Settings JSON uses schemaVersion=1. A completed preview with an invalid policy exits 0, refusals exit 1, invalid syntax/input exits 64, and unavailable operations exit 74. For settings check, a missing app module or factory export exits 74, while a module that throws during loading or binding exits 1 with the cause.
Recipe commands discover, inspect, scaffold, install into owned/adapters/<domain>/<provider>, and offline-verify (manifest parity, recipe-contract isolation, platform SemVer range, and Stages 1-3 Vitest suites) provider recipes. Passing offline Stages 1-3 never claims Stage 4 live account readiness.
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
  emitRefusal(exitCode, cliFinding(code, observed, cause, fix, "Rerun the same command after repair."));
}

function cliFinding(code, observed, cause, fix, recheck) {
  return { code, observed, cause, fix, recheck, evidence: { declared: "Not established", bound: "Not established", checked: "The command could not complete", unknown: ["Remaining application and filesystem state"] } };
}

function emitRefusal(exitCode, finding, fields = {}) {
  emit({ command: "openlup", state: exitCode === 64 ? "refused" : "failed", exitCode, findings: [finding], ...fields }, `${renderFinding(finding)}\n${help}`);
}

const assemblyDiagnostics = [
  "OPENLUP_E_STARTER_STORE_CONFIG_REQUIRED\n" +
  "Observed: The third argument is missing a starter StoreConfig.\n" +
  "Cause: Native composition needs the selected configuration for its installed-policy checks.\n" +
  "Fix: Pass the selected StoreConfig as argument three and the optional keyring as argument four.\n" +
  "Recheck: Rerun the same readiness check or startup after correcting the call.",
];

function assemblyDiagnostic(error) {
  if (types.isProxy(error) || !types.isNativeError(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  const message = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  return assemblyDiagnostics.find(diagnostic => diagnostic === message);
}

const recheckUpgrade = "Rerun upgrade plan after repair. Apply only after a clear plan.";

function upgradeConflictFinding({ path, reason }) {
  if (path === "") return cliFinding(
    "OPENLUP_E_UPGRADE_SCHEMA_RANGE", reason,
    "The supplied ordinal falls outside a snapshot's declared compatibility range.",
    "Read the verified applied migration count from the same database and installation profile. If status refuses, resolve catalogue or ledger admission there before using a count. Use the observed count and a compatible released snapshot pair. If the ranges do not overlap, stop this hop and use a documented intermediate hop only if one exists. If the database needs a forward migration, follow the application migration chain and observe again. Keep the original pair after apply has written files.",
    recheckUpgrade,
  );
  const diverged = reason === "current bytes match neither predecessor nor candidate";
  return cliFinding(
    "OPENLUP_E_UPGRADE_FILE_CONFLICT", `${path}: ${reason}`,
    diverged ? "A changed managed file diverged from both snapshots." : "A managed path has a spelling, symlink or file type obstruction.",
    diverged
      ? "Save local changes and reconcile to exact predecessor or candidate bytes, including expected absence."
      : "Preserve local data and move the obstruction without following it. Restore the exact predecessor or candidate state with ordinary components and the expected spelling, including absence where required.",
    recheckUpgrade,
  );
}

function refuseUpgradeInput(observed, fix = "Correct the invocation using an ordinary app directory, readable exact JSON snapshots and the observed schema ordinal.") {
  emitRefusal(64, cliFinding("OPENLUP_E_CLI_INPUT", observed, "Invalid command or input syntax.", fix, recheckUpgrade), { conflicts: [] });
}

async function upgrade(verb, values) {
  const ordinal = values["schema-version"] ?? "";
  if (values.app !== undefined || values.packs !== undefined || !values.root || !values.from || !values.to
    || !/^(0|[1-9][0-9]*)$/u.test(ordinal) || !Number.isSafeInteger(Number(ordinal))) {
    refuseUpgradeInput("Upgrade options do not match the public syntax.");
    return;
  }
  const command = `upgrade ${verb}`;
  const boundary = "Only explicit snapshot paths are upgrade-managed. All unlisted files are application-owned. Upstream-unchanged paths preserve local edits. No SQL, installs, deployment, version marker or hooks run. Apply needs exclusive access; a complete upgrade is not atomic.";
  let readingInput = true;
  try {
    const requestedRoot = resolve(values.root);
    const stat = await fs.lstat(requestedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("invalid_root");
    const input = {
      root: await fs.realpath(requestedRoot),
      from: JSON.parse(await fs.readFile(resolve(values.from), "utf8")),
      to: JSON.parse(await fs.readFile(resolve(values.to), "utf8")),
      schemaVersion: Number(ordinal),
    };
    readingInput = false;
    // eslint-disable-next-line no-restricted-syntax -- tool entry, not a platform module: it loads the installed package's published entry by name, exactly as an adopter's process would; the module graph forbids this for modules, and the file lives in lifecycle only because src holds module directories only
    const { planAppUpgrade, applyAppUpgrade, AppUpgradeConflictError } = await import("@openlup/platform/lifecycle");
    let result;
    try {
      result = verb === "plan" ? { plan: await planAppUpgrade(input), applied: [] } : await applyAppUpgrade(input);
    } catch (error) {
      if (!(error instanceof AppUpgradeConflictError)) throw error;
      const findings = error.conflicts.map(upgradeConflictFinding);
      emit({ command, state: "refused", exitCode: 1, boundary, conflicts: error.conflicts, applied: [], findings },
        `${command}: refused before any write\n${boundary}\n${findings.map(renderFinding).join("\n")}`);
      return;
    }
    const { conflicts, ...plan } = result.plan;
    const exitCode = conflicts.length ? 1 : 0;
    const state = exitCode ? "refused" : "complete";
    const files = plan.files.map(file => ({ ...file, ownership: file.action === "preserved" || file.action === "unchanged" ? "locally-customizable" : "upgrade-managed" }));
    const findings = conflicts.map(upgradeConflictFinding);
    emit({ command, state, exitCode, boundary, ownership: { unlisted: "application-owned" }, plan, applied: result.applied, files, conflicts, ...(exitCode ? { findings } : {}) },
      [`${command}: ${state}`, boundary, ...files.map(file => `${file.path}: ${file.action} (${file.ownership})`), ...findings.map(renderFinding)].join("\n"));
  } catch (error) {
    if (readingInput && (error instanceof SyntaxError || error instanceof TypeError)) {
      refuseUpgradeInput("Upgrade requires an ordinary app directory and valid snapshot JSON.");
      return;
    }
    emitRefusal(74, cliFinding("OPENLUP_E_CLI_FAILURE",
      "The upgrade operation could not complete; raw error details are withheld.",
      "Snapshot admission, installed lifecycle loading or a filesystem operation failed.",
      "Check the original snapshots' validity and identity, the app root and filesystem access, and availability of the installed target CLI. If apply failed after writes, restore access and resume with the identical snapshots under exclusive access.",
      recheckUpgrade), { conflicts: [] });
  }
}

function readSettingText(value, code) {
  if (typeof value !== "string" || !value.length) throw new Error(code);
  return value;
}

function readSettingInt(value, min, max, code) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(code);
  return parsed;
}

function readSettingTimestamp(value, code, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(code);
    return value.toISOString();
  }
  return readSettingText(value, code);
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
    const { readAccountSupportOperatorSlideMaxDaysOverride } = await import("@openlup/platform/account-support");
    // eslint-disable-next-line no-restricted-syntax -- tool entry composes existing installed capabilities only for connected settings
    const { describeRenewalStockProtectionSetting, readRenewalStockProtectionOverride, previewRenewalStockProtection } = await import("@openlup/platform/inventory");
    // eslint-disable-next-line no-restricted-syntax -- tool entry composes existing installed capabilities only for connected settings
    const { readPaymentMethodExpiryWarningDaysOverride, readPaymentDeclineNoticeTimingOverride } = await import("@openlup/platform/payments");
    // eslint-disable-next-line no-restricted-syntax -- tool entry composes existing installed capabilities only for connected settings
    const { readPromotionClaimHoldHoursOverride } = await import("@openlup/platform/promotions");
    // eslint-disable-next-line no-restricted-syntax -- tool entry composes existing installed capabilities only for connected settings
    const { readSubscriptionEditQuoteTtlMinutesOverride, readSubscriptionRetryScheduleOverride } = await import("@openlup/platform/subscriptions");
    const inventory = describeRenewalStockProtectionSetting().key;
    inventorySettingKey = inventory;
    return {
      readers: {
        "tax.coverage": async () => ({ refusal: "tax_coverage_reader_unbound" }),
        account_support_operator_slide_max_days: async () => {
          const policy = await readAccountSupportOperatorSlideMaxDaysOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        [inventory]: async () => {
          const policy = await readRenewalStockProtectionOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        payment_method_expiry_warning_days: async () => {
          const policy = await readPaymentMethodExpiryWarningDaysOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        "payments.declineNoticeTiming": async () => {
          const policy = await readPaymentDeclineNoticeTimingOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        promotion_claim_hold_hours: async () => {
          const policy = await readPromotionClaimHoldHoursOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        subscription_edit_quote_ttl_minutes: async () => {
          const policy = await readSubscriptionEditQuoteTtlMinutesOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        "subscriptions.retrySchedule": async () => {
          const policy = await readSubscriptionRetryScheduleOverride(db);
          return policy ? { present: true, value: { ...policy, backoffHours: [...policy.backoffHours] }, revision: policy.revision } : { present: false };
        },
        subscription_minimum_base_units: async () => {
          const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key = 'subscription_minimum_base_units'");
          if (!rows.length) return { present: false };
          const raw = rows[0].value_text;
          const value = Number(raw);
          if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(value) || value > 2147483647) {
            throw new Error("subscription_reprice_minimum_base_units_unavailable");
          }
          return { present: true, value, revision: null };
        },
        subscription_sized_intro_phase: async () => {
          const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key = 'subscription_sized_intro_phase'");
          if (!rows.length) return { present: false };
          const raw = rows[0].value_text;
          if (typeof raw !== "string") throw new Error("subscription_edit_invalid_sized_configuration");
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
            || Object.keys(parsed).length !== 2
            || !Object.hasOwn(parsed, "fixedThroughCycle") || !Object.hasOwn(parsed, "graduationCycle")
            || !Number.isSafeInteger(parsed.fixedThroughCycle) || parsed.fixedThroughCycle < 1 || parsed.fixedThroughCycle > 2147483647
            || !Number.isSafeInteger(parsed.graduationCycle) || parsed.graduationCycle < 1 || parsed.graduationCycle > 2147483647
            || parsed.graduationCycle <= parsed.fixedThroughCycle) {
            throw new Error("subscription_edit_invalid_sized_configuration");
          }
          return {
            present: true,
            value: { fixedThroughCycle: parsed.fixedThroughCycle, graduationCycle: parsed.graduationCycle },
            revision: null,
          };
        },
        shipping_flat_minor: async () => {
          const { rows } = await db.query("SELECT value_minor FROM public.commerce_settings WHERE key = 'shipping_flat_minor'");
          if (!rows.length) return { present: false };
          const raw = rows[0].value_minor;
          if (raw === null || raw === undefined) throw new Error("shipping_flat_minor_invalid");
          const value = Number(raw);
          if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
            throw new Error("shipping_flat_minor_invalid");
          }
          return { present: true, value, revision: null };
        },
        "pricing.subscriptionPricePolicy": async () => {
          const { rows } = await db.query(
            "SELECT id, price_list_id, region_code, currency, channel, revision_no, discount_bps, rounding_quantum_minor, rounding_rule, effective_from, effective_to FROM public.subscription_price_policy_revisions ORDER BY price_list_id, region_code, currency, channel, revision_no",
          );
          if (!rows.length) return { present: false };
          const code = "subscription_price_policy_invalid";
          return {
            present: true,
            value: rows.map(row => ({
              id: readSettingText(row.id, code),
              price_list_id: readSettingText(row.price_list_id, code),
              region_code: readSettingText(row.region_code, code),
              currency: readSettingText(row.currency, code),
              channel: readSettingText(row.channel, code),
              revision_no: readSettingInt(row.revision_no, 1, 2147483647, code),
              discount_bps: readSettingInt(row.discount_bps, 0, 10000, code),
              rounding_quantum_minor: readSettingInt(row.rounding_quantum_minor, 1, 2147483647, code),
              rounding_rule: readSettingText(row.rounding_rule, code),
              effective_from: readSettingTimestamp(row.effective_from, code),
              effective_to: readSettingTimestamp(row.effective_to, code, true),
            })),
            revision: null,
          };
        },
        "communications.nativeDeliveryControls": async () => {
          const { rows } = await db.query(
            "SELECT control_key, enabled, revision FROM public.communication_delivery_controls ORDER BY control_key",
          );
          if (!rows.length) return { present: false };
          const code = "communications_delivery_controls_invalid";
          return {
            present: true,
            value: rows.map(row => {
              if (typeof row.enabled !== "boolean") throw new Error(code);
              return {
                control_key: readSettingText(row.control_key, code),
                enabled: row.enabled,
                revision: readSettingInt(row.revision, 1, 2147483647, code),
              };
            }),
            revision: null,
          };
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

const maxToolStdoutBytes = 16 * 1024 * 1024;
function runSettingsToolProcess(argv, stdin) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "settings-mcp-tool", ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxToolStdoutBytes) {
        child.kill();
        finish({ exit: 74, stdout: "" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { process.stderr.write(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", () => { finish({ exit: 74, stdout: "" }); });
    child.on("close", code => {
      finish({ exit: code ?? 74, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const cliOptions = {
  json: { type: "boolean" }, help: { type: "boolean" },
  root: { type: "string" }, from: { type: "string" }, to: { type: "string" },
  "schema-version": { type: "string" }, app: { type: "string" }, packs: { type: "string" }, "trusted-packs": { type: "string" },
};

async function main(args) {
  // Identify schema before strict parsing can refuse a misplaced or malformed option.
  const { positionals: [group, command] } = parseArgs({ args, options: cliOptions, strict: false, allowPositionals: true });
  if (group === "catalogue" && command === "schema") {
    const expected = ["catalogue", "schema", "--json"];
    const rejected = args.find((arg, index) => arg !== expected[index]);
    if (rejected !== undefined) {
      const flag = rejected.split("=", 1)[0];
      const syntax = ["--packs", "--trusted-packs", "--app", "--json"].includes(flag) ? `${flag} syntax`
        : rejected.startsWith("-") ? "an unsupported option" : "an extra positional argument";
      emitRefusal(64, cliFinding("OPENLUP_E_CLI_INPUT", `Rejected ${syntax} in the catalogue schema invocation.`,
        "catalogue schema takes only --json.", "Run the command without other flags or arguments.", "openlup catalogue schema --json"),
      { command: "catalogue schema" });
      return;
    }
    validatingInput = false;
    const { runCatalogueSchema } = await import("./catalogueSchema.mjs");
    await runCatalogueSchema(emit);
    return;
  }
  if (args[0] === "recipe") {
    validatingInput = false;
    const { runRecipeCommand } = await import("./recipeCli.mjs");
    await runRecipeCommand(args.slice(1), {
      emit,
      refuse,
      renderFinding,
      setJson: value => { json = value; },
    });
    return;
  }
  if (args[0] === "settings" || args[0] === "settings-mcp-tool") {
    const isolateStdout = args[0] === "settings-mcp-tool";
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
        { ...host, previewResultSchema: renewalStockProtectionPreviewResult, runTool: runSettingsToolProcess });
    } else {
      let toolIo = io;
      if (isolateStdout) {
        const write = process.stdout.write.bind(process.stdout);
        process.stdout.write = process.stderr.write.bind(process.stderr);
        globalThis.console = new Console(process.stderr);
        toolIo = { ...io, write };
      }
      process.exitCode = await runSettingsCommand(settingsArgs, toolIo, host);
    }
    return;
  }
  const { values, positionals } = parseArgs({ args, options: cliOptions, strict: true, allowPositionals: true });
  json = values.json === true;
  const isUpgrade = positionals.length === 2 && positionals[0] === "upgrade" && ["plan", "apply"].includes(positionals[1]);
  if (values["trusted-packs"] !== undefined && (positionals[0] !== "catalogue" || positionals[1] !== "project" || values.packs !== undefined || values.app !== undefined)) {
    const observed = "Trusted pack paths are exclusive to catalogue project.";
    if (isUpgrade) refuseUpgradeInput(observed, "Remove --trusted-packs, which applies only to catalogue commands, and rerun the same upgrade command.");
    else refuse(64, "OPENLUP_E_CLI_INPUT", observed, "Use one documented catalogue input flag.");
  } else if (values.help) {
    emit({ command: "help", state: "complete", exitCode: 0, help }, help.trimEnd());
  } else if (isUpgrade) {
    await upgrade(positionals[1], values);
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
    const diagnostic = assemblyDiagnostic(error);
    const observed = "createVerificationInput() failed while assembling observations";
    const cause = "Executing createVerificationInput() in the trusted --app module failed before readiness evaluation.";
    refuse(74, "OPENLUP_E_CLI_FAILURE", diagnostic ? observed + "." : observed + "; raw application errors are withheld.",
      "Ensure createVerificationInput() assembles read-only ReadinessInput observations and closes its own resources without throwing.",
      diagnostic ? cause + "\n" + diagnostic : cause);
  } else {
    const invalid = validatingInput && (error instanceof SyntaxError || error instanceof TypeError || (typeof error?.code === "string" && error.code.startsWith("ERR_PARSE_ARGS")));
    refuse(invalid ? 64 : 74, invalid ? "OPENLUP_E_CLI_INPUT" : "OPENLUP_E_CLI_FAILURE", "The operation could not complete; raw input and application errors are withheld.", "Check the command, readable JSON snapshots and schema ordinal, the catalogue JSON, or the trusted --app module and its documented export. After a partial upgrade, rerun the identical snapshots under exclusive access.");
  }
}
