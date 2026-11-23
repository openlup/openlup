import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "node:process";
import { proveInstalledCareUpgrade, qualificationReceipt, qualifyReleasedSet } from "./exact-set-qualification.mjs";
import { assertCompleteStarter, assertUpgradeConflict, previousPublishedSet, migrateStarterOwned,
  includeSettingsHost, starterSettingsHost, reconcileLifecycleCustomization, reconcileReminderInstallationTest, proveStarterCatalogueWrappers, retiresStarterCatalogue,
  reminderInstallationTest, starterLifecycle, starterOptionalOwnedFiles, starterUpgradeSnapshot,
  starterDisplayFiles, reconcileDisplayCustomization, reconcileStarterAgentGuide,
  starterSubscriptionOffer, reconcileSubscriptionOfferCustomization, starterEditorPorts, starterDocumentFiles,
  reconcileDocumentCustomization, proveDistributionCliConsumer, starterCheckoutFiles, mergeStarterCareFile, needsStarterCareUpgrade } from "./distribution-cli-proof.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-pair-unit-"))); directories.push(directory);
  const write = (path: string, content: unknown) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), typeof content === "string" ? content : JSON.stringify(content)); };
  write("ownership.json", { managed: ["z.ts", "generated.json", "package.json"], owned: ["owned.ts"], generated: ["generated.json"] });
  write("z.ts", "previous bytes"); write("owned.ts", "local bytes");
  write("package.json", { dependencies: { "@openlup/core": "0.40.0" } });
  write("node_modules/@openlup/core/package.json", { version: "0.40.0" });
  return { directory, write };
}

it("prints a bounded installation hint after the existing refusal and preserves unhinted stderr bytes", () => {
  const { directory, write } = fixture();
  write("package.json", { type: "module" });
  write(starterLifecycle, readFileSync(resolve("examples/neutral-store", starterLifecycle), "utf8"));
  write("browser-groups.mjs", "export const browserJourneyGroups = [];");
  write("host/healthcheck.ts", "export const applicationHealthcheck = () => undefined;");
  write("owned/store.config.ts", "export const selectConfiguration = () => ({});");
  const message = "checkout_recovery_schedule_change_blocked_open_episodes (2 blocking orders)";
  for (const [fields, expected] of [
    [{ hint: "  Retry after\n those orders\tclose.  " }, "Retry after those orders close.\n"],
    [{ hint: " ", cause: { hint: "Use the owner role." } }, "Use the owner role.\n"],
    [{ hint: "a".repeat(260) }, "a".repeat(240) + "\n"],
    [{}, ""],
  ] as const) {
    write("installation/install.ts", `export const bootstrapDemonstration = () => undefined;
      export async function installDemonstration() {
        throw Object.assign(new Error(${JSON.stringify(message)}), ${JSON.stringify(fields)});
      }`);
    const result = spawnSync(process.execPath, [starterLifecycle, "install"], { cwd: directory, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(message + "\n" + expected);
  }
});

it("selects the greatest numeric stable tagged release visible in the complete npm set", () => {
  const tags = ["0.9.0", "0.10.0", "0.40.1", "0.41.0", "0.41.1-rc.1", "0.42.0"].reverse().map(version => `a refs/tags/openlup-core-v${version}`).join("\n");
  const visible = ["0.9.0", "0.10.0", "0.40.1", "0.41.0", "0.41.1-rc.1", "0.42.0"];
  expect(previousPublishedSet("0.42.0", tags, [visible, visible])).toBe("0.41.0");
  expect(previousPublishedSet("0.42.0", tags, [visible, ["0.9.0", "0.10.0", "0.40.1"]])).toBe("0.40.1");
  expect(previousPublishedSet("0.40.0", tags, [visible])).toBe("0.10.0");
  expect(() => previousPublishedSet("0.42.0", tags, [[]])).toThrow("upgrade_pair_previous_unavailable");
  expect(() => previousPublishedSet("latest", tags, [visible])).toThrow("upgrade_pair_invalid");
});

it("derives snapshots from ownership, excludes generated and owned bytes, and admits newly managed paths", () => {
  const { directory, write } = fixture();
  expect(Object.keys(starterUpgradeSnapshot(directory, "0.40.0").files)).toEqual(["package.json", "z.ts"]);
  const ownership = JSON.parse(readFileSync(join(directory, "ownership.json"), "utf8"));
  ownership.managed.push("nested/new.ts"); write("nested/new.ts", "new bytes"); write("ownership.json", ownership);
  expect(starterUpgradeSnapshot(directory, "0.40.0").files["nested/new.ts"]).toBe("new bytes");
  ownership.managed.push("owned.ts"); write("ownership.json", ownership);
  expect(() => starterUpgradeSnapshot(directory, "0.40.0")).toThrow("upgrade_snapshot_ownership_overlap");
});

it("reuses the mounted CX-1R journey for first-cut upgrades and merges adopter copy against both snapshots", () => {
  const { directory, write } = fixture();
  const witness = "ask_first_offer_only_after_yes";
  const previous = join(directory, "previous"), target = join(directory, "target");
  write("target/browser/acquisition.spec.ts", witness);
  expect(needsStarterCareUpgrade(previous, target)).toBe(false);
  write("target/owned/copy.ts", "careOfferYes");
  expect(needsStarterCareUpgrade(previous, target)).toBe(true);
  write("previous/browser/acquisition.spec.ts", witness);
  expect(needsStarterCareUpgrade(previous, target)).toBe(false);
  const calls: unknown[] = [];
  const fixturePath = join(directory, ".context/care-browser/upgrade.json");
  proveInstalledCareUpgrade((...args: unknown[]) => {
    calls.push(args);
    if (args[0] === process.execPath) expect(JSON.parse(readFileSync(fixturePath, "utf8"))).toEqual({ predecessor: "released", customized: true });
  }, directory, "released", true);
  expect(calls.at(-1)).toEqual([process.execPath, ["lifecycle.mjs", "browser", "browser/acquisition.spec.ts", "--grep", witness],
    directory]);
  expect(existsSync(fixturePath)).toBe(false);
  const old = Buffer.from("Cart\n\nTitle\n\nconfirmCancel\n"), local = Buffer.from("Basket\n\nTitle\n\nconfirmCancel\n");
  expect(mergeStarterCareFile(directory, old, local, Buffer.from("Cart\n\nTitle\n\ncareOfferYes\n")).toString())
    .toBe("Basket\n\nTitle\n\ncareOfferYes\n");
  expect(() => mergeStarterCareFile(directory, old, local, Buffer.from("Bag\n\nTitle\n\nconfirmCancel\n")))
    .toThrow("starter_care_upgrade_manual_reconciliation_required");
});

it("asserts the real CLI's named conflict before writes and the incomplete file/dependency refusal", () => {
  const { directory, write } = fixture(), from = starterUpgradeSnapshot(directory, "0.40.0");
  const to = { ...from, version: "0.41.0", files: { ...from.files, "z.ts": "candidate bytes" } };
  write("from.json", from); write("to.json", to); write("z.ts", "divergent bytes");
  const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", directory, "--from", join(directory, "from.json"), "--to", join(directory, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
  expect(result.status).toBe(1); assertUpgradeConflict(JSON.parse(result.stdout), "z.ts");
  expect(readFileSync(join(directory, "z.ts"), "utf8")).toBe("divergent bytes");
  expect(() => assertCompleteStarter(directory, from)).toThrow("incomplete_application_upgrade");
  write("z.ts", from.files["z.ts"]); expect(() => assertCompleteStarter(directory, from)).not.toThrow();
  write("node_modules/@openlup/core/package.json", { version: "0.41.0" });
  expect(() => assertCompleteStarter(directory, from)).toThrow("incomplete_application_upgrade");
});

const cli = resolve("packages/platform/src/lifecycle/openlup.mjs");
const starterAssemblyMessage = [
  "OPENLUP_E_STARTER_STORE_CONFIG_REQUIRED",
  "Observed: The third argument is missing a starter StoreConfig.",
  "Cause: Native composition needs the selected configuration for its installed-policy checks.",
  "Fix: Pass the selected StoreConfig as argument three and the optional keyring as argument four.",
  "Recheck: Rerun the same readiness check or startup after correcting the call.",
].join("\n");

function runCli(args: string[], expected: number, preload?: string) {
  const result = spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), cli, ...args], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(expected);
  expect(result.stderr).toBe("");
  return result.stdout;
}

type FindingFacts = { code: string; observed: string; cause: string; fix: string; recheck: string };
const recheckUpgrade = "Rerun upgrade plan after repair. Apply only after a clear plan.";
const snapshot = (version: string, min: number, max: number, files: Record<string, string>) => ({ version, schema: { min, max }, files });
const byteConflict = "current bytes match neither predecessor nor candidate";
const structuralFix = "Preserve local data and move the obstruction without following it. Restore the exact predecessor or candidate state with ordinary components and the expected spelling, including absence where required.";
const fileFacts = (path: string, reason: string): FindingFacts => ({
  code: "OPENLUP_E_UPGRADE_FILE_CONFLICT", observed: path + ": " + reason,
  cause: reason === byteConflict ? "A changed managed file diverged from both snapshots." : "A managed path has a spelling, symlink or file type obstruction.",
  fix: reason === byteConflict ? "Save local changes and reconcile to exact predecessor or candidate bytes, including expected absence." : structuralFix,
  recheck: recheckUpgrade,
});
const schemaFacts = (observed: string): FindingFacts => ({
  code: "OPENLUP_E_UPGRADE_SCHEMA_RANGE", observed,
  cause: "The supplied ordinal falls outside a snapshot's declared compatibility range.",
  fix: "Read the verified applied migration count from the same database and installation profile. If status refuses, resolve catalogue or ledger admission there before using a count. Use the observed count and a compatible released snapshot pair. If the ranges do not overlap, stop this hop and use a documented intermediate hop only if one exists. If the database needs a forward migration, follow the application migration chain and observe again. Keep the original pair after apply has written files.",
  recheck: recheckUpgrade,
});
const findingText = ({ code, observed, cause, fix, recheck }: FindingFacts) =>
  `${code}\nObserved: ${observed}\nCause: ${cause}\nFix: ${fix}\nRecheck: ${recheck}\n`;

function expectFindings(findings: FindingFacts[], facts: FindingFacts[], text: string) {
  expect(findings.map(({ code, observed, cause, fix, recheck }) => ({ code, observed, cause, fix, recheck }))).toEqual(facts);
  for (const finding of facts) expect(text).toContain(findingText(finding));
}

function upgradeFixture() {
  const { directory, write } = fixture();
  const app = join(directory, "app");
  mkdirSync(app);
  const args = (verb: "plan" | "apply", ordinal: string | number) =>
    ["upgrade", verb, "--root", app, "--from", join(directory, "from.json"), "--to", join(directory, "to.json"), "--schema-version=" + ordinal];
  const report = (options: string[], status = 0, preload?: string) => {
    const value = JSON.parse(runCli([...options, "--json"], status, preload));
    expect(value).toMatchObject({ formatVersion: 1, exitCode: status,
      state: status === 0 ? "complete" : status === 74 ? "failed" : "refused", conflicts: expect.any(Array) });
    if (value.plan) expect(Object.keys(value.plan).sort()).toEqual(["files", "fromVersion", "schemaVersion", "toVersion"]);
    return value;
  };
  return { directory, write, app, args, report };
}

it.each(["plan", "apply"] as const)("reports distinct and mixed conflicts for %s in both forms without writing", verb => {
  const { write, app, args, report } = upgradeFixture();
  const previous = { "a.txt": "a-old", "z.txt": "z-old" };
  write("from.json", snapshot("before", 1, 2, previous));
  write("to.json", snapshot("after", 2, 3, { "a.txt": "a-new", "z.txt": "z-new" }));
  write("app/a.txt", previous["a.txt"]); write("app/z.txt", previous["z.txt"]);
  const cases = [
    { ordinal: 1, conflict: false, range: "schema 1 is outside after range 2..3" },
    { ordinal: 3, conflict: false, range: "schema 3 is outside before range 1..2" },
    { ordinal: 2, conflict: true, range: "" },
    { ordinal: 0, conflict: true, range: "schema 0 is outside before range 1..2", second: "schema 0 is outside after range 2..3" },
  ];
  for (const { ordinal, conflict, range, second } of cases) {
    const observed = conflict ? "local" : previous["z.txt"];
    write("app/z.txt", observed);
    const ranges = [range, second].filter((entry): entry is string => Boolean(entry));
    const conflicts = ranges.map(reason => ({ path: "", reason }));
    if (conflict) conflicts.push({ path: "z.txt", reason: byteConflict });
    const output = report(args(verb, ordinal), 1);
    expect(output.conflicts).toEqual(conflicts);
    expect(output.applied).toEqual([]);
    if (verb === "apply") expect(output).not.toHaveProperty("plan");
    else expect(output.plan.files).toContainEqual({ path: "a.txt", action: "replace" });
    expectFindings(output.findings, [...ranges.map(schemaFacts), ...(conflict ? [fileFacts("z.txt", byteConflict)] : [])], runCli(args(verb, ordinal), 1));
    expect(readdirSync(app).sort()).toEqual(["a.txt", "z.txt"]);
    expect(readFileSync(join(app, "a.txt"), "utf8")).toBe(previous["a.txt"]);
    expect(readFileSync(join(app, "z.txt"), "utf8")).toBe(observed);
  }
  write("app/z.txt", previous["z.txt"]);
  write("to.json", snapshot("after", 3, 4, previous));
  const reason = "schema 2 is outside after range 3..4";
  const output = report(args(verb, 2), 1);
  expect(output.conflicts).toEqual([{ path: "", reason }]);
  expectFindings(output.findings, [schemaFacts(reason)], runCli(args(verb, 2), 1));
});

it("admits inclusive bounds and gives equal actions, writes and no-op replays at different ordinals", () => {
  const { write, app, args, report } = upgradeFixture();
  const max = Number.MAX_SAFE_INTEGER;
  write("from.json", snapshot("before", 0, max, { "a.txt": "old", "remove.txt": "remove" }));
  write("to.json", snapshot("after", 0, max, { "a.txt": "new", "create.txt": "created" }));
  const prepare = () => {
    rmSync(app, { recursive: true, force: true });
    write("app/a.txt", "old"); write("app/remove.txt", "remove");
  };
  let admitted: unknown;
  for (const ordinal of [0, max]) {
    prepare();
    const plan = report(args("plan", ordinal));
    expect(plan.conflicts).toEqual([]);
    expect(plan.plan.schemaVersion).toBe(ordinal);
    expect(plan.plan.files).toEqual([
      { path: "a.txt", action: "replace" }, { path: "create.txt", action: "create" }, { path: "remove.txt", action: "remove" },
    ]);
    expect(runCli(args("plan", ordinal), 0)).toContain("a.txt: replace (upgrade-managed)\n");
    expect(readFileSync(join(app, "a.txt"), "utf8")).toBe("old");
    const completed = report(args("apply", ordinal));
    expect(completed.conflicts).toEqual([]);
    expect(completed.plan).toEqual(plan.plan);
    expect(completed.applied).toEqual(["a.txt", "create.txt", "remove.txt"]);
    const names = readdirSync(app).sort();
    expect(names).toEqual(["a.txt", "create.txt"]);
    const writes = names.map(path => readFileSync(join(app, path), "utf8"));
    expect(writes).toEqual(["new", "created"]);
    const transition = { actions: plan.files, applied: completed.applied, writes };
    if (admitted) expect(transition).toEqual(admitted);
    admitted = transition;
    const replay = report(args("apply", ordinal));
    expect(replay.conflicts).toEqual([]);
    expect(replay.applied).toEqual([]);
    expect(replay.files.every((file: { action: string }) => file.action === "already-applied")).toBe(true);
    expect(runCli(args("apply", ordinal), 0)).toContain("a.txt: already-applied (upgrade-managed)\n");
    expect(names.map(path => readFileSync(join(app, path), "utf8"))).toEqual(writes);
  }
  write("from.json", '{"version":"before","schema":{"min":1e0,"max":1.0},"files":{}}');
  expect(report(args("plan", 1)).conflicts).toEqual([]);
});

it("names structural conflicts and repairs an obstructed target-only creation by preserving and moving the entry", () => {
  const { directory, write, app, args, report } = upgradeFixture();
  write("outside.txt", "preserved local data");
  write("app/block", "parent bytes"); write("app/alias.txt", "alias bytes"); write("app/folder/child", "child bytes");
  symlinkSync("../outside.txt", join(app, "link.txt"));
  write("from.json", snapshot("before", 0, 0, {}));
  write("to.json", snapshot("after", 0, 0, { "Alias.txt": "create", "block/item": "create", folder: "replace", "link.txt": "create" }));
  // Reproduce the filesystem observation on case-sensitive runners too.
  write("alias.mjs", `import { promises as fs } from "node:fs";
    const lstat = fs.lstat.bind(fs);
    fs.lstat = (path, ...args) => lstat(path.endsWith("/Alias.txt") ? path.replace(/Alias.txt$/, "alias.txt") : path, ...args);`);
  const preload = join(directory, "alias.mjs");
  const conflicts = [
    { path: "Alias.txt", reason: "managed path spelling differs from directory entry" },
    { path: "block/item", reason: "managed parent is not a directory" },
    { path: "folder", reason: "managed path is not a regular file" },
    { path: "link.txt", reason: "symlink in managed path" },
  ];
  for (const verb of ["plan", "apply"] as const) {
    const output = report(args(verb, 0), 1, preload);
    expect(output.conflicts).toEqual(conflicts);
    expectFindings(output.findings, conflicts.map(({ path, reason }) => fileFacts(path, reason)), runCli(args(verb, 0), 1, preload));
  }
  write("to.json", snapshot("after", 0, 0, { "link.txt": "candidate bytes" }));
  expect(report(args("apply", 0), 1).conflicts).toEqual([conflicts.at(-1)]);
  renameSync(join(app, "link.txt"), join(app, "saved-link"));
  expect(report(args("plan", 0)).conflicts).toEqual([]);
  expect(report(args("apply", 0)).applied).toEqual(["link.txt"]);
  expect(readFileSync(join(app, "link.txt"), "utf8")).toBe("candidate bytes");
  expect(readlinkSync(join(app, "saved-link"))).toBe("../outside.txt");
  expect(readFileSync(join(directory, "outside.txt"), "utf8")).toBe("preserved local data");
  expect(report(args("apply", 0)).applied).toEqual([]);
});

const legacyEvidence = { declared: "Not established", bound: "Not established", checked: "The command could not complete",
  unknown: ["Remaining application and filesystem state"] };
const legacyRecheck = "Rerun the same command after repair.";

function expectExactRefusal(options: string[], status: 64 | 74, facts: FindingFacts) {
  const state = status === 64 ? "refused" : "failed";
  const expected = { formatVersion: 1, command: "openlup", state, exitCode: status, findings: [{ ...facts, evidence: legacyEvidence }] };
  expect(runCli([...options, "--json"], status)).toBe(JSON.stringify(expected) + "\n");
  const docs = readFileSync(resolve("packages/core/docs/guide/reference/cli.md"), "utf8");
  const help = docs.split("<!-- generated:cli:openlup -->\n```text\n")[1]!.split("```")[0]!;
  expect(runCli(options, status)).toBe(findingText(facts)
    + "Declared: Not established\nBound: Not established\nChecked: The command could not complete\nUnknown: Remaining application and filesystem state\n"
    + help + "\n");
}

const inputFacts = (observed: string, fix = "Correct the invocation using an ordinary app directory, readable exact JSON snapshots and the observed schema ordinal."): FindingFacts => ({
  code: "OPENLUP_E_CLI_INPUT", observed, cause: "Invalid command or input syntax.", fix, recheck: recheckUpgrade,
});
const upgradeFailure: FindingFacts = {
  code: "OPENLUP_E_CLI_FAILURE", observed: "The upgrade operation could not complete; raw error details are withheld.",
  cause: "Snapshot admission, installed lifecycle loading or a filesystem operation failed.",
  fix: "Check the original snapshots' validity and identity, the app root and filesystem access, and availability of the installed target CLI. If apply failed after writes, restore access and resume with the identical snapshots under exclusive access.",
  recheck: recheckUpgrade,
};

it("keeps strict parser errors generic and gives parsed upgrade commands their own trusted-packs fix", () => {
  const generic = {
    ...inputFacts("The operation could not complete; raw input and application errors are withheld.",
      "Check the command, readable JSON snapshots and schema ordinal, the catalogue JSON, or the trusted --app module and its documented export. After a partial upgrade, rerun the identical snapshots under exclusive access."),
    recheck: legacyRecheck,
  };
  for (const options of [["--unexpected", "upgrade", "plan"], ["upgrade", "plan", "--root"]]) {
    expectExactRefusal(options, 64, generic);
  }
  const { report } = upgradeFixture();
  const options = ["upgrade", "plan", "--trusted-packs", "x"];
  const output = report(options, 64);
  expect(output.conflicts).toEqual([]);
  expectFindings(output.findings, [inputFacts("Trusted pack paths are exclusive to catalogue project.",
    "Remove --trusted-packs, which applies only to catalogue commands, and rerun the same upgrade command.")], runCli(options, 64));
});

it.each(["plan", "apply"] as const)("distinguishes %s input gates from rejected snapshot and installed-entry failures", verb => {
  const { directory, write, args, report } = upgradeFixture();
  write("from.json", '{"version":"before","schema":{"min":1e0,"max":1.0},"files":{}}');
  write("to.json", snapshot("after", 1, 1, {}));
  const refusal = (options: string[], status: 64 | 74, facts: FindingFacts, preload?: string) => {
    const output = report(options, status, preload);
    expect(output.conflicts).toEqual([]);
    expect(output).not.toHaveProperty("applied");
    expectFindings(output.findings, [facts], runCli(options, status, preload));
  };
  expect(report(args(verb, 1)).conflicts).toEqual([]);
  for (const ordinal of ["oops", "-1", "1.0", "1e0", "01", "9007199254740992"]) {
    refusal(args(verb, ordinal), 64, inputFacts("Upgrade options do not match the public syntax."));
  }
  const inputError = inputFacts("Upgrade requires an ordinary app directory and valid snapshot JSON.");
  write("bad-root", "regular file");
  refusal(args(verb, 1).map((arg, index) => index === 3 ? join(directory, "bad-root") : arg), 64, inputError);
  write("from.json", "{");
  refusal(args(verb, 1), 64, inputError);
  for (const [min, max] of [[2, 1], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    write("from.json", snapshot("before", min!, max!, {}));
    refusal(args(verb, 1), 74, upgradeFailure);
  }
  rmSync(join(directory, "from.json"));
  refusal(args(verb, 1), 74, upgradeFailure);
  write("from.json", snapshot("before", 1, 1, {}));
  write("unavailable.mjs", `import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "@openlup/platform/lifecycle") throw new Error("synthetic-private-detail");
      return next(specifier, context);
    } });`);
  refusal(args(verb, 1), 74, upgradeFailure, join(directory, "unavailable.mjs"));
});

it("reports an I/O failure after one replacement and resumes with the identical pair", () => {
  const { directory, write, app, args, report } = upgradeFixture();
  write("from.json", snapshot("before", 0, 0, { a: "a-old", b: "b-old" }));
  write("to.json", snapshot("after", 0, 0, { a: "a-new", b: "b-new" }));
  write("fail.mjs", `import { promises as fs } from "node:fs";
    const rename = fs.rename.bind(fs);
    fs.rename = async (source, target) => {
      if (target.endsWith("/b")) throw new Error("synthetic-private-detail");
      await rename(source, target);
    };`);
  const preload = join(directory, "fail.mjs");
  const bytes = () => ["a", "b"].map(path => readFileSync(join(app, path), "utf8"));
  const apply = args("apply", 0);
  for (const json of [true, false]) {
    write("app/a", "a-old"); write("app/b", "b-old");
    if (json) {
      const output = report(apply, 74, preload);
      expect(output.conflicts).toEqual([]);
      expect(output).not.toHaveProperty("applied");
      expect(output.findings).toEqual([{ ...upgradeFailure, evidence: legacyEvidence }]);
    } else expect(runCli(apply, 74, preload)).toContain(findingText(upgradeFailure));
    expect(bytes()).toEqual(["a-new", "b-old"]);
    expect(readdirSync(app).sort()).toEqual(["a", "b"]);
    expect(report(apply).applied).toEqual(["b"]);
    expect(bytes()).toEqual(["a-new", "b-new"]);
    expect(report(apply).applied).toEqual([]);
  }
});

it("keeps legacy verify bytes and discloses only the exact stage-3 native Error message", () => {
  const { directory, write } = fixture();
  const stage3 = {
    code: "OPENLUP_E_CLI_FAILURE",
    observed: "createVerificationInput() failed while assembling observations; raw application errors are withheld.",
    cause: "Executing createVerificationInput() in the trusted --app module failed before readiness evaluation.",
    fix: "Ensure createVerificationInput() assembles read-only ReadinessInput observations and closes its own resources without throwing.",
    recheck: legacyRecheck,
  };
  const stage1 = {
    ...stage3, observed: "The --app module could not be loaded; raw application errors are withheld.",
    cause: "Importing the trusted --app module failed before createVerificationInput() could be checked.",
    fix: "Check that the --app path exists, resolves its imports and evaluates without top-level errors.",
  };
  const stage2 = {
    ...stage3, observed: "The loaded --app module does not export a createVerificationInput() function.",
    cause: "The trusted --app module loaded, but createVerificationInput was absent or not a function.",
    fix: "Export a createVerificationInput() function returning ReadinessInput from the --app module.",
  };
  const allowed = {
    ...stage3, observed: "createVerificationInput() failed while assembling observations.",
    cause: stage3.cause + "\n" + starterAssemblyMessage,
  };
  const message = JSON.stringify(starterAssemblyMessage);
  const factory = (body: string, async = "") => `export ${async} function createVerificationInput() { ${body} }`;
  expect(JSON.parse(runCli(["verify", "--json"], 2))).toMatchObject({
    formatVersion: 1, command: "verify", state: "unknown", exitCode: 2, findings: [{ code: "OPENLUP_E_APP_UNKNOWN" }],
  });
  expect(JSON.parse(runCli(["verify", "--app", "", "--json"], 64))).toMatchObject({
    formatVersion: 1, state: "refused", exitCode: 64, findings: [{ code: "OPENLUP_E_CLI_INPUT" }],
  });
  for (const [source, facts] of [
    ["export const = 1;", stage1],
    [`throw new Error(${message});`, stage1],
    ['export const createVerificationInput = "synthetic-private-detail";', stage2],
    [factory('throw new Error("synthetic-private-detail");'), stage3],
    [factory(`throw new Error("synthetic-private-prefix" + ${message});`), stage3],
    [factory(`throw new Error(${message} + "synthetic-private-suffix");`, "async"), stage3],
    [factory(`throw { message: ${message} };`), stage3],
    [factory(`throw Object.create(new Error(${message}));`), stage3],
    [factory(`const error = new Error(); delete error.message; throw error;`), stage3],
    [factory(`const error = new Error(); Object.defineProperty(error, "message", { get() {
      process.stdout.write("accessor invoked"); return ${message};
    } }); throw error;`), stage3],
    [factory(`throw new Proxy(new Error(${message}), { getOwnPropertyDescriptor() { process.stdout.write("proxy trap invoked"); } });`), stage3],
    [factory(`const error = new Error(${message}, { cause: "synthetic-private-cause" }); error.stack = "synthetic-private-stack"; throw error;`), allowed],
    [factory(`throw new Error(${message});`, "async"), allowed],
  ] as const) {
    write("verify.mjs", source);
    expectExactRefusal(["verify", "--app", join(directory, "verify.mjs")], 74, facts);
  }
});

it("retains a failed pair receipt when published visibility refuses before execution", () => {
  const { directory, write } = fixture(), path = join(directory, "receipt.json");
  const tag = "openlup-core-v0.41.0", commit = "a".repeat(40), previous = env.OPENLUP_REGISTRY_READY;
  write("receipt.json", { ...qualificationReceipt(tag, commit), result: "PASS" });
  try {
    env.OPENLUP_REGISTRY_READY = "false";
    expect(() => qualifyReleasedSet(tag, commit, path, true)).toThrow("published set not visible");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    expect(receipt.result).toBe("FAIL"); expect(receipt.upgrade.result).toBe("FAIL");
    expect(receipt.upgrade.endedAt).toBe(receipt.endedAt);
  } finally { if (previous === undefined) delete env.OPENLUP_REGISTRY_READY; else env.OPENLUP_REGISTRY_READY = previous; }
});

it.each(["1.0.0", "1.1.0"])("migrates the 0.43 starter contracts and creates only the documented target-only owned files through the %s CLI", version => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const created = ["owned/quote-shipping.ts", "owned/renewal-policy.ts", "owned/catalogue.json"];
  const replaced = ["owned/store.config.ts", "owned/quote-copy.ts", "owned/subscription-editing.ts", "owned/catalogue.ts"];
  for (const path of [...created, ...replaced]) candidate(path, `candidate ${path}`);
  for (const path of replaced) write(path, `previous ${path}`);
  write("owned/renewal.config.ts", "previous retention"); candidate("owned/renewal.config.ts", "candidate retention");
  const from = starterUpgradeSnapshot(app, "0.43.0"), to = starterUpgradeSnapshot(target, version);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, "owned/renewal.config.ts"), "utf8")).toBe(version === "1.1.0" ? "candidate retention" : "previous retention");
  expect(Object.keys(to.files).filter(path => path.startsWith("owned/"))).toEqual(created);
  expect(Object.keys(from.files).some(path => path.startsWith("owned/"))).toBe(false);
  for (const path of replaced) expect(readFileSync(join(app, path), "utf8")).toBe(`candidate ${path}`);
  write("from.json", from); write("to.json", to);
  const run = () => spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app, "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
  write(created[0], "local divergence");
  const refused = run(); expect(refused.status).toBe(1); assertUpgradeConflict(JSON.parse(refused.stdout), created[0]);
  rmSync(join(app, created[0]));
  const result = run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).applied.sort()).toEqual([...created].sort());
  for (const path of created) expect(readFileSync(join(app, path), "utf8")).toBe(`candidate ${path}`);
  expect(JSON.parse(run().stdout).applied).toEqual([]);
  write("owned/quote-copy.ts", "later customization");
  migrateStarterOwned(app, target, { ...from, version: "1.0.0" }, { ...to, version: "1.0.0" });
  expect(readFileSync(join(app, "owned/quote-copy.ts"), "utf8")).toBe("later customization");
});

it("migrates only the pristine retention contract from 1.0.0 to 1.1.0", () => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  write("owned/renewal.config.ts", "previous retention"); candidate("owned/renewal.config.ts", "candidate retention");
  const from = starterUpgradeSnapshot(app, "1.0.0"), to = starterUpgradeSnapshot(target, "1.1.0");
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, "owned/renewal.config.ts"), "utf8")).toBe("candidate retention");
  expect(readFileSync(join(app, "owned.ts"), "utf8")).toBe("local bytes");
  expect(to.files).toEqual(from.files);
});

it("migrates the pristine catalogue after the 1.2.0 starter release", () => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const path = "owned/catalogue.ts", pack = "owned/catalogue.json";
  const released = (file: string) => execFileSync("git", ["show", `openlup-core-v1.2.0:examples/neutral-store/${file}`], { encoding: "utf8" });
  const previous = released(path), packBytes = released(pack);
  const next = readFileSync(resolve("examples/neutral-store", path), "utf8");
  write(path, previous); write(pack, packBytes); candidate(path, next);
  const historicalManifest = released("package.json");
  write("package.json", historicalManifest);
  candidate("package.json", readFileSync(resolve("examples/neutral-store/package.json"), "utf8"));
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "999999.0.0");
  migrateStarterOwned(app, target, from, { ...to, version: "1.2.0" });
  expect(readFileSync(join(app, path), "utf8")).toBe(previous);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, path), "utf8")).toBe(next);
  expect(readFileSync(join(app, pack), "utf8")).toBe(packBytes);
  expect(next).toContain("export const catalogueConformance");
  expect(next).toContain("get resolve()");

  const bin = resolve("packages/platform/src/lifecycle/openlup.mjs");
  mkdirSync(join(app, "node_modules/.bin"), { recursive: true });
  symlinkSync(bin, join(app, "node_modules/.bin/openlup"));
  symlinkSync(resolve("packages/platform"), join(app, "node_modules/@openlup/platform"));
  const customizedPack = packBytes + "\n";
  write(pack, customizedPack);
  write("from.json", from);
  write("to.json", to);
  const upgraded = spawnSync(process.execPath, [bin, "upgrade", "apply", "--root", app, "--from", join(app, "from.json"),
    "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { cwd: app, encoding: "utf8" });
  expect(upgraded.status, upgraded.stdout).toBe(0);
  const verifyWrappers = () => proveStarterCatalogueWrappers(app, target, to.files["package.json"]);
  expect(retiresStarterCatalogue(from.files["package.json"], to.files["package.json"])).toBe(true);
  const dual = JSON.parse(historicalManifest);
  dual.scripts["catalogue:check:source"] = JSON.parse(to.files["package.json"]).scripts["catalogue:check:source"];
  const fromDual = { ...from, files: { ...from.files, "package.json": JSON.stringify(dual) } };
  expect(retiresStarterCatalogue(fromDual.files["package.json"], to.files["package.json"])).toBe(true);
  expect(readFileSync(join(app, pack), "utf8")).toBe(customizedPack);
  renameSync(join(app, pack), join(app, "owned/catalogue-archive.json"));
  expect(readFileSync(join(app, "owned/catalogue-archive.json"), "utf8")).toBe(customizedPack);
  expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).scripts).not.toHaveProperty("catalogue:check");
  verifyWrappers();

  write("released-catalogue.ts", previous);
  write(path, previous.replace("title_required", "adopter_title_required"));
  const reconciled = execFileSync("git", ["merge-file", "-p", join(app, path), join(app, "released-catalogue.ts"), join(target, path)], { encoding: "utf8" });
  expect(reconciled).toBe(next.replace("title_required", "adopter_title_required"));
  write(path, reconciled);
  verifyWrappers();
  const installed = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { catalogueConformance, catalogDraftRegistry } = await import(${JSON.stringify(pathToFileURL(join(app, path)).href)});
    const type = { key: "starter:item", version: 1 };
    console.log(JSON.stringify({ effects: catalogDraftRegistry.resolve(type).validateContent({}),
      sameValidator: catalogueConformance.packs[0].pack.types[0].validateContent === catalogDraftRegistry.resolve(type).validateContent }));
  `], { cwd: resolve("examples/neutral-store"), encoding: "utf8" });
  expect(JSON.parse(installed)).toEqual({ effects: [{ code: "adopter_title_required", path: "title" }], sameValidator: true });
});

it.each([false, true])("upgrades the 1.3.0 starter agent guide, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const path = "AGENTS.md";
  const previous = execFileSync("git", ["show", "openlup-core-v1.3.0:examples/neutral-store/AGENTS.template.md"], { encoding: "utf8" });
  const next = readFileSync(resolve("examples/neutral-store/AGENTS.template.md"), "utf8");
  const ownership = { managed: ["z.ts"], owned: [path, starterSettingsHost], generated: [] };
  write("ownership.json", ownership); candidate("ownership.json", ownership);
  write(path, previous); candidate(path, next);
  write(starterSettingsHost, ""); candidate(starterSettingsHost, "");
  candidate("z.ts", "candidate bytes");
  const from = starterUpgradeSnapshot(app, "1.3.0"), to = starterUpgradeSnapshot(target, "999999.0.0");
  migrateStarterOwned(app, target, from, to);
  expect(from.files[path]).toBe(previous);
  expect(to.files[path]).toBe(next);
  const apply = (status: number) => {
    candidate("from.json", from); candidate("to.json", to);
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply",
      "--root", app, "--from", join(target, "from.json"), "--to", join(target, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };
  const local = customized ? reconcileStarterAgentGuide(app, from, to, () => {
    const report = apply(1);
    expect(readFileSync(join(app, "z.ts"), "utf8")).toBe("previous bytes");
    return report;
  }) : undefined;
  expect(apply(0).applied).toEqual(customized ? ["z.ts"] : [path, "z.ts"]);
  expect(readFileSync(join(app, path))).toEqual(local?.bytes ?? Buffer.from(next));
  if (customized) expect(readFileSync(join(app, path), "utf8")).toContain("Record local acceptance results in the test log.");
  expect(apply(0).applied).toEqual([]);
  const guide = readFileSync(join(app, path), "utf8");
  const map = guide.split("<!-- END:openlup-agent-rules -->")[1]?.split("## Catalogue tasks\n")[1] ?? "";
  expect(map).toContain("| Add a product type with a content rule |");
  expect(map).toContain("| Publish a saved catalogue draft (prepare, approve, publish, recover a lost response, read back) |");
  const correction = "When changing lists, set `expected.entryId` and `expected.unitPriceMinor` from the SKU's current one-time base price on the destination list, using `null` for both when there is no current entry, and resolve any pending base price there before publishing.";
  expect(map.split("\n").find(line => line.startsWith("| Correct a refused price-list input |"))).toContain(correction);
  const installed = readFileSync(resolve("packages/core/docs/guide/how-to/build/customize-the-starter.md"), "utf8");
  const refusal = installed.split("### Correct a price-list refusal\n")[1]?.split("\n## ")[0];
  expect(refusal?.replace(/\s+/g, " ")).toContain(correction);
});

it.each([false, true])("replaces the managed subscription offer and preserves reconciled edits, customized=%s", customized => {
  const { directory, write } = fixture();
  const app = join(directory, "app");
  const path = starterSubscriptionOffer;
  const previous = execFileSync("git", ["show", `openlup-core-v1.3.0:examples/neutral-store/${path}`], { encoding: "utf8" });
  const target = readFileSync(resolve("examples/neutral-store", path), "utf8");
  expect(target).not.toBe(previous);
  write(`app/${path}`, previous);
  write("app/other.ts", "previous bytes");
  write("from.json", { version: "1.3.0", schema: { min: 0, max: 0 }, files: { [path]: previous, "other.ts": "previous bytes" } });
  write("to.json", { version: "999999.0.0", schema: { min: 0, max: 0 }, files: { [path]: target, "other.ts": "target bytes" } });
  const apply = (status: number) => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply",
      "--root", app, "--from", join(directory, "from.json"), "--to", join(directory, "to.json"), "--schema-version", "0", "--json"],
    { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };
  const local = customized ? reconcileSubscriptionOfferCustomization(app, previous, () => {
    const report = apply(1);
    expect(readFileSync(join(app, "other.ts"), "utf8")).toBe("previous bytes");
    return report;
  }) : undefined;
  expect(apply(0).applied).toEqual(expect.arrayContaining([path, "other.ts"]));
  expect(apply(0).applied).toEqual([]);
  expect(readFileSync(join(app, path), "utf8")).toBe(target);
  if (local) expect(readFileSync(join(app, local.path), "utf8")).toContain("// Adopter offer policy notes.");
});

it("upgrades the starter document readers together and preserves reconciled customizations", () => {
  const { directory: app, write } = fixture();
  const readers = [starterEditorPorts, ...starterDocumentFiles];
  const previous = Object.fromEntries(readers.map(path => [path, execFileSync("git",
    ["show", `openlup-core-v1.3.0:examples/neutral-store/${path}`], { encoding: "utf8" })]));
  const target = Object.fromEntries(readers.map(path => [path, readFileSync(resolve("examples/neutral-store", path), "utf8")]));
  for (const path of readers) write(path, previous[path]);
  const from = { version: "1.3.0", schema: { min: 0, max: 0 }, files: previous };
  const to = { ...from, version: "999999.0.0", files: target };
  write("from.json", from); write("to.json", to);
  const apply = (status: number) => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply",
      "--root", app, "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"],
    { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };
  for (const path of starterDocumentFiles) {
    const local = reconcileDocumentCustomization(app, previous[path]!, () => {
      const report = apply(1);
      for (const sibling of readers.filter(file => file !== path))
        expect(readFileSync(join(app, sibling), "utf8")).toBe(previous[sibling]);
      return report;
    }, path);
    expect(local.bytes.toString()).toContain("Adopter document verification policy");
  }
  expect(() => assertCompleteStarter(app, to)).toThrow("incomplete_application_upgrade");
  expect(apply(0).applied).toEqual([...readers].sort());
  expect(apply(0).applied).toEqual([]);
  expect(() => assertCompleteStarter(app, to)).not.toThrow();
  for (const path of starterDocumentFiles)
    expect(readFileSync(join(app, "owned/upgrade-notes", path.split("/").at(-1)!), "utf8")).toContain("Adopter document verification policy");
});

it.each([true, false])("upgrades checkout with a changed quota descriptor, pristine=%s", pristine => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const released = (path: string) => execFileSync("git",
    ["show", `openlup-core-v1.3.0:examples/neutral-store/${path}`], { encoding: "utf8", timeout: 5_000 });
  const next = (path: string) => readFileSync(resolve("examples/neutral-store", path), "utf8");
  const copyPath = "owned/copy.ts";
  const ownership = { managed: ["package.json", ...starterCheckoutFiles],
    owned: ["AGENTS.md", "owned/store.config.ts", "owned/fragments.ts", starterSettingsHost, copyPath], generated: [] };
  for (const save of [write, candidate]) {
    save("ownership.json", ownership);
    save("AGENTS.md", "# Application\n\n## Change a business setting\n");
    save("owned/store.config.ts", "#3d6657");
    save("owned/fragments.ts", "offer-intro");
  }
  const effect = (source: string) => source.split("'purchase.attemptLimits': {")[1]!.split("\n")
    .find(line => line.trimStart().startsWith("appliesTo:"))!;
  const releasedSettings = released(starterSettingsHost);
  const localSettings = releasedSettings.replace("const config = selectConfiguration(configuration);",
    "const config = selectConfiguration(configuration); // Keep the adopter's configuration binding.");
  expect(localSettings).not.toBe(releasedSettings);
  write(starterSettingsHost, pristine ? releasedSettings : localSettings);
  const targetSettings = next(starterSettingsHost);
  candidate(starterSettingsHost, targetSettings);
  expect(effect(targetSettings)).toContain("PostgreSQL");
  expect(effect(targetSettings)).not.toBe(effect(releasedSettings));

  const releasedCopy = released(copyPath), targetCopy = next(copyPath);
  write(copyPath, releasedCopy);
  candidate(copyPath, targetCopy);

  for (const path of starterCheckoutFiles) {
    const before = released(path), after = next(path);
    expect(after, path).not.toBe(before);
    write(path, before);
    candidate(path, after);
  }
  mkdirSync(join(target, "node_modules/.bin"));
  symlinkSync(resolve("packages/platform/src/lifecycle/openlup.mjs"), join(target, "node_modules/.bin/openlup"));
  const evidence = { phases: [] as { name: string; result: string }[] };
  const finish = proveDistributionCliConsumer(target, { from: app, to: target, fromVersion: "1.3.0", toVersion: "999999.0.0", evidence, pristine });
  expect(typeof finish).toBe("function");
  if (finish) finish();
  if (pristine) {
    expect(evidence).not.toHaveProperty("customizations");
    expect(evidence.phases.map(({ name }) => name)).toEqual([
      "migrate-owned-contracts", "plan", "interrupt-and-refuse", "resume", "replay", "installed-application-and-owned-bytes",
    ]);
    expect(readFileSync(join(app, starterSettingsHost), "utf8")).toBe(releasedSettings);
    expect(readFileSync(join(app, copyPath), "utf8")).toBe(releasedCopy);
    return;
  }
  expect(evidence.phases).toEqual([
    "migrate-owned-contracts", "customize-owned", "plan", "managed-conflict", "checkout-host-reconciliation",
    "interrupt-and-refuse", "resume", "replay", "checkout-attempt-effect-reconciliation", "checkout-attempt-copy-reconciliation",
    "installed-application-and-owned-bytes",
  ].map(name => ({ name, result: "PASS" })));
  expect(readFileSync(join(app, "owned/upgrade-notes/checkout.ts"), "utf8")).toContain("// Adopter checkout policy.");
  expect(readFileSync(join(app, starterSettingsHost), "utf8"))
    .toBe(localSettings.replace(effect(releasedSettings), effect(targetSettings)));
  const candidateEntries = targetCopy.split("\n").filter(line => line.startsWith("    attemptLimitsInterim:"));
  expect(candidateEntries).toHaveLength(2);
  let entry = 0;
  const expectedCopy = releasedCopy.replace('    cart: "Cart",', '    cart: "Your local basket",')
    .split("\n").map(line => line.startsWith("    attemptLimitsInterim:") ? candidateEntries[entry++] : line).join("\n");
  expect(entry).toBe(2);
  expect(readFileSync(join(app, copyPath))).toEqual(Buffer.from(expectedCopy));
  for (const path of starterCheckoutFiles) expect(readFileSync(join(app, path), "utf8"), path).toBe(next(path));
});

it.each([false, true])("upgrades real 1.1.0 owned contracts to the next set, customized=%s", customized => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "starter-next-set-"))); directories.push(directory);
  const source = join(directory, "source"), app = join(directory, "app"), target = join(directory, "target");
  mkdirSync(source);
  const archive = join(directory, "starter.tar");
  execFileSync("git", ["archive", "--output", archive, "openlup-core-v1.1.0", "examples/neutral-store"], { timeout: 5_000 });
  execFileSync("tar", ["-xf", archive, "--strip-components=2", "-C", source], { timeout: 5_000 });
  // Materialize the same owned/managed source mappings as extraction, without
  // registry or provenance claims. Installed-package proof remains a separate gate.
  const materialize = (input: string, output: string) => {
    const ownership = JSON.parse(readFileSync(join(input, "ownership.json"), "utf8")) as {
      owned: string[]; managed: string[]; sourceMappings?: Record<string, string>;
    };
    for (const path of [...ownership.owned, ...ownership.managed]) {
      mkdirSync(dirname(join(output, path)), { recursive: true });
      cpSync(join(input, ownership.sourceMappings?.[path] ?? path), join(output, path));
    }
    return ownership;
  };
  const previousOwnership = materialize(source, app);
  const targetOwnership = materialize(resolve("examples/neutral-store"), target);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: app, stdio: "pipe", timeout: 10_000 });
  const read = (path: string) => readFileSync(join(app, path), "utf8");
  const edit = (path: string, before: string, after: string) => {
    const bytes = read(path); expect(bytes, path).toContain(before);
    writeFileSync(join(app, path), bytes.replaceAll(before, after));
  };
  const customizations = new Map<string, readonly [string, string]>([
    ["AGENTS.md", ["Its fictional data", "Record local acceptance results in the test log. Its fictional data"]],
    ["owned/catalogue.ts", ["title_required", "local_title_required"]],
    ["owned/renewal.config.ts", ["batchLimit: 10", "batchLimit: 8"]],
    ["owned/store.config.ts", ["#3d6657", "#663d57"]],
    ["owned/acquisition-policy.ts", ["Invalid recipient", "Enter a recipient name"]],
    ["owned/copy.ts", ['cart: "Cart"', 'cart: "Your basket"']],
    ["owned/editor-copy.ts", ["Back to account", "Return to your account"]],
    ["owned/quote-copy.ts", ["Brakuje aktualnego cennika.", "Cennik jest chwilowo niedostępny."]],
    ["owned/renewal-copy.ts", ["Order payment confirmed", "We received your payment"]],
    ["owned/demo-seed.ts", ["Fictional application data only.", "Synthetic fixtures for local acceptance tests."]],
    ["owned/fragments.ts", ["offer-intro", "adopter-offer-intro"]],
  ]);
  const from = starterUpgradeSnapshot(app, "1.1.0"), to = starterUpgradeSnapshot(target, "999999.0.0");
  const managedTarget = { ...to.files };
  const legacyCatalogue = readFileSync(join(app, "owned/catalogue.json"));
  const marketPath = "owned/market.config.ts";
  expect(existsSync(join(app, marketPath))).toBe(false);
  if (customized) {
    const previousFile = (path: string) => join(source, previousOwnership.sourceMappings?.[path] ?? path);
    const changedOwned = previousOwnership.owned.filter(path =>
      existsSync(join(target, path)) && !readFileSync(previousFile(path)).equals(readFileSync(join(target, path))));
    for (const path of changedOwned) expect(customizations.has(path), `missing local edit for ${path}`).toBe(true);
    for (const [path, [before, after]] of customizations) edit(path, before, after);
    // Reconcile each local file in place against its released base and target.
    for (const path of customizations.keys()) {
      execFileSync("git", ["merge-file", join(app, path), previousFile(path), join(target, path)], { stdio: "pipe", timeout: 5_000 });
    }
    to.files[marketPath] = readFileSync(join(target, marketPath), "utf8");
    includeSettingsHost(app, target, to);
  } else {
    migrateStarterOwned(app, target, from, to);
  }
  expect(to.files).toEqual({ ...managedTarget,
    [marketPath]: readFileSync(join(target, marketPath), "utf8"),
    [starterSettingsHost]: readFileSync(join(target, starterSettingsHost), "utf8"),
  });
  for (const path of targetOwnership.owned) expect(Object.hasOwn(from.files, path), path).toBe(false);
  writeFileSync(join(directory, "from.json"), JSON.stringify(from)); writeFileSync(join(directory, "to.json"), JSON.stringify(to));
  const run = () => spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
    "--from", join(directory, "from.json"), "--to", join(directory, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8", timeout: 10_000 });
  writeFileSync(join(app, marketPath), "local market divergence");
  const conflict = run(); expect(conflict.status).toBe(1); assertUpgradeConflict(JSON.parse(conflict.stdout), marketPath);
  rmSync(join(app, marketPath));
  const localTest = customized ? reconcileReminderInstallationTest(app, from.files[reminderInstallationTest]!, () => {
    const refusal = run(); expect(refusal.status).toBe(1); return JSON.parse(refusal.stdout);
  }) : undefined;
  const localLifecycle = customized ? reconcileLifecycleCustomization(app, from.files[starterLifecycle]!, () => {
    const before = starterUpgradeSnapshot(app, from.version);
    const refusal = run();
    expect(refusal.status).toBe(1);
    expect(starterUpgradeSnapshot(app, from.version)).toEqual(before);
    expect(existsSync(join(app, marketPath))).toBe(false);
    return JSON.parse(refusal.stdout);
  }) : undefined;
  const localDisplay = customized ? starterDisplayFiles.map(path =>
    reconcileDisplayCustomization(app, from.files[path]!, () => {
      const before = starterUpgradeSnapshot(app, from.version);
      const refusal = run(); expect(refusal.status).toBe(1);
      expect(starterUpgradeSnapshot(app, from.version)).toEqual(before);
      expect(existsSync(join(app, marketPath))).toBe(false);
      return JSON.parse(refusal.stdout);
    }, path)) : [];
  const checkUpgradedFiles = () => {
    expect(read("AGENTS.md")).toContain("customize-the-starter.md#publish-a-saved-catalogue-draft");
    expect(read(reminderInstallationTest)).toBe(to.files[reminderInstallationTest]);
    expect(read(starterLifecycle)).toBe(to.files[starterLifecycle]);
    if (localTest) expect(read(localTest.path)).toBe(localTest.bytes);
    if (localLifecycle) expect(readFileSync(join(app, localLifecycle.path))).toEqual(localLifecycle.bytes);
    for (const path of starterDisplayFiles) expect(read(path), path).toBe(to.files[path]);
    for (const local of localDisplay) expect(readFileSync(join(app, local.path))).toEqual(local.bytes);
  };
  const replay = () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).applied).toEqual([]);
    checkUpgradedFiles();
  };
  const result = run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).applied).toEqual(expect.arrayContaining([marketPath, starterSettingsHost, reminderInstallationTest, starterLifecycle, ...starterDisplayFiles]));
  checkUpgradedFiles();
  replay();
  expect(readFileSync(join(app, "owned/catalogue.json"))).toEqual(legacyCatalogue);
  // Expected bytes come from the target inventory, including contracts that
  // have no runtime refusal. The customized expectation adds each local edit.
  for (const path of targetOwnership.owned) {
    if (starterOptionalOwnedFiles.has(path)) {
      expect(existsSync(join(app, path)), path).toBe(false);
      continue;
    }
    let expected = readFileSync(join(target, path));
    const localEdit = customized ? customizations.get(path) : undefined;
    if (localEdit) {
      expect(expected.toString(), path).toContain(localEdit[0]);
      expected = Buffer.from(expected.toString().replaceAll(...localEdit));
    }
    expect(readFileSync(join(app, path)).equals(expected), `owned bytes after upgrade: ${path}`).toBe(true);
  }
  symlinkSync(resolve("node_modules"), join(app, "node_modules"), "dir");
  if (localLifecycle) {
    const launch = spawnSync(process.execPath, [localLifecycle.path, "ownership"], { cwd: app, encoding: "utf8" });
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.stderr).toBe("Adopter lifecycle customization\n");
    expect(JSON.parse(launch.stdout)).toEqual(targetOwnership);
  }
  // The full upgraded-starter suite runs in the pre-publication proof (#783);
  // here, run only the owned-contract tests so the root shard stays bounded.
  const contracts = [
    "test/locales.test.ts",
    "test/renewal.test.ts",
    "test/policy.test.ts",
    "test/subscription-creation.test.ts",
    reminderInstallationTest,
  ];
  if (localTest) contracts.push(localTest.path);
  const check = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...contracts], { cwd: app, encoding: "utf8", timeout: 60_000 });
  expect(check.status, check.error?.message ?? check.stdout + check.stderr).toBe(0);
  if (localTest) expect(check.stdout).toContain(localTest.name);
  const startup = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { catalogDraftRegistry } from "./owned/catalogue.ts";
    import { configurations } from "./owned/store.config.ts";
    import { composeOperatorCapabilities } from "./host/operator-composition.ts";
    import { createApplication } from "./host/server.ts";

    const each = catalogDraftRegistry.resolve({ key: "starter:item", version: 1 })?.units.find(unit => unit.code === "starter:each");
    assert.deepEqual(each?.factor, { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 }, "starter:each must equal one openlup:piece");

    const operator = composeOperatorCapabilities({ connectionString: "postgresql://localhost/unused", executor: {
      async query(text) {
        assert.match(text, /^SELECT public\\.catalog_draft_get/);
        return { rows: [{ result: null }] };
      },
    } });
    try {
      const id = "10000000-0000-4000-8000-000000000001";
      const result = await operator.actions["operator.catalogDrafts"]({ action: "create", draftId: id, expectedRevision: 0,
        payload: { schemaVersion: 1, skus: [], product: { id, type: { key: "starter:item", version: 1 },
          dimensions: [], sharedContent: { title: "" } } },
      }, { actor: { operatorRef: id }, commandKey: "upgrade-title-rule" });
      assert.deepEqual(result, { ok: false, code: "catalog_draft_payload_invalid",
        issues: [{ path: "product.sharedContent.title", code: ${JSON.stringify(customized ? "local_title_required" : "title_required")} }] });
    } finally { await operator.close(); }

    for (const config of Object.values(configurations)) {
      assert.deepEqual(config.checkoutRecoveryReminders, {
        revision: "starter-1",
        abandonedCart: [
          { stage: "first", afterHours: 1 },
          { stage: "gentle", afterHours: 24 },
          { stage: "last", afterHours: 72 },
        ],
        checkoutRecovery: [{ stage: "first", afterHours: 1 }, { stage: "last", afterHours: 20 }],
      }, config.id);
    }
    const server = createApplication();
    server.listen(0, "127.0.0.1", () => server.close());
  `], { cwd: app, encoding: "utf8", timeout: 10_000 });
  expect(startup.status, startup.error?.message ?? startup.stdout + startup.stderr).toBe(0);
  // A later owned edit also survives replay of the same snapshots.
  edit("owned/store.config.ts", customized ? "#663d57" : "#3d6657", "#123456");
  replay();
  expect(read("owned/store.config.ts")).toContain("#123456");
}, 180_000);

it.each([false, true])("runs retained unpublished candidates and detects a newly required owned file: %s", missing => {
  const { directory, write } = fixture(), source = join(directory, "source"), packs = join(directory, "packs"), version = "999999.0.0";
  const run = (command: string, args: string[], cwd = source) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  cpSync(resolve("scripts"), join(source, "scripts"), { recursive: true }); mkdirSync(packs); write("source/package.json", { type: "module" }); write("source/config/ci-images.json", readFileSync(resolve("config/ci-images.json"), "utf8"));
  write("source/examples/neutral-store/extract.mjs", readFileSync(resolve("examples/neutral-store/extract.mjs"), "utf8"));
  const names = ["core", "outbox", "platform"], dependencies = Object.fromEntries(names.map(name => ["@openlup/" + name, version]));
  write("source/config/openlup-packages.json", { schemaVersion: 2, packages: names.map(name => ({ name: "@openlup/" + name, directory: "packages/" + name, publish: true })), unreleased: [] });
  const packages = names.map(name => {
    const path = join(directory, "package-" + name); cpSync(resolve("packages", name), path, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
    const metadata = JSON.parse(readFileSync(join(path, "package.json"), "utf8")); metadata.version = version;
    for (const section of ["dependencies", "peerDependencies"]) for (const key of Object.keys(metadata[section] ?? {})) if (key.startsWith("@openlup/")) metadata[section][key] = version;
    writeFileSync(join(path, "package.json"), JSON.stringify(metadata)); write("source/packages/" + name + "/package.json", metadata);
    const [pack] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packs], path)), bytes = readFileSync(join(packs, pack.filename));
    return { name: metadata.name, version, filename: pack.filename, integrity: pack.integrity, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const required = missing ? "new.mjs" : "fragments.ts", starter = "source/examples/neutral-store/";
  const starterKeys = JSON.parse(readFileSync(new URL("./fixtures/starter-settings.main.json", import.meta.url), "utf8"))
    .settings.map(({ key }: { key: string }) => key);
  const files = {
    "owned/store.config.ts": "export default '#3d6657';",
    "owned/fragments.ts": "export default 'offer-intro';",
    "owned/new.mjs": "export default true;",
    "AGENTS.md": "# App guide\n\n## Change a business setting\n\nRun the settings script.\n",
    [starterSettingsHost]: `import { z } from "zod";
    export function createSettingsBindings() {
      return { file: { configuration: "sample", validate() {}, entries: {
        ...Object.fromEntries(${JSON.stringify(starterKeys)}.map(key => [key, {
          value: 1, location: { file: "owned/store.config.ts", symbol: key },
          descriptor: { domain: "shipping", goal: "Free shipping", schema: z.number(),
            effect: { appliesTo: "Estimates", impact: "money", frozenOn: [] } },
        }])),
        inventory_renewal_protection: { value: { revision: "sample", renewalProtectionDays: 14 },
          location: { file: "owned/store.config.ts", symbol: "inventory.renewalProtection" } },
      } } };
    }`,
    "test/candidate.test.mjs": `import {readFileSync} from 'node:fs'; readFileSync(new URL('../owned/${required}', import.meta.url));`,
    [reminderInstallationTest]: "import 'node:test';",
    [starterLifecycle]: readFileSync(resolve("examples/neutral-store", starterLifecycle), "utf8"),
    ...Object.fromEntries(starterDisplayFiles.map(path => [path, readFileSync(resolve("examples/neutral-store", path), "utf8")])),
    "browser/dev-loop.proof.ts": "import 'node:assert/strict';",
    ".gitignore": "node_modules/\npackage-lock.json\n",
  };
  for (const [path, bytes] of Object.entries(files)) write(starter + path, bytes);
  const ownership = { owned: Object.keys(files).filter(path => path.startsWith("owned/") || path === "AGENTS.md"), managed: ["ownership.json", "package.json", ...Object.keys(files).filter(path => !path.startsWith("owned/") && path !== "AGENTS.md")], generated: [], sourceOnly: [] };
  write(starter + "ownership.json", ownership); write(starter + "starter-release.json", {});
  write(starter + "package.json", { name: "candidate-fixture", version: "0.0.0", private: true, type: "module", dependencies: { ...dependencies, zod: "4.6.6" }, scripts: { settings: "openlup settings --app ./owned/settings-host.ts", test: "node --experimental-strip-types --test test/candidate.test.mjs", typecheck: `node --check owned/${required}`, build: "node --version" } });
  run("git", ["init", "--initial-branch=main"]); run("git", ["add", "."]);
  run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "Candidate fixture"]);
  run("git", ["remote", "add", "origin", "https://github.com/openlup/openlup.git"]);
  const commit = run("git", ["rev-parse", "HEAD"]).trim(), manifest = join(packs, "packages-manifest.json"), receipt = join(directory, "receipt.json");
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, commit, packages }));
  write("deny.mjs", `import http from 'node:http'; import https from 'node:https'; import {existsSync,readFileSync,appendFileSync} from 'node:fs'; const p=existsSync('package.json')?JSON.parse(readFileSync('package.json')):{}; if (Object.values(p.dependencies??{}).some(v=>String(v).includes('${version}'))) for (const m of [http,https]) {const request=m.request; m.request=(...args)=>{const url=String(args[0]?.href??args[0]?.path??args[0]); if(decodeURIComponent(url).includes('@openlup/')) {appendFileSync(${JSON.stringify(join(directory, "denied"))},url); throw Error('candidate registry request denied');} return request.apply(m,args);};}`);
  write("bin/npm", `#!/bin/sh\nif [ "$1" = view ]; then printf '%s\\n' '["1.1.0"]'; exit 0; fi\nexec "${process.execPath}" --import "${join(directory, "deny.mjs")}" "${resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")}" "$@"\n`); chmodSync(join(directory, "bin/npm"), 0o755);
  const result = spawnSync(process.execPath, [join(source, "scripts/packages/exact-set-qualification.mjs"), "openlup-core-v" + version, commit, receipt, "--candidate", manifest], { cwd: source, env: { ...env, PATH: join(directory, "bin") + ":" + env.PATH }, encoding: "utf8", timeout: 180_000 });
  expect(existsSync(receipt), result.stderr).toBe(true); const evidence = JSON.parse(readFileSync(receipt, "utf8")); expect(result.status, result.stderr).toBe(missing ? 1 : 0);
  expect(evidence).toMatchObject({ mode: "candidate", verificationSource: "candidate, local digest-verified", result: missing ? "FAIL" : "PASS", upgrade: { result: missing ? "FAIL" : "PASS" } });
  const smokes = evidence.upgrade.checks.filter(({ command }: { command: string[] }) =>
    command[0]?.endsWith("/node_modules/.bin/openlup") && command.includes("check") && command[1] === "settings");
  expect(smokes.map(({ result }: { result: string }) => result)).toEqual(["PASS", "PASS"]);
  expect(evidence.upgrade.managedConflict).toEqual({ path: "test/candidate.test.mjs", action: "create" });
  expect(evidence.upgrade.phases).toHaveLength((missing ? 10 : 11) + starterDisplayFiles.length);
  expect(evidence.upgrade.phases).toContainEqual({ name: "reminder-test-reconciliation", result: "PASS" });
  expect(evidence.upgrade.phases).toContainEqual({ name: "lifecycle-reconciliation", result: "PASS" });
  expect(evidence.upgrade.phases).toContainEqual({ name: "settings-host-reconciliation", result: "PASS" });
  const phases = evidence.upgrade.phases.map(({ name }: { name: string }) => name);
  expect(phases).not.toContain("checkout-host-reconciliation");
  expect(phases).not.toContain("checkout-attempt-effect-reconciliation");
  expect(phases).not.toContain("checkout-attempt-copy-reconciliation");
  for (const path of starterDisplayFiles)
    expect(evidence.upgrade.phases).toContainEqual({ name: `display-reconciliation:${path}`, result: "PASS" });
  expect(evidence.upgrade.phases.filter((phase: { result: string }) => phase.result !== "PASS")).toEqual([]);
  if (!missing) for (const mode of ["candidate", "released"]) {
    const path = receipt + ".applications/1/input/package-lock.json", lock = JSON.parse(readFileSync(path, "utf8")); cpSync(join(packs, packages[0]!.filename), join(directory, "foreign.tgz"));
    lock.packages["node_modules/@openlup/core"].resolved = "file:" + (mode === "candidate" ? join(directory, "foreign.tgz") : join(packs, packages[0]!.filename)); writeFileSync(path, JSON.stringify(lock));
    const refused = spawnSync(process.execPath, [resolve("examples/neutral-store/extract.mjs"), join(directory, mode), "--source", receipt + ".applications/1/source/examples/neutral-store", "--mode", mode, "--set-version", version, "--source-revision", commit, "--manifest", manifest, "--lockfile", path], { encoding: "utf8" });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain("starter_release_lock_non_registry: @openlup/core");
  }
  if (missing) expect(evidence.upgrade.checks.at(-1)).toMatchObject({ command: ["npm", "test"], result: "FAIL" });
}, 180_000);
