#!/usr/bin/env node
// Tool-only Node entry; importing platform engine entries never starts this CLI.
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const help = `openlup upgrade plan|apply --root DIR --from SNAPSHOT.json --to SNAPSHOT.json --schema-version N [--json]
openlup verify [--app ./application-observations.mjs] [--json]

Upgrade snapshots use the existing AppVersionSnapshot contract. All unlisted paths are application-owned; upstream-unchanged files preserve local edits. Apply requires an exclusive maintenance window. Rerun identical inputs to resume. No SQL, package installation or hooks run.
Verify loads no app implicitly. --app explicitly trusts and imports application code exporting createVerificationInput(); that module must only assemble observations and read-only probes, must not write stdout, and must close its own resources before returning/report completion. The CLI does not sandbox that module. Only the supplied schema observer is invoked by diagnosis; routes and jobs never run.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 2 unknown, 64 invalid invocation/JSON, 74 operation or application loading failure. JSON uses formatVersion=1, one object on stdout.
`;
let json = process.argv.slice(2).includes("--json");

function emit(value, text) {
  process.stdout.write(json ? `${JSON.stringify({ formatVersion: 1, ...value })}\n` : `${text}\n`);
  process.exitCode = value.exitCode;
}

function renderFinding(finding) {
  return `${finding.code}${finding.package ? ` ${finding.package}${finding.module ? `/${finding.module}` : ""} ${finding.subject}` : ""}\nObserved: ${finding.observed}\nCause: ${finding.cause}\nFix: ${finding.fix}\nRecheck: ${finding.recheck}\nDeclared: ${finding.evidence.declared}\nBound: ${finding.evidence.bound}\nChecked: ${finding.evidence.checked}\nUnknown: ${finding.evidence.unknown.join(" ")}`;
}

function refuse(exitCode, code, observed, fix) {
  const finding = { code, observed, cause: exitCode === 64 ? "Invalid command or input syntax." : "Snapshot admission, a filesystem operation or trusted application loading failed.", fix, recheck: "Rerun the same command after repair.", evidence: { declared: "Not established", bound: "Not established", checked: "The command could not complete", unknown: ["Remaining application and filesystem state"] } };
  emit({ command: "openlup", state: exitCode === 64 ? "refused" : "failed", exitCode, findings: [finding] }, `${renderFinding(finding)}\n${help}`);
}

try {
  const { values, positionals } = parseArgs({
    options: {
      json: { type: "boolean" }, help: { type: "boolean" },
      root: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      "schema-version": { type: "string" }, app: { type: "string" },
    }, strict: true, allowPositionals: true,
  });
  json = values.json === true;
  if (values.help) {
    emit({ command: "help", state: "complete", exitCode: 0, help }, help.trimEnd());
  } else if (positionals[0] === "upgrade" && ["plan", "apply"].includes(positionals[1]) && positionals.length === 2 && values.app === undefined && values.root && values.from && values.to && /^(0|[1-9][0-9]*)$/u.test(values["schema-version"] ?? "") && Number.isSafeInteger(Number(values["schema-version"]))) {
    const { planAppUpgrade, applyAppUpgrade, AppUpgradeConflictError } = await import("@openlup/platform/lifecycle");
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
  } else if (positionals.length === 1 && positionals[0] === "verify" && ![values.root, values.from, values.to, values["schema-version"]].some(value => value !== undefined)) {
    const { verifyApp, APP_VERIFICATION_BOUNDARY } = await import("@openlup/platform/lifecycle");
    const boundary = `${APP_VERIFICATION_BOUNDARY} Explicit --app imports trusted application code, which must not boot a host or execute effects; this is not a sandbox.`;
    if (values.app === "") throw new TypeError("empty_app_path");
    if (values.app === undefined) {
      const finding = { code: "OPENLUP_E_APP_UNKNOWN", observed: "No application observations were loaded.", cause: "The CLI does not discover or start application code implicitly.", fix: "Create an application-owned module exporting createVerificationInput(), returning your existing ReadinessInput (actual selected contributions, binding identities and read-only schema observer); pass its path with --app.", recheck: "openlup verify --app ./application-observations.mjs", evidence: { declared: "Unknown", bound: "Unknown", checked: "Nothing loaded", unknown: ["Application composition and schema"] } };
      emit({ command: "verify", state: "unknown", exitCode: 2, boundary, findings: [finding] }, `verify: unknown\n${boundary}\n${renderFinding(finding)}`);
    } else {
      const application = await import(pathToFileURL(resolve(values.app)).href);
      if (typeof application.createVerificationInput !== "function") throw new TypeError("missing_createVerificationInput");
      const input = await application.createVerificationInput();
      const report = await verifyApp(input);
      const appArgument = "'" + values.app.replaceAll("'", "'\"'\"'") + "'";
      const findings = report.findings.map(finding => ({ ...finding, recheck: `openlup verify --app ${appArgument}${json ? " --json" : ""}` }));
      const exitCode = report.state === "ready" ? 0 : report.state === "unknown" ? 2 : 1;
      emit({ command: "verify", exitCode, ...report, findings, boundary }, `verify: ${report.state}\n${boundary}\n${findings.map(renderFinding).join("\n")}`.trimEnd());
    }
  } else {
    refuse(64, "OPENLUP_E_CLI_INPUT", "Command or required options do not match the public syntax.", "Use openlup --help and explicit input paths.");
  }
} catch (error) {
  // Never print raw application errors, configured values, connection strings or file contents.
  const invalid = error instanceof SyntaxError || error instanceof TypeError || (typeof error?.code === "string" && error.code.startsWith("ERR_PARSE_ARGS"));
  refuse(invalid ? 64 : 74, invalid ? "OPENLUP_E_CLI_INPUT" : "OPENLUP_E_CLI_FAILURE", "The operation could not complete; raw input and application errors are withheld.", "Check the command, readable JSON snapshots and schema ordinal, or the trusted --app module and its read-only probe. After a partial upgrade, rerun the identical snapshots under exclusive access.");
}
