import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertCompleteStarter, migrateStarterOwned, proveSettingsDiscovery, proveSettingsMcp,
  includeSettingsHost, reconcileEditorCustomization, starterEditorPorts, starterSettingsHost, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

import { proveNeutralStarterConsumer } from "./exact-set-qualification.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "settings-upgrade-"));
  directories.push(directory);
  const write = (path: string, content: unknown) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  write("ownership.json", { managed: ["package.json", "ownership.json"], owned: ["AGENTS.md"], generated: [] });
  write("package.json", { dependencies: { "@openlup/core": "0.40.0" } });
  write("node_modules/@openlup/core/package.json", { version: "0.40.0" });
  return { directory, write };
}

type CapturedSettings = { args: string[]; exit: number; stdout: string };

const starter = resolve("examples/neutral-store");
const baseline = JSON.parse(readFileSync(new URL("./fixtures/starter-settings.main.json", import.meta.url), "utf8")) as {
  legacyHost: string;
  settings: { key: string; goal: string }[];
  discovery: CapturedSettings[];
  checks: CapturedSettings[];
};
const starterKeys = baseline.settings.map(({ key }) => key);
const discoveryCase = (...args: string[]) =>
  baseline.discovery.find(row => JSON.stringify(row.args) === JSON.stringify(args))!;
const defaultCheck = baseline.checks.find(row => row.args[2] === "supplements" && row.args.includes("--json"))!;

function runStarterSettings(app: string, args: string[]) {
  const { status, stdout, stderr, error } = spawnSync("npm", ["--silent", "run", "settings", "--", ...args], { cwd: app, encoding: "utf8" });
  expect(error).toBeUndefined();
  return { exit: status, stdout, stderr };
}

function applyDocumentedHostEdit(legacy: string, target: string) {
  const fragment = readFileSync("packages/core/changes/settings-check-starter.md", "utf8");
  const [poolImport, zodImport, oldType, newType, oldEntries, newEntries, oldFilter, newFilter] =
    /```diff\n([\s\S]+?)\n```/u.exec(fragment)![1]!.split("\n").map(line => line.slice(1));
  const changes = [[poolImport!, poolImport! + "\n" + zodImport], [oldType!, newType!],
    [oldEntries!, newEntries!], [oldFilter!, newFilter!]];
  let edited = legacy;
  for (const [before, after] of changes) {
    expect(edited).toContain(before);
    edited = edited.replace(before, after);
  }
  for (const key of starterKeys) {
    const start = `    '${key}': {`;
    const descriptor = /^ {6}descriptor: \{\n[\s\S]+?^ {6}\},$/mu.exec(target.split(start)[1]!)![0];
    const entry = edited.indexOf(start);
    expect(entry).toBeGreaterThanOrEqual(0);
    const end = edited.indexOf(" },\n", entry);
    expect(end).toBeGreaterThan(entry);
    edited = edited.slice(0, end) + ",\n" + descriptor + "\n    }," + edited.slice(end + " },".length);
  }
  return edited;
}

it.each([false, true])("upgrades the command and creates or preserves its owned host, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const guide = "# App guide\n\nLocal workflow.\n";
  const section = "\n## Change a business setting\n\nRun `npm --silent run settings -- list`.\n";
  write("AGENTS.md", guide);
  candidate("AGENTS.md", guide + section);
  candidate("ownership.json", { managed: ["package.json", "ownership.json"], owned: ["AGENTS.md", starterSettingsHost], generated: [] });
  const pkg = { dependencies: { "@openlup/core": "0.40.0" }, scripts: { settings: "openlup settings --app ./owned/settings-host.ts" } };
  candidate("package.json", pkg);
  const file = "file: { configuration: 'sample', entries: { 'offer.freeShippingFromMinor': { value: 12000, location: { file: 'owned/store.config.ts', symbol: 'offer.freeShippingFromMinor' }, descriptor: { domain: 'shipping', goal: 'Free shipping', effect: { appliesTo: 'Estimates', impact: 'money', frozenOn: [] } } } } }";
  candidate(starterSettingsHost, "export function createSettingsBindings() { return { " + file + " }; }");
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "1.3.0");
  migrateStarterOwned(app, target, from, to);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe(guide + section);
  expect(Object.hasOwn(to.files, "AGENTS.md")).toBe(false);
  write("from.json", from); write("to.json", to);
  const apply = (status = 0) => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
      "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };
  const local = "export function createSettingsBindings() { return { stockSourceKey: 'local' }; }";
  const hostFile = join(app, starterSettingsHost);
  if (customized) {
    write(starterSettingsHost, local);
    expect(apply(1)).toMatchObject({ applied: [], conflicts: [{ path: starterSettingsHost }] });
    expect(starterUpgradeSnapshot(app, from.version)).toEqual(from);
    expect(readFileSync(hostFile, "utf8")).toBe(local);
    includeSettingsHost(app, target, to);
    write("to.json", to);
  }
  expect(apply().applied.sort()).toEqual(customized ? ["ownership.json", "package.json"] : [starterSettingsHost, "ownership.json", "package.json"].sort());
  expect(apply().applied).toEqual([]);
  expect(readFileSync(hostFile, "utf8")).toBe(customized ? local : to.files[starterSettingsHost]);
  expect(() => assertCompleteStarter(app, to)).not.toThrow();

  const check = (status: number) => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"),
      "settings", "check", "--app", "./" + starterSettingsHost, "--json"], { cwd: app, encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };
  if (customized) {
    expect(check(2)).toMatchObject({ state: "unknown", appValidation: { hint: expect.stringContaining("Add file: { configuration, entries }") } });
    const reconciled = local.replace("stockSourceKey: 'local'", "stockSourceKey: 'local', " + file);
    write(starterSettingsHost, reconciled);
    expect(apply().applied).toEqual([]);
    expect(readFileSync(hostFile, "utf8")).toBe(reconciled);
  }
  expect(check(0)).toMatchObject({ state: "checked", configuration: "sample", rows: expect.arrayContaining([
    expect.objectContaining({ key: "offer.freeShippingFromMinor", file: expect.objectContaining({ value: 12000 }) }),
  ]) });
});

it("preserves and reconciles an existing value-only host after a manifest refusal", () => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const guide = "# App guide\n\nLocal workflow.\n";
  const section = "\n## Change a business setting\n\nRun the settings script.\n";
  const pkg = { type: "module", dependencies: { "@openlup/core": "0.40.0" }, scripts: { settings: "openlup settings --app ./owned/settings-host.ts" } };
  const owned = ["AGENTS.md", starterSettingsHost];
  const ownership = { managed: ["package.json", "ownership.json"], owned, generated: [] };
  const targetHost = readFileSync(join(starter, starterSettingsHost), "utf8");
  const legacy = baseline.legacyHost.replace("starter-demo:", "local-demo:");
  const hostFile = join(app, starterSettingsHost);
  write("AGENTS.md", guide);
  candidate("AGENTS.md", guide + section);
  candidate("ownership.json", { ...ownership, generated: ["package-lock.json"] });
  candidate("package.json", { ...pkg, dependencies: { ...pkg.dependencies, zod: "4.6.6" } });
  candidate(starterSettingsHost, targetHost);
  write("ownership.json", ownership);
  write("package.json", pkg);
  write(starterSettingsHost, legacy);

  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "1.3.0");
  migrateStarterOwned(app, target, from, to);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe(guide + section);
  expect(Object.hasOwn(to.files, "AGENTS.md")).toBe(false);
  expect(Object.hasOwn(to.files, starterSettingsHost)).toBe(false);
  expect(to.files["ownership.json"]).not.toBe(from.files["ownership.json"]);
  write("from.json", from); write("to.json", to);
  const apply = (status = 0) => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
      "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };

  const localCommand = 'console.log("local starter command");';
  write("package.json", { ...pkg, scripts: { ...pkg.scripts, local: `node -e '${localCommand}'` } });
  const before = starterUpgradeSnapshot(app, from.version);
  expect(apply(1)).toMatchObject({ applied: [], conflicts: [{ path: "package.json" }] });
  expect(starterUpgradeSnapshot(app, from.version)).toEqual(before);
  expect(readFileSync(join(app, "ownership.json"), "utf8")).toBe(from.files["ownership.json"]);
  expect(readFileSync(hostFile, "utf8")).toBe(legacy);
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe(guide + section);
  write("owned/local.mjs", localCommand);
  write("package.json", from.files["package.json"]!);

  expect(apply().applied.sort()).toEqual(["ownership.json", "package.json"]);
  expect(readFileSync(hostFile, "utf8")).toBe(legacy);
  expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).dependencies.zod).toBe("4.6.6");
  expect(() => assertCompleteStarter(app, to)).not.toThrow();

  for (const path of ["owned/acquisition-policy.ts", "owned/store.config.ts", "shared"]) {
    symlinkSync(join(starter, path), join(app, path));
  }
  mkdirSync(join(app, "node_modules/.bin"));
  for (const path of ["@openlup/platform", ".bin/openlup", "zod"]) {
    symlinkSync(resolve("node_modules", path), join(app, "node_modules", path));
  }
  const search = discoveryCase("list", "--goal", "free shipping", "--json");
  const { entries, ...listDocument } = JSON.parse(search.stdout);
  const { rows, ...checkDocument } = JSON.parse(defaultCheck.stdout);
  const remaining = (row: { key: string }) => !starterKeys.includes(row.key);
  const warning = `Settings app: value reported without a descriptor for ${starterKeys.toSorted().map(key => JSON.stringify(key)).join(", ")}. Add a descriptor to each named file.entries entry. See node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md#declare-a-setting-of-your-own.\n`;
  const verifyLegacy = () => {
    expect(readFileSync(hostFile, "utf8")).toBe(legacy);
    expect(runStarterSettings(app, search.args)).toEqual({
      exit: search.exit, stdout: JSON.stringify({ ...listDocument, entries: entries.filter(remaining) }) + "\n", stderr: warning,
    });
    expect(runStarterSettings(app, defaultCheck.args)).toEqual({
      exit: defaultCheck.exit, stdout: JSON.stringify({ ...checkDocument, rows: rows.filter(remaining) }) + "\n", stderr: warning,
    });
  };
  verifyLegacy();
  expect(apply().applied).toEqual([]);
  verifyLegacy();
  expect(readFileSync(join(app, "owned/local.mjs"), "utf8")).toBe(localCommand);

  const reconciled = applyDocumentedHostEdit(legacy, targetHost);
  const typedFixture = readFileSync(new URL("./fixtures/settings-upgrade-host.ts", import.meta.url), "utf8");
  // The fixture rebases its starter imports so the repository typecheck can compile it in place.
  expect(typedFixture).toBe(reconciled
    .replaceAll("from './", "from '../../../examples/neutral-store/owned/")
    .replace("from '../shared/", "from '../../../examples/neutral-store/shared/"));
  write(starterSettingsHost, reconciled);
  expect(apply().applied).toEqual([]);
  expect(readFileSync(hostFile, "utf8")).toBe(reconciled);

  const listed = runStarterSettings(app, ["list", "--json"]);
  expect(listed.exit).toBe(0);
  expect(listed.stderr).toBe("");
  expect(JSON.parse(listed.stdout).entries.map(({ key }: { key: string }) => key)).toEqual(expect.arrayContaining(starterKeys));
  expect(runStarterSettings(app, defaultCheck.args)).toEqual({ exit: defaultCheck.exit, stdout: defaultCheck.stdout, stderr: "" });
});

it("refuses an extracted starter without the settings script", () => {
  const { directory } = fixture();
  expect(() => proveSettingsDiscovery(directory)).toThrow("extracted starter settings script missing");
});

it.each([
  ["subscriptionCreation", "starter_subscription_creation_invalid", "subscriptionCreation.editWindowHours"],
  ["inventory", "inventory_renewal_protection_policy_invalid", "inventory_renewal_protection"],
  ["id", "starter_configuration_unknown", undefined],
])("reports startup validation for an invalid starter %s", (field, message, key) => {
  const { directory, write } = fixture();
  const starter = resolve("examples/neutral-store/owned");
  const load = (name: string) => JSON.stringify(pathToFileURL(join(starter, name)).href);
  const id = field === "id" ? "unregistered" : "supplements";
  write("missing-config.mjs", `
    const { configurations } = await import(${load("store.config.ts")});
    ${key ? `delete configurations.supplements[${JSON.stringify(field)}];` : `configurations.supplements.id = ${JSON.stringify(id)};`}
    const { createSettingsBindings } = await import(${load("settings-host.ts")});
    export { createSettingsBindings };
  `);
  const run = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings",
    "check", "--app", "./missing-config.mjs", "--configuration", "supplements", "--json"], { cwd: directory, encoding: "utf8" });
  expect(run.status, run.stderr || run.stdout).toBe(1);
  expect(JSON.parse(run.stdout)).toMatchObject({
    configuration: id, state: "invalid", appValidation: { state: "failed", message },
    ...(key ? { rows: expect.arrayContaining([expect.objectContaining({ key, file: { state: "not-reported" } })]) } : {}),
  });
});

it.each([
  ["module not found", undefined, 74, undefined, undefined],
  ["no factory export", "export const other = 1;", 74, undefined, undefined],
  ["throws at import", "throw new Error('starter_subscription_offer_invalid');", 1, "load", "starter_subscription_offer_invalid"],
  ["throws in the factory", "export function createSettingsBindings() { throw new Error('invalid policy'); }", 1, "load", "invalid policy"],
  ["throws in validate", "export function createSettingsBindings() { return { file: { configuration: 'sample', entries: {}, validate() { throw Error('startup rejected'); } } }; }",
    1, undefined, "startup rejected"],
] as const)("classifies %s through the binary", (_, source, status, phase, message) => {
  const { directory, write } = fixture();
  if (source) write(starterSettingsHost, source);
  const args = [resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "check", "--app", starterSettingsHost];
  const run = (...flags: string[]) => spawnSync(process.execPath, [...args, ...flags], { cwd: directory, encoding: "utf8" });
  const json = run("--json");
  expect(json.status, json.stderr).toBe(status);
  if (status === 74) expect(JSON.parse(json.stdout)).toMatchObject({
    schemaVersion: 1, refusal: { code: "commerce_setting_read_unavailable", path: ["app"], hint: expect.stringContaining("createSettingsBindings") },
  });
  else {
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, state: "invalid", appValidation: { state: "failed", message } });
    expect(report.appValidation.phase).toBe(phase);
    expect(run().stdout).toContain(phase === "load" ? `Application configuration rejected while loading — ${message}` : `App startup validation: failed — ${message}`);
  }
});

it.each([
  ["candidate", true, 2, false], ["candidate", false, 1, true], ["released", false, 0, false],
] as const)("requires the check smoke in %s mode with reported file values=%s", (mode, reportsFile, calls, rejects) => {
  const { directory: app, write } = fixture();
  write("package-lock.json", {});
  write("package.json", { scripts: { settings: "openlup settings --app ./owned/settings-host.ts" } });
  write(starterSettingsHost, `${reportsFile ? `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n` : ""}
  export function createSettingsBindings() { return ${reportsFile ? `{ file: {
    configuration: "sample", validate() {}, entries: {
      ...Object.fromEntries(${JSON.stringify(starterKeys)}.map(key => [key, {
        value: 1, location: { file: "owned/store.config.ts", symbol: key },
        descriptor: { domain: "shipping", goal: "Free shipping", schema: z.number(),
          effect: { appliesTo: "Estimates", impact: "money", frozenOn: [] } },
      }])),
      inventory_renewal_protection: { value: { revision: "sample", renewalProtectionDays: 14 },
        location: { file: "owned/store.config.ts", symbol: "inventory.renewalProtection" } },
    },
  } }` : "{}"}; }`);
  const settingsCalls: string[][] = [];
  const proof = () => proveNeutralStarterConsumer(app, {
    mode, application: app, environment: {}, packages: [], settingsDiscovery: false,
    lockfileSha256: createHash("sha256").update(readFileSync(join(app, "package-lock.json"))).digest("hex"),
    verifyInstalled() {},
    run(command, args, cwd) {
      if (command === "git" && args[0] === "rev-parse") return realpathSync(app);
      if (command !== join(app, "node_modules/.bin/openlup")) return "";
      settingsCalls.push(args);
      const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), ...args], { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`settings smoke exited ${result.status}`);
      return result.stdout;
    },
  });
  if (rejects) expect(proof).toThrow("settings smoke exited 2");
  else expect(proof).not.toThrow();
  const script = ["settings", "--app", "./owned/settings-host.ts"];
  expect(settingsCalls).toEqual([
    ...(calls >= 1 ? [[...script, "check", "--json"]] : []),
    ...(calls === 2 ? [[...script, "list", "--goal", "free shipping"]] : []),
  ]);
});

it.each([
  ["valid with fresh availability", { state: "valid", value: { renewalProtectionDays: 21 } },
    { renewalProtectionDays: 7 }, 5, false, "Normalized:", "5 currently available, 3 estimated under the proposal (provider)"],
  ["invalid with stale and unavailable values", { state: "invalid", code: "invalid_policy", rule: "rule", hint: "hint",
    remediation: { action: "action", command: "command" } },
    null, null, true, "invalid_policy", "unavailable currently available, unavailable estimated under the proposal (provider, stale)"],
] as const)("renders connected preview text for %s", (_, validation, difference, current, stale, detail, quantities) => {
  const { directory, write } = fixture();
  const key = "inventory_renewal_protection";
  const result = {
    schemaVersion: 1, key, asOf: new Date(0).toISOString(), current: { renewalProtectionDays: 14 },
    proposed: {}, validation, difference, uncertainty: "Observed at the supplied instant.",
    effect: { newPurchaseAvailability: "nonincreasing", skus: [{ sku: "SKU-1", source: "provider", stale,
      currentAvailableForNewPurchases: current, proposedAvailableForNewPurchases: current === null ? null : 3 }] },
  };
  write(starterSettingsHost, `export function createSettingsBindings() { return { previewers: { ${key}: async () => (${JSON.stringify(result)}) } }; }`);
  const text = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "--app", starterSettingsHost,
    "preview", key, "--value", "{}", "--database-url", "postgresql://sample@unused.invalid/shop"], { cwd: directory, encoding: "utf8" });
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain(`Validation: ${validation.state}`);
  expect(text.stdout).toContain(`Horizon difference in days: ${difference?.renewalProtectionDays ?? "unavailable"}`);
  expect(text.stdout).toContain(detail);
  // The package formatter includes the new estimate beside the original current quantity.
  expect(text.stdout).toContain(`SKU-1: ${quantities}`);
  expect(text.stdout).toContain("Existing reservations keep their quantities and expiry times.");
  expect(text.stdout).toContain(result.uncertainty);
});

it("refuses the native PostgreSQL client before using a connected settings binder", () => {
  const { directory, write } = fixture();
  const key = "inventory_renewal_protection";
  write(starterSettingsHost, `export function createSettingsBindings() {
    return { readers: { ${key}: () => ({ present: false }) }, previewers: { ${key}: () => ({ schemaVersion: 1 }) } };
  }`);
  const cli = resolve("packages/platform/src/lifecycle/openlup.mjs");
  for (const [command, flags, refusal] of [
    ["show", [], "commerce_setting_read_unavailable"],
    ["preview", ["--value", "{}"], "commerce_setting_preview_unexpected"],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, "settings", command, key, ...flags, "--app", starterSettingsHost,
      "--database-url", "postgresql://sample:fake@unused.invalid/shop?sslmode=verify-full", "--json"],
    { cwd: directory, encoding: "utf8", env: { ...process.env, NODE_PG_FORCE_NATIVE: "1" } });
    expect(result.status, result.stderr).toBe(74);
    expect(JSON.parse(result.stdout).refusal).toMatchObject({ code: refusal, hint: expect.stringContaining("Unset NODE_PG_FORCE_NATIVE") });
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/sample|fake|unused\.invalid/u);
  }
});

it("consumes an idle Pool error without printing its message", () => {
  const { directory, write } = fixture();
  const key = "inventory_renewal_protection";
  const app = "settings-idle-fixture.mjs";
  write(app, `export function createSettingsBindings({ db }) {
    db.emit("error", new Error("private role fake_idle_role"));
    return { readers: { ${key}: () => ({ present: false }) } };
  }`);
  const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "show", key,
    "--app", app, "--database-url", "postgresql://sample@unused.invalid/shop", "--json"],
  { cwd: directory, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("fake_idle_role");
});

it.each([false, true])("replaces the managed editor through apply and replay, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const editor = starterEditorPorts;
  const catalogue = "host/editor-catalogue.ts"; // A replacement ordered before the editor conflict.
  const ownership = { managed: ["package.json", "ownership.json", catalogue, editor], owned: ["AGENTS.md"], generated: [] };
  write("ownership.json", ownership); candidate("ownership.json", ownership);
  write(catalogue, "export const revision = 1;");
  candidate(catalogue, "export const revision = 2;");
  write(editor, "const method = 'readPort.read';");
  candidate(editor, "const method = 'readInstalled';");
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "1.3.0");
  write("from.json", from); write("to.json", to);
  const run = (command: "plan" | "apply", status = 0) => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", command, "--root", app,
      "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    return JSON.parse(result.stdout);
  };
  const local = customized ? reconcileEditorCustomization(app, from.files[editor]!, () => {
    const before = starterUpgradeSnapshot(app, from.version);
    const report = run("apply", 1);
    expect(starterUpgradeSnapshot(app, from.version)).toEqual(before);
    return report;
  }) : undefined;
  if (local) expect(run("plan").plan.conflicts).toEqual([]);
  expect(run("apply").applied).toEqual([catalogue, editor]);
  expect(readFileSync(join(app, editor), "utf8")).toBe(to.files[editor]);
  expect(run("apply").applied).toEqual([]);
  expect(() => assertCompleteStarter(app, to)).not.toThrow();
  if (local) expect(readFileSync(join(app, local.path))).toEqual(local.bytes);
});

it.each([
  ["missing", undefined, "Check the --app path and the createSettingsBindings export."],
  ["missing factory", "export const other = 1;", "Check the --app path and the createSettingsBindings export."],
  ["throwing", "throw new Error('rejected\\nedit');", "rejected edit"],
] as const)("keeps package discovery stdout when the %s module cannot load", (_, source, cause) => {
  const { directory, write } = fixture();
  const app = "./settings-fixture.mjs";
  if (source) write(app, source);
  const invoke = (...args: string[]) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"),
      "settings", ...args, "--json"], { cwd: directory, encoding: "utf8" });
    return { status, stdout, stderr };
  };
  for (const args of [["list"], ["show", "inventory_renewal_protection"], ["explain", "inventory_renewal_protection"]]) {
    const base = invoke(...args);
    const withApp = invoke(...args, "--app", app);
    expect(base.status).toBe(0);
    expect(withApp).toEqual({ ...base, stderr: args[0] === "list" ? `Settings app: ${cause}\n` : "" });
  }
});

function expectedStarterDiscovery(captured: CapturedSettings, key: string) {
  const [command] = captured.args;
  const { setting: before } = JSON.parse(discoveryCase("show", key, "--json").stdout);
  const check = JSON.parse(defaultCheck.stdout);
  const value = check.rows.find((row: { key: string }) => row.key === key).file.value;
  const runtimeReason = "Edit the application configuration and deploy.";
  const editWindowGoal = "Set how many hours before a renewal customers can edit a newly created subscription (edit cutoff, change deadline, activation window).";
  const goal = key === "subscriptionCreation.editWindowHours" ? editWindowGoal : before.goal;
  const displayedSchema = z.toJSONSchema(z.fromJSONSchema(before.schema), { target: "draft-07", io: "input", reused: "inline" });
  const fileObservation = { state: "file", configuration: check.configuration, value };
  if (captured.args.includes("--json")) {
    const document = JSON.parse(captured.stdout);
    expect(JSON.stringify(document) + "\n").toBe(captured.stdout);
    const setting = command === "list" ? document.entries.find((row: { key: string }) => row.key === key) : document.setting;
    setting.goal = goal;
    setting.runtime.reason = runtimeReason;
    if (command !== "list") setting.schema = displayedSchema;
    if (command === "show") document.observation = fileObservation;
    return JSON.stringify(document) + "\n";
  }
  let expected = captured.stdout.replace(before.goal, goal);
  if (command !== "list") {
    expected = expected.replace(before.runtime.reason, runtimeReason)
      .replace(`Schema: ${JSON.stringify(before.schema)}\n`, `Schema: ${JSON.stringify(displayedSchema)}\n`);
  }
  if (command === "show") {
    expected = expected.replace('Observation: {"state":"offline"}', "Observation: " + JSON.stringify(fileObservation));
  }
  return expected;
}

it.each(baseline.settings)("preserves starter discovery bytes for $key with only the specified substitutions", ({ key, goal }) => {
  const inputs = baseline.discovery.filter(({ args }) => args[0] === "list" ? args[2] === goal : args[1] === key);
  expect(inputs).toHaveLength(6);
  for (const captured of inputs) {
    expect(runStarterSettings(starter, captured.args), captured.args.join(" ")).toEqual({
      exit: captured.exit, stdout: expectedStarterDiscovery(captured, key), stderr: "",
    });
  }
});

it.each(baseline.checks)("preserves the full starter check report for $args", captured => {
  expect(runStarterSettings(starter, captured.args)).toEqual({ exit: captured.exit, stdout: captured.stdout, stderr: "" });
});

it("exchanges all five MCP tools and recovers from bad frames with the packed binary", () => {
  const { directory, write } = fixture();
  const platform = join(directory, "node_modules/@openlup/platform");
  mkdirSync(platform, { recursive: true });
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  const packed = JSON.parse(execFileSync("npm", ["pack", resolve("packages/platform"), "--ignore-scripts",
    "--offline", "--json", "--pack-destination", directory], { encoding: "utf8" }));
  execFileSync("tar", ["-xzf", join(directory, packed[0].filename), "-C", platform, "--strip-components=1"]);
  for (const dependency of ["zod", "@openlup/core", "@openlup/outbox"]) {
    const target = join(directory, "node_modules", dependency);
    rmSync(target, { recursive: true, force: true });
    symlinkSync(resolve("node_modules", dependency), target, "dir");
  }
  symlinkSync(join(platform, "src/lifecycle/openlup.mjs"), join(directory, "node_modules/.bin/openlup"));
  write(starterSettingsHost, `export function createSettingsBindings() {
    return { file: { configuration: "supplements", validate() {}, entries: {
      "offer.freeShippingFromMinor": { value: 1000, location: { file: "owned/store.config.ts", symbol: "threshold" },
        descriptor: { domain: "shipping", goal: "Free shipping threshold",
          effect: { appliesTo: "New orders.", impact: "customer-promise", frozenOn: [] } } },
    } } };
  }`);
  const { listing, results } = proveSettingsMcp(directory);
  const { tools } = ListToolsResultSchema.parse(listing);
  expect(tools).toHaveLength(5);
  const clientValidator = new AjvJsonSchemaValidator();
  for (const [index, tool] of tools.entries()) {
    const validateInput = clientValidator.getValidator(tool.inputSchema);
    const validateOutput = clientValidator.getValidator(tool.outputSchema!);
    const document = CallToolResultSchema.parse(results[index]).structuredContent!;
    expect(validateInput({}).valid, tool.name).toBe(true);
    expect(validateInput({ databaseUrl: "ignored" }).valid, tool.name).toBe(false);
    expect(validateOutput(document).valid, tool.name).toBe(true);
    expect(validateOutput({ ...document, extra: true }).valid, tool.name).toBe(false);
    expect(validateOutput({ ...document, schemaVersion: undefined }).valid, tool.name).toBe(false);
  }
});
