import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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

function fixture(existingDirectory?: string) {
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), "settings-upgrade-"));
  if (existingDirectory === undefined) directories.push(directory);
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
  const upgrade = readFileSync(new URL("../../packages/core/docs/guide/upgrade/v1-3-0.md", import.meta.url), "utf8");
  const notes = /^### Discover and check the starter's owned settings\n[\s\S]*?(?=^#{2,3} )/mu.exec(upgrade)?.[0];
  const diff = notes && /^```diff\n([\s\S]+?)\n```$/mu.exec(notes)?.[1];
  if (!diff) throw new Error("Missing released starter settings host diff");
  const [poolImport, zodImport, oldType, newType, oldEntries, newEntries, oldFilter, newFilter] =
    diff.split("\n").map(line => line.slice(1));
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
  const stripAddedInstalledRows = (stdout: string, expectedKeys: Set<string>) => {
    const document = JSON.parse(stdout);
    expect(document.rows.map((row: { key: string }) => row.key).toSorted())
      .toEqual([...expectedKeys, ...newPackagedCheckKeys].toSorted());
    document.rows = document.rows.filter((row: { key: string }) => expectedKeys.has(row.key));
    return JSON.stringify(document) + "\n";
  };
  const applyUpdatedCapReference = <T extends { key: string; change?: { reference?: string } }>(row: T): T => {
    const updated = updatedCapReferences[row.key];
    return updated && row.change ? { ...row, change: { ...row.change, reference: updated.after } } : row;
  };
  const warning = `Settings app: value reported without a descriptor for ${starterKeys.toSorted().map(key => JSON.stringify(key)).join(", ")}. Add a descriptor to each named file.entries entry. See node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md#declare-a-setting-of-your-own.\n`;
  const verifyLegacy = () => {
    expect(readFileSync(hostFile, "utf8")).toBe(legacy);
    expect(runStarterSettings(app, search.args)).toEqual({
      exit: search.exit, stdout: JSON.stringify({ ...listDocument, entries: entries.filter(remaining).map(applyUpdatedCapReference) }) + "\n", stderr: warning,
    });
    const actualCheck = runStarterSettings(app, defaultCheck.args);
    expect({ ...actualCheck, stdout: stripAddedInstalledRows(actualCheck.stdout, new Set(rows.filter(remaining).map(row => row.key))) }).toEqual({
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
  const reconciledCheck = runStarterSettings(app, defaultCheck.args);
  expect({ ...reconciledCheck, stdout: stripAddedInstalledRows(reconciledCheck.stdout, new Set(rows.map(row => row.key))) }).toEqual({
    exit: defaultCheck.exit,
    stdout: defaultCheck.stdout.replace(subscriptionOffersBeforeEffect, subscriptionOffersEffect),
    stderr: "",
  });
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

it.each([
  ["plaintext by default", "postgresql://sample@unused.invalid/shop", 5432, "", false, {}],
  ["explicit plaintext", "postgresql://sample@unused.invalid/shop?sslmode=disable", 5432, "", false, {}],
  ["verified TLS", "postgresql://sample:fake-secret@unused.invalid:5433/shop?sslmode=verify-full", 5433, "fake-secret",
    { rejectUnauthorized: true, host: "unused.invalid" }, {}],
  ["a target with conflicting PG variables", "postgresql://sample@unused.invalid/shop", 5432, "", false, {
    PGHOST: "elsewhere.invalid", PGPORT: "5999", PGUSER: "fake-user", PGPASSWORD: "fake-password", PGDATABASE: "fake-db",
    PGSSLMODE: "require",
  }],
] as const)("preserves startup parameters and the admitted target for %s", (_, url, port, password, ssl, childEnv) => {
  const { directory, write } = fixture();
  const key = "inventory_renewal_protection";
  const app = "settings-startup-fixture.mjs";
  const pgModule = JSON.stringify(import.meta.resolve("pg"));
  write("preload.mjs", `import pg from ${pgModule};
    pg.Client.prototype.connect = () => { throw new Error("settings fixture must not connect"); };`);
  write(app, `import assert from "node:assert/strict";
    import pg from ${pgModule};
    export function createSettingsBindings({ db }) {
      const admitted = new db.Client(db.options);
      const base = new pg.Client({ connectionString: ${JSON.stringify(url)} });
      assert.deepEqual(admitted.getStartupConf(), base.getStartupConf());
      assert.deepEqual(admitted.getStartupConf(), { user: "sample", database: "shop" });
      const { host, port, user, database, ssl, password } = admitted;
      assert.deepEqual({ host, port, user, database, ssl }, {
        host: "unused.invalid", port: ${port}, user: "sample", database: "shop", ssl: ${JSON.stringify(ssl)},
      });
      assert.equal(typeof password, ${JSON.stringify(password ? "string" : "function")});
      assert.equal(typeof password === "function" ? password() : password, ${JSON.stringify(password)});
      return { readers: { ${key}: () => ({ present: false }) } };
    }`);
  const result = spawnSync(process.execPath, ["--import", join(directory, "preload.mjs"),
    resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "show", key, "--app", app, "--database-url", url, "--json"],
  { cwd: directory, encoding: "utf8", env: childEnv });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe("");
});

it("refuses the native PostgreSQL client before using a connected settings binder", () => {
  const { directory, write } = fixture();
  const key = "inventory_renewal_protection";
  write("preload.mjs", `import pg from ${JSON.stringify(import.meta.resolve("pg"))};
    delete pg.Client.prototype.getStartupConf;`);
  write(starterSettingsHost, `export function createSettingsBindings() { throw new Error("settings fixture must not bind"); }`);
  const cli = resolve("packages/platform/src/lifecycle/openlup.mjs");
  for (const [command, flags, refusal] of [
    ["show", [], "commerce_setting_read_unavailable"],
    ["preview", ["--value", "{}"], "commerce_setting_preview_unexpected"],
  ] as const) {
    const result = spawnSync(process.execPath, ["--import", join(directory, "preload.mjs"), cli, "settings", command, key, ...flags, "--app", starterSettingsHost,
      "--database-url", "postgresql://sample:fake@unused.invalid/shop?sslmode=verify-full", "--json"],
    { cwd: directory, encoding: "utf8", env: {} });
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

it.each([
  ["subscription_minimum_base_units", [{ value_text: "6" }], 0, { state: "override", value: 6, revision: null }],
  ["subscription_minimum_base_units", [], 0, { state: "absent", value: null }],
  ["subscription_minimum_base_units", [{ value_text: "0" }], 74, "commerce_setting_read_unavailable"],
  ["subscription_minimum_base_units", [{ value_text: "abc" }], 74, "commerce_setting_read_unavailable"],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":2,"graduationCycle":3}' }], 0,
    { state: "override", value: { fixedThroughCycle: 2, graduationCycle: 3 }, revision: null }],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":2147483646,"graduationCycle":2147483647}' }], 0,
    { state: "override", value: { fixedThroughCycle: 2147483646, graduationCycle: 2147483647 }, revision: null }],
  ["subscription_sized_intro_phase", [], 0, { state: "absent", value: null }],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":0,"graduationCycle":3}' }], 74, "commerce_setting_read_unavailable"],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":2,"graduationCycle":2147483648}' }], 74, "commerce_setting_read_unavailable"],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":2147483648,"graduationCycle":2147483649}' }], 74, "commerce_setting_read_unavailable"],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":3,"graduationCycle":3}' }], 74, "commerce_setting_read_unavailable"],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":3,"graduationCycle":2}' }], 74, "commerce_setting_read_unavailable"],
  ["subscription_sized_intro_phase", [{ value_text: '{"fixedThroughCycle":2,"graduationCycle":3,"extra":1}' }], 74, "commerce_setting_read_unavailable"],
  ["shipping_flat_minor", [{ value_minor: 500 }], 0, { state: "override", value: 500, revision: null }],
  ["shipping_flat_minor", [], 0, { state: "fallback", value: 0 }],
  ["shipping_flat_minor", [{ value_minor: null }], 74, "commerce_setting_read_unavailable"],
  ["shipping_flat_minor", [{ value_minor: -1 }], 74, "commerce_setting_read_unavailable"],
  ["pricing.subscriptionPricePolicy", [
    {
      id: "11111111-1111-4111-8111-111111111111",
      price_list_id: "22222222-2222-4222-8222-222222222222",
      region_code: "US",
      currency: "USD",
      channel: "web",
      revision_no: 1,
      discount_bps: 1000,
      rounding_quantum_minor: 5,
      rounding_rule: "FLOOR_TO_QUANTUM",
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_to: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      price_list_id: "22222222-2222-4222-8222-222222222222",
      region_code: "US",
      currency: "USD",
      channel: "web",
      revision_no: 2,
      discount_bps: 1500,
      rounding_quantum_minor: 10,
      rounding_rule: "FLOOR_TO_QUANTUM",
      effective_from: "2026-06-01T00:00:00.000Z",
      effective_to: null,
    },
  ], 0, {
    state: "override",
    value: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        price_list_id: "22222222-2222-4222-8222-222222222222",
        region_code: "US",
        currency: "USD",
        channel: "web",
        revision_no: 1,
        discount_bps: 1000,
        rounding_quantum_minor: 5,
        rounding_rule: "FLOOR_TO_QUANTUM",
        effective_from: "2026-01-01T00:00:00.000Z",
        effective_to: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        price_list_id: "22222222-2222-4222-8222-222222222222",
        region_code: "US",
        currency: "USD",
        channel: "web",
        revision_no: 2,
        discount_bps: 1500,
        rounding_quantum_minor: 10,
        rounding_rule: "FLOOR_TO_QUANTUM",
        effective_from: "2026-06-01T00:00:00.000Z",
        effective_to: null,
      },
    ],
    revision: null,
  }],
  ["pricing.subscriptionPricePolicy", [], 0, { state: "absent", value: null }],
  ["pricing.subscriptionPricePolicy", [{
    id: "11111111-1111-4111-8111-111111111111",
    price_list_id: "22222222-2222-4222-8222-222222222222",
    region_code: "US",
    currency: "USD",
    channel: "web",
    revision_no: 1,
    discount_bps: -1,
    rounding_quantum_minor: 5,
    rounding_rule: "FLOOR_TO_QUANTUM",
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
  }], 74, "commerce_setting_read_unavailable"],
  ["communications.nativeDeliveryControls", [
    { control_key: "lifecycle_notice", enabled: true, revision: 2 },
    { control_key: "transactional_receipt", enabled: false, revision: 1 },
  ], 0, {
    state: "override",
    value: [
      { control_key: "lifecycle_notice", enabled: true, revision: 2 },
      { control_key: "transactional_receipt", enabled: false, revision: 1 },
    ],
    revision: null,
  }],
  ["communications.nativeDeliveryControls", [], 0, { state: "absent", value: null }],
  ["communications.nativeDeliveryControls", [{ control_key: "lifecycle_notice", enabled: "yes", revision: 1 }],
    74, "commerce_setting_read_unavailable"],
] as const)("reads built-in installed setting %s with rows %j", (settingKey, rows, expectedExit, expected) => {
  const { directory, write } = fixture();
  const pgModule = JSON.stringify(import.meta.resolve("pg"));
  write("preload.mjs", `import pg from ${pgModule};
    pg.Pool.prototype.query = async () => ({ rows: ${JSON.stringify(rows)} });
    pg.Pool.prototype.end = async () => {};`);
  const result = spawnSync(process.execPath, ["--import", join(directory, "preload.mjs"),
    resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "show", settingKey,
    "--database-url", "postgresql://sample@unused.invalid/shop", "--json"], { cwd: directory, encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(expectedExit);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  if (typeof expected === "string") expect(parsed.refusal.code).toBe(expected);
  else expect(parsed.observation).toMatchObject(expected);
});

it("normalizes Date timestamps for pricing.subscriptionPricePolicy and refuses on permission errors", () => {
  const { directory, write } = fixture();
  const pgModule = JSON.stringify(import.meta.resolve("pg"));
  write("preload-dates.mjs", `import pg from ${pgModule};
    pg.Pool.prototype.query = async (sql) => {
      if (!sql.includes("FROM public.subscription_price_policy_revisions")
        || !sql.includes("ORDER BY price_list_id, region_code, currency, channel, revision_no")) {
        throw new Error("unexpected query: " + sql);
      }
      return {
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          price_list_id: "22222222-2222-4222-8222-222222222222",
          region_code: "US",
          currency: "USD",
          channel: "web",
          revision_no: 1,
          discount_bps: 500,
          rounding_quantum_minor: 1,
          rounding_rule: "FLOOR_TO_QUANTUM",
          effective_from: new Date("2026-01-01T00:00:00.000Z"),
          effective_to: null,
        }],
      };
    };
    pg.Pool.prototype.end = async () => {};`);
  const datesRun = spawnSync(process.execPath, ["--import", join(directory, "preload-dates.mjs"),
    resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "show", "pricing.subscriptionPricePolicy",
    "--database-url", "postgresql://sample@unused.invalid/shop", "--json"], { cwd: directory, encoding: "utf8" });
  expect(datesRun.status, datesRun.stderr || datesRun.stdout).toBe(0);
  expect(JSON.parse(datesRun.stdout).observation).toEqual({
    state: "override",
    value: [{
      id: "11111111-1111-4111-8111-111111111111",
      price_list_id: "22222222-2222-4222-8222-222222222222",
      region_code: "US",
      currency: "USD",
      channel: "web",
      revision_no: 1,
      discount_bps: 500,
      rounding_quantum_minor: 1,
      rounding_rule: "FLOOR_TO_QUANTUM",
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_to: null,
    }],
    revision: null,
  });

  write("preload-denied.mjs", `import pg from ${pgModule};
    pg.Pool.prototype.query = async () => {
      throw Object.assign(new Error("permission denied for table communication_delivery_controls"), { code: "42501" });
    };
    pg.Pool.prototype.end = async () => {};`);
  for (const settingKey of ["pricing.subscriptionPricePolicy", "communications.nativeDeliveryControls"]) {
    const denied = spawnSync(process.execPath, ["--import", join(directory, "preload-denied.mjs"),
      resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "show", settingKey,
      "--database-url", "postgresql://sample@unused.invalid/shop", "--json"], { cwd: directory, encoding: "utf8" });
    expect(denied.status, denied.stderr || denied.stdout).toBe(74);
    expect(denied.stderr).toBe("");
    expect(denied.stdout).not.toContain("permission denied for table");
    expect(JSON.parse(denied.stdout).refusal.code).toBe("commerce_setting_read_unavailable");
  }
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
    const expectedStdout = args[0] === "list"
      ? JSON.stringify({ ...JSON.parse(base.stdout), appBindingWarning: cause }) + "\n"
      : base.stdout;
    expect(withApp).toEqual({ ...base, stdout: expectedStdout, stderr: args[0] === "list" ? `Settings app: ${cause}\n` : "" });
  }
});

const updatedCapReferences: Record<string, { before: string; after: string }> = {
  "promotions.freeShippingBasis": {
    before: "docs/guide/how-to/operate/settings-catalogue.md#promotionsfreeshippingbasis",
    after: "docs/guide/how-to/build/customize-the-starter.md#compose-shipping-quotes",
  },
  "subscriptions.introductoryPhases": {
    before: "docs/guide/how-to/operate/settings-catalogue.md#subscriptionsintroductoryphases",
    after: "docs/guide/how-to/build/customize-the-starter.md#configure-subscription-offers",
  },
};

const subscriptionOffersGoal = "Choose allowed subscription delivery intervals, default cadence, unit and line limits, and per-SKU quantity rules for classic and sized offers.";
const subscriptionOffersBeforeEffect = "A fresh subscription checkout checks the deployed classic offer. Starter terms admission checks cadence against the offer for the edit's mode.";
const subscriptionOffersEffect = "Fresh subscription checkouts check the deployed classic offer (cadence, unit/line limits and per-SKU rules). Starter terms admission checks edits against the classic or sized offer for the edit's mode.";
const subscriptionOffersSchema = (() => {
  const positiveInt32 = z.number().int().min(1).max(2147483647);
  const numbersDomain = z.union([
    z.strictObject({ kind: z.literal("set"), values: z.array(positiveInt32).min(1) }),
    z.strictObject({ kind: z.literal("range"), min: positiveInt32, max: positiveInt32, step: positiveInt32 }),
  ]);
  const skuOfferRule = z.strictObject({ days: numbersDomain, quantities: numbersDomain });
  const subscriptionOfferSchema = z.strictObject({
    days: numbersDomain,
    checkoutDays: numbersDomain.optional(),
    preferredDays: numbersDomain.optional(),
    checkoutMinimumBaseUnits: positiveInt32.optional(),
    defaultDays: positiveInt32,
    minimumBaseUnits: positiveInt32,
    maximumUnits: positiveInt32,
    maximumBaseLines: positiveInt32,
    maximumAddonLines: positiveInt32,
    bySku: z.record(z.string().min(1), z.array(skuOfferRule).min(1)),
  });
  return z.strictObject({
    classic: subscriptionOfferSchema,
    sized: subscriptionOfferSchema,
  }).describe(
    "assertSubscriptionOffer checks days as a nonempty set of distinct integers from 1 through 3660 or a range within those bounds with an integer step from 1 through 2147483647. The default must be in days and in checkoutDays when supplied, maximumUnits must be at least minimumBaseUnits, line counts and SKU quantities stay within checkout bounds (50 lines, 99 units per line), and SKU cadences do not repeat across rules. assertQuoteConfiguration requires the classic offer to include the graduation cadence.",
  );
})();

function expectedStarterDiscovery(captured: CapturedSettings, key: string) {
  const [command] = captured.args;
  const { setting: before } = JSON.parse(discoveryCase("show", key, "--json").stdout);
  const check = JSON.parse(defaultCheck.stdout);
  const value = check.rows.find((row: { key: string }) => row.key === key).file.value;
  const runtimeReason = "Edit the application configuration and deploy.";
  const defaultReason = "The application config supplies the value.";
  const editWindowGoal = "Set how many hours before a renewal customers can edit a newly created subscription (edit cutoff, change deadline, activation window).";
  const goal = key === "subscriptionCreation.editWindowHours"
    ? editWindowGoal
    : key === "subscriptionOffers.deliveryCycles"
      ? subscriptionOffersGoal
      : before.goal;
  const appliesTo = key === "subscriptionOffers.deliveryCycles" ? subscriptionOffersEffect : before.effect.appliesTo;
  const displayedSchema = z.toJSONSchema(
    key === "subscriptionOffers.deliveryCycles" ? subscriptionOffersSchema : z.fromJSONSchema(before.schema),
    { target: "draft-07", io: "input", reused: "inline" },
  );
  const fileObservation = { state: "file", configuration: check.configuration, value };
  if (captured.args.includes("--json")) {
    const document = JSON.parse(captured.stdout);
    expect(JSON.stringify(document) + "\n").toBe(captured.stdout);
    const setting = command === "list" ? document.entries.find((row: { key: string }) => row.key === key) : document.setting;
    setting.goal = goal;
    setting.runtime.reason = runtimeReason;
    if (command === "list") {
      for (const entry of document.entries as Array<{ key: string; change?: { reference?: string } }>) {
        const updated = updatedCapReferences[entry.key];
        if (updated && entry.change) entry.change.reference = updated.after;
      }
    }
    if (command !== "list") {
      setting.effect.appliesTo = appliesTo;
      setting.schema = displayedSchema;
      setting.fallback = null;
      setting.defaultBasis = { kind: "neutral" };
      setting.whyThisDefault = defaultReason;
    }
    if (command === "show") document.observation = fileObservation;
    return JSON.stringify(document) + "\n";
  }
  let expected = captured.stdout.replace(before.goal, goal);
  if (command === "list") {
    for (const { before: oldRef, after: newRef } of Object.values(updatedCapReferences)) {
      expected = expected.replace(oldRef, newRef);
    }
  }
  if (command !== "list") {
    expected = expected.replace(before.runtime.reason, runtimeReason)
      .replace(before.effect.appliesTo, appliesTo)
      .replace(`Default: ${JSON.stringify(before.fallback)}\n`, "Default: none (see behavior below)\n")
      .replace(/^Basis: .*$/mu, "Basis: neutral")
      .replace(before.whyThisDefault, defaultReason)
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

const newStarterCheckKeys = [
  "checkout.initialPaymentWindow", "checkout.recoveryLinkPolicy", "checkout.waveWindows",
  "legal.returnsDays", "market", "market.localePolicy", "offer.maxUnits", "offer.minUnits", "offer.shippingMinor",
  "offer.subscriptionRoundingQuantumMinor", "orderControls.holdReasons", "pricing.minimumProductPayableMinor",
  "purchase.attemptLimits", "purchase.contact", "purchase.tax.vatRateBps",
  "quote.acquisition.graduationCadenceDays", "renewal.notices.localePolicy", "renewal.recovery",
  "renewal.retryBackoffHours", "renewal.subscriptionCare.actions", "renewal.subscriptionCare.notices",
  "renewal.subscriptionCare.pausePresets", "renewal.subscriptionCare.recovered.windowSeconds",
  "renewal.subscriptionCare.retention", "renewal.subscriptionCare.terms", "returns.reasons",
  "subscriptionEditing.sizedPreferences",
];
const newPackagedInstalledKeys = [
  "communications.nativeDeliveryControls", "pricing.subscriptionPricePolicy",
  "shipping_flat_minor", "subscription_minimum_base_units", "subscription_sized_intro_phase",
];
const newPackagedCodeKeys = [
  "catalog.bundleAvailabilityPolicy", "checkout.resumeWindowMinutes",
  "communications.terminalPayloadRetentionDays", "inventory.offerLowStockThreshold",
  "market.fiscalProfile", "market.settlementProfile", "tax.adapter", "tax.localRateTable",
];
const newPackagedCheckKeys = [...newPackagedInstalledKeys, ...newPackagedCodeKeys];
const newCheckKeys = [...newStarterCheckKeys, ...newPackagedCheckKeys];

it.each(baseline.checks)("reports exactly the baseline and new starter check rows for $args", captured => {
  const { stdout, ...actual } = runStarterSettings(starter, captured.args);
  let existing: string;
  if (captured.args.includes("--json")) {
    const expected = JSON.parse(captured.stdout);
    const document = JSON.parse(stdout);
    const keys = new Set(expected.rows.map((row: { key: string }) => row.key));
    expect(document.rows.map((row: { key: string }) => row.key).toSorted()).toEqual([...keys, ...newCheckKeys].toSorted());
    expect(JSON.stringify(document) + "\n").toBe(stdout);
    document.rows = document.rows.filter((row: { key: string }) => keys.has(row.key));
    existing = JSON.stringify(document) + "\n";
  } else {
    const blocks = (output: string) => output.split(/(?=^\S)/mu);
    const key = (block: string) => /^(\S+): file /u.exec(block)?.[1];
    const rowKeys = (parts: string[]) => parts.map(key).filter(value => value !== undefined);
    const keys = new Set(rowKeys(blocks(captured.stdout)));
    const actualBlocks = blocks(stdout);
    expect(rowKeys(actualBlocks).toSorted()).toEqual([...keys, ...newCheckKeys].toSorted());
    existing = actualBlocks.map(block => {
      const rowKey = key(block);
      // New code rows end at Effect, while new installed rows end at Store. Keep any text that follows them.
      return rowKey === undefined || keys.has(rowKey) ? block : block.replace(/^[\s\S]*?^ {2}Effect: .*\n(?: {2}Store: .*\n)?/mu, "");
    }).join("");
  }
  const expectedStdout = captured.stdout.replace(subscriptionOffersBeforeEffect, subscriptionOffersEffect);
  expect({ ...actual, stdout: existing }).toEqual({ exit: captured.exit, stdout: expectedStdout, stderr: "" });
});

let packedSettingsDirectory: string;
// CI combined test: 9.36 s (run 44975261168). Local broker split: pack 3.27 s,
// extraction 1.04 s, other setup ~0 s, MCP exchange 2.26 s, cleanup 0.53 s (total 7.10 s).
// CI/local = 9.361 / 7.10 ≈ 1.318. Bounds round up from 4x each CI-scaled share.
beforeAll(() => {
  packedSettingsDirectory = mkdtempSync(join(tmpdir(), "settings-mcp-packed-"));
  const { directory, write } = fixture(packedSettingsDirectory);
  const platform = join(directory, "node_modules/@openlup/platform");
  mkdirSync(platform, { recursive: true });
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  // CI-scaled pack share: ~4.31 s.
  const packed = JSON.parse(execFileSync("npm", ["pack", resolve("packages/platform"), "--ignore-scripts",
    "--offline", "--json", "--pack-destination", directory], { encoding: "utf8", timeout: 17_250 }));
  // CI-scaled extraction share: ~1.37 s.
  execFileSync("tar", ["-xzf", join(directory, packed[0].filename), "-C", platform, "--strip-components=1"], { timeout: 5_500 });
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
}, 23_000); // Includes both subprocess bounds and fixture setup.

afterAll(async () => {
  if (packedSettingsDirectory) await rm(packedSettingsDirectory, { recursive: true, force: true });
}, 2_800); // CI-scaled cleanup share: ~0.70 s.

it("exchanges all five MCP tools and recovers from bad frames with the packed binary", () => {
  // Leave 1 s to report a stalled child and clean up before Vitest's bound.
  const { listing, results } = proveSettingsMcp(packedSettingsDirectory, undefined, { timeoutMs: 11_000 });
  const { tools } = ListToolsResultSchema.parse(listing);
  expect(tools).toHaveLength(5);
  const clientValidator = new AjvJsonSchemaValidator();
  for (const [index, tool] of tools.entries()) {
    const validateInput = clientValidator.getValidator(tool.inputSchema);
    const validateOutput = clientValidator.getValidator(tool.outputSchema!);
    const document = CallToolResultSchema.parse(results[index]).structuredContent!;
    expect(validateInput({}).valid, tool.name).toBe(["settings_list", "settings_check"].includes(tool.name));
    expect(validateInput({ databaseUrl: "ignored" }).valid, tool.name).toBe(false);
    expect(validateOutput(document).valid, tool.name).toBe(true);
    expect(validateOutput({ ...document, extra: true }).valid, tool.name).toBe(false);
    expect(validateOutput({ ...document, schemaVersion: undefined }).valid, tool.name).toBe(false);
  }
}, 12_000); // CI-scaled MCP exchange share: ~2.98 s.

it("observes live app edits and load failures in a single MCP session without restart", async () => {
  const { directory, write } = fixture();
  const key = "offer.freeShippingFromMinor";
  const zodSpecifier = JSON.stringify(import.meta.resolve("zod"));
  const writeApp = (value: number) => write(starterSettingsHost, `import { z } from ${zodSpecifier};
export function createSettingsBindings() {
  console.log("app console log");
  process.stdout.write("app stdout log\\n");
  return { file: { configuration: "supplements", validate() {}, entries: {
    ${JSON.stringify(key)}: { value: ${value}, location: { file: "owned/store.config.ts", symbol: "threshold" },
      descriptor: { domain: "shipping", goal: "Free shipping threshold", schema: z.number().int().min(0),
        effect: { appliesTo: "New orders.", impact: "customer-promise", frozenOn: [] } } },
  } } };
}
`);
  writeApp(1000);

  const child = spawn(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"),
    "settings", "mcp", "--app", "./" + starterSettingsHost], { cwd: directory, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });

  let buffer = "";
  const lines: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (waiting) {
        const resolveLine = waiting;
        waiting = undefined;
        resolveLine(line);
      } else {
        lines.push(line);
      }
    }
  });
  const nextReply = () => new Promise<Record<string, unknown>>((resolveReply, rejectReply) => {
    if (lines.length) { resolveReply(JSON.parse(lines.shift()!)); return; }
    const timer = setTimeout(() => rejectReply(new Error(`Timed out waiting for MCP reply. stderr:\n${stderr}`)), 15_000);
    waiting = line => { clearTimeout(timer); resolveReply(JSON.parse(line)); };
  });
  const send = (payload: object) => { child.stdin.write(JSON.stringify(payload) + "\n"); };
  const callTool = async (id: number, name: string, args: object = {}) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: `settings_${name}`, arguments: args } });
    const reply = await nextReply();
    expect(reply.id).toBe(id);
    return CallToolResultSchema.parse(reply.result);
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-edit-test", version: "1" } } });
    expect((await nextReply()).id).toBe(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const checkValid = await callTool(2, "check");
    expect(checkValid.isError).toBe(false);
    expect(checkValid.structuredContent).toMatchObject({
      state: "checked",
      rows: expect.arrayContaining([expect.objectContaining({
        key, file: expect.objectContaining({ state: "present", value: 1000 }), validation: { state: "valid" },
      })]),
    });
    const showInitial = await callTool(3, "show", { key });
    expect(showInitial.isError).toBe(false);
    expect(showInitial.structuredContent).toMatchObject({ observation: { state: "file", value: 1000 } });

    writeApp(-5);
    const checkInvalid = await callTool(4, "check");
    expect(checkInvalid.isError).toBe(true);
    expect(checkInvalid.structuredContent).toMatchObject({
      state: "invalid",
      rows: expect.arrayContaining([expect.objectContaining({
        key, file: expect.objectContaining({ state: "present", value: -5 }),
        validation: { state: "invalid", paths: [[]], messages: [expect.any(String)] },
      })]),
    });
    const showUpdated = await callTool(5, "show", { key });
    expect(showUpdated.isError).toBe(false);
    expect(showUpdated.structuredContent).toMatchObject({ observation: { state: "file", value: -5 } });

    writeApp(2500);
    const checkRecovered = await callTool(6, "check");
    expect(checkRecovered.isError).toBe(false);
    expect(checkRecovered.structuredContent).toMatchObject({
      state: "checked",
      rows: expect.arrayContaining([expect.objectContaining({
        key, file: expect.objectContaining({ state: "present", value: 2500 }), validation: { state: "valid" },
      })]),
    });

    write(starterSettingsHost, 'export function createSettingsBindings() { throw new Error("broken edit after start"); }\n');
    const listBroken = await callTool(7, "list");
    expect(listBroken.isError).toBe(false);
    expect(listBroken.structuredContent).toMatchObject({
      schemaVersion: 1,
      appBindingWarning: "broken edit after start",
      entries: expect.arrayContaining([expect.objectContaining({ key: "inventory_renewal_protection" })]),
    });

    const closed = new Promise<number | null>(resolveClose => child.once("close", resolveClose));
    child.stdin.end();
    expect(await closed).toBe(0);
    expect(stderr).toContain("app console log\napp stdout log\n");
    expect(stderr).toContain("Settings app: broken edit after start\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}, 30_000);

it("returns exit 0 for openlup settings mcp --help", () => {
  const cli = resolve("packages/platform/src/lifecycle/openlup.mjs");
  const text = spawnSync(process.execPath, [cli, "settings", "mcp", "--help"], { encoding: "utf8" });
  expect(text.status, text.stderr).toBe(0);
  expect(text.stderr).toBe("");
  expect(text.stdout.split("\n")[0]).toContain("openlup settings (experimental) mcp");

  const json = spawnSync(process.execPath, [cli, "settings", "mcp", "--help", "--json"], { encoding: "utf8" });
  expect(json.status, json.stderr).toBe(0);
  expect(json.stderr).toBe("");
  expect(JSON.parse(json.stdout)).toEqual({ schemaVersion: 1, help: text.stdout.trimEnd() });
});
