import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";
import { qualificationReceipt, qualifyReleasedSet } from "./exact-set-qualification.mjs";
import { assertCompleteStarter, assertUpgradeConflict, previousPublishedSet, migrateStarterOwned,
  reconcileLifecycleCustomization, reconcileReminderInstallationTest, reminderInstallationTest,
  starterLifecycle, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

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
    [{ hint: "Check postgresql://db.invalid/demo." }, "Check [redacted]\n"],
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

it("distinguishes the three verify --app stages with constant messages while withholding private details", () => {
  const { directory, write } = fixture();
  const cli = resolve("packages/platform/src/lifecycle/openlup.mjs");
  const runCli = (args: string[], expected: number) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    expect(result.status).toBe(expected);
    expect(result.stderr).toBe("");
    return result.stdout;
  };
  expect(JSON.parse(runCli(["verify", "--json"], 2))).toMatchObject({
    formatVersion: 1, command: "verify", state: "unknown", exitCode: 2,
    findings: [{ code: "OPENLUP_E_APP_UNKNOWN" }],
  });
  expect(JSON.parse(runCli(["verify", "--app", "", "--json"], 64))).toMatchObject({
    formatVersion: 1, state: "refused", exitCode: 64,
    findings: [{ code: "OPENLUP_E_CLI_INPUT" }],
  });
  for (const [name, source, expectedObserved, expectedCause] of [
    ["load-syntax.mjs", "export const = 1;", "The --app module could not be loaded; raw application errors are withheld.", "Importing the trusted --app module failed before createVerificationInput() could be checked."],
    ["load-throw.mjs", 'throw new Error("synthetic-private-detail");', "The --app module could not be loaded; raw application errors are withheld.", "Importing the trusted --app module failed before createVerificationInput() could be checked."],
    ["missing-export.mjs", 'export const createVerificationInput = "synthetic-private-detail";', "The loaded --app module does not export a createVerificationInput() function.", "The trusted --app module loaded, but createVerificationInput was absent or not a function."],
    ["factory-throw.mjs", 'export function createVerificationInput() { throw new Error("synthetic-private-detail"); }', "createVerificationInput() failed while assembling observations; raw application errors are withheld.", "Executing createVerificationInput() in the trusted --app module failed before readiness evaluation."],
    ["factory-reject.mjs", 'export async function createVerificationInput() { throw new TypeError("synthetic-private-detail"); }', "createVerificationInput() failed while assembling observations; raw application errors are withheld.", "Executing createVerificationInput() in the trusted --app module failed before readiness evaluation."],
  ] as const) {
    const appPath = join(directory, name);
    write(name, source);
    const jsonOut = runCli(["verify", "--app", appPath, "--json"], 74);
    expect(jsonOut).not.toContain("synthetic-private-detail");
    expect(JSON.parse(jsonOut)).toMatchObject({
      formatVersion: 1, state: "failed", exitCode: 74,
      findings: [{ code: "OPENLUP_E_CLI_FAILURE", observed: expectedObserved, cause: expectedCause }],
    });
    const textOut = runCli(["verify", "--app", appPath], 74);
    expect(textOut).toContain(expectedObserved);
    expect(textOut).toContain(expectedCause);
    expect(textOut).not.toContain("synthetic-private-detail");
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
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "999999.0.0");
  migrateStarterOwned(app, target, from, { ...to, version: "1.2.0" });
  expect(readFileSync(join(app, path), "utf8")).toBe(previous);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, path), "utf8")).toBe(next);
  expect(readFileSync(join(app, pack), "utf8")).toBe(packBytes);
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
  const marketPath = "owned/market.config.ts";
  expect(existsSync(join(app, marketPath))).toBe(false);
  if (customized) {
    const previousFile = (path: string) => join(source, previousOwnership.sourceMappings?.[path] ?? path);
    const changedOwned = previousOwnership.owned.filter(path =>
      !readFileSync(previousFile(path)).equals(readFileSync(join(target, path))));
    for (const path of changedOwned) expect(customizations.has(path), `missing local edit for ${path}`).toBe(true);
    for (const [path, [before, after]] of customizations) edit(path, before, after);
    // Reconcile each local file in place against its released base and target.
    for (const path of customizations.keys()) {
      execFileSync("git", ["merge-file", join(app, path), previousFile(path), join(target, path)], { stdio: "pipe", timeout: 5_000 });
    }
    to.files[marketPath] = readFileSync(join(target, marketPath), "utf8");
  } else {
    migrateStarterOwned(app, target, from, to);
  }
  expect(to.files).toEqual({ ...managedTarget, [marketPath]: readFileSync(join(target, marketPath), "utf8") });
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
  const checkUpgradedFiles = () => {
    expect(read(reminderInstallationTest)).toBe(to.files[reminderInstallationTest]);
    expect(read(starterLifecycle)).toBe(to.files[starterLifecycle]);
    if (localTest) expect(read(localTest.path)).toBe(localTest.bytes);
    if (localLifecycle) expect(readFileSync(join(app, localLifecycle.path))).toEqual(localLifecycle.bytes);
  };
  const replay = () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).applied).toEqual([]);
    checkUpgradedFiles();
  };
  const result = run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).applied).toEqual(expect.arrayContaining([marketPath, reminderInstallationTest, starterLifecycle]));
  checkUpgradedFiles();
  replay();
  // Expected bytes come from the target inventory, including contracts that
  // have no runtime refusal. The customized expectation adds each local edit.
  for (const path of targetOwnership.owned) {
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
    import { createApplication } from "./host/server.ts";

    const each = catalogDraftRegistry.resolve({ key: "starter:item", version: 1 })?.units.find(unit => unit.code === "starter:each");
    assert.deepEqual(each?.factor, { canonicalUnit: "openlup:piece", unscaled: "1", scale: 0 }, "starter:each must equal one openlup:piece");

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
  const files = {
    "owned/store.config.ts": "export default '#3d6657';",
    "owned/fragments.ts": "export default 'offer-intro';",
    "owned/new.mjs": "export default true;",
    "test/candidate.test.mjs": `import {readFileSync} from 'node:fs'; readFileSync(new URL('../owned/${required}', import.meta.url));`,
    [reminderInstallationTest]: "import 'node:test';",
    [starterLifecycle]: readFileSync(resolve("examples/neutral-store", starterLifecycle), "utf8"),
    "browser/dev-loop.proof.ts": "import 'node:assert/strict';",
    ".gitignore": "node_modules/\npackage-lock.json\n",
  };
  for (const [path, bytes] of Object.entries(files)) write(starter + path, bytes);
  const ownership = { owned: Object.keys(files).filter(path => path.startsWith("owned/")), managed: ["ownership.json", "package.json", ...Object.keys(files).filter(path => !path.startsWith("owned/"))], generated: [], sourceOnly: [] };
  write(starter + "ownership.json", ownership); write(starter + "starter-release.json", {});
  write(starter + "package.json", { name: "candidate-fixture", version: "0.0.0", private: true, type: "module", dependencies, scripts: { test: "node --experimental-strip-types --test test/candidate.test.mjs", typecheck: `node --check owned/${required}`, build: "node --version" } });
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
  expect(evidence.upgrade.managedConflict).toEqual({ path: "test/candidate.test.mjs", action: "create" });
  expect(evidence.upgrade.phases).toHaveLength(missing ? 9 : 10);
  expect(evidence.upgrade.phases).toContainEqual({ name: "reminder-test-reconciliation", result: "PASS" });
  expect(evidence.upgrade.phases).toContainEqual({ name: "lifecycle-reconciliation", result: "PASS" });
  expect(evidence.upgrade.phases.filter((phase: { result: string }) => phase.result !== "PASS")).toEqual([]);
  if (!missing) for (const mode of ["candidate", "released"]) {
    const path = receipt + ".applications/1/input/package-lock.json", lock = JSON.parse(readFileSync(path, "utf8")); cpSync(join(packs, packages[0]!.filename), join(directory, "foreign.tgz"));
    lock.packages["node_modules/@openlup/core"].resolved = "file:" + (mode === "candidate" ? join(directory, "foreign.tgz") : join(packs, packages[0]!.filename)); writeFileSync(path, JSON.stringify(lock));
    const refused = spawnSync(process.execPath, [resolve("examples/neutral-store/extract.mjs"), join(directory, mode), "--source", receipt + ".applications/1/source/examples/neutral-store", "--mode", mode, "--set-version", version, "--source-revision", commit, "--manifest", manifest, "--lockfile", path], { encoding: "utf8" });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain("starter_release_lock_non_registry: @openlup/core");
  }
  if (missing) expect(evidence.upgrade.checks.at(-1)).toMatchObject({ command: ["npm", "test"], result: "FAIL" });
}, 180_000);
