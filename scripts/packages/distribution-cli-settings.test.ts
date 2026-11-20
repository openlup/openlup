import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCompleteStarter, migrateStarterOwned, proveSettingsDiscovery,
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

it.each([false, true])("upgrades the command and creates or preserves its owned host, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const guide = "# App guide\n\nLocal workflow.\n";
  const section = "\n## Change a business setting\n\nRun `npm --silent run settings -- list`.\n";
  write("AGENTS.md", guide);
  candidate("AGENTS.md", guide + section);
  candidate("ownership.json", { managed: ["package.json", "ownership.json"], owned: ["AGENTS.md", starterSettingsHost], generated: [] });
  const pkg = { type: "module", dependencies: { "@openlup/core": "0.40.0", zod: "4.6.6" }, scripts: { settings: "openlup settings --app ./owned/settings-host.ts" } };
  candidate("package.json", pkg);
  const fee = "offer.freeShippingFromMinor";
  const descriptor = ', descriptor: { domain: "shipping", goal: "Set the free shipping threshold.", effect: { appliesTo: "New quotes.", impact: "money", frozenOn: [] } }';
  const file = (metadata = "") => `file: { configuration: 'sample', entries: { '${fee}': {
    value: 12000, location: { file: 'owned/store.config.ts', symbol: '${fee}' }${metadata}
  } } }`;
  candidate(starterSettingsHost, "export function createSettingsBindings() { return { " + file(descriptor) + " }; }");
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
  const localCommand = 'console.log("local starter command");';
  if (customized) {
    const localManifest = { ...JSON.parse(from.files["package.json"]!), scripts: { local: `node -e '${localCommand}'` } };
    write("package.json", localManifest);
    const before = starterUpgradeSnapshot(app, from.version);
    expect(apply(1)).toMatchObject({ applied: [], conflicts: [{ path: "package.json" }] });
    expect(starterUpgradeSnapshot(app, from.version)).toEqual(before);
    expect(existsSync(hostFile)).toBe(false);
    write("owned/local.mjs", localCommand);
    write("package.json", from.files["package.json"]!);

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
  expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).dependencies.zod).toBe("4.6.6");
  if (customized) expect(readFileSync(join(app, "owned/local.mjs"), "utf8")).toBe(localCommand);

  const settings = (command: string[], status = 0, warning = "") => {
    const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"),
      "settings", ...command, "--app", "./" + starterSettingsHost, "--json"], { cwd: app, encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(status);
    expect(result.stderr).toBe(warning);
    return JSON.parse(result.stdout);
  };
  const search = ["list", "--goal", "free shipping"];
  if (customized) {
    expect(settings(["check"], 2)).toMatchObject({ state: "unknown", appValidation: { hint: expect.stringContaining("Add file: { configuration, entries }") } });
    const hostWithFile = (metadata = "") => local.replace("stockSourceKey: 'local'", "stockSourceKey: 'local', " + file(metadata));
    const legacy = hostWithFile();
    write(starterSettingsHost, legacy);
    expect(apply().applied).toEqual([]);
    expect(readFileSync(hostFile, "utf8")).toBe(legacy);
    const warning = `Settings app: value reported without a descriptor for "${fee}". Add a descriptor to each named file.entries entry. See node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md#declare-a-setting-of-your-own.\n`;
    expect(settings(search, 0, warning).entries.some(({ key }: { key: string }) => key === fee)).toBe(false);
    expect(settings(["check"], 0, warning).rows.some(({ key }: { key: string }) => key === fee)).toBe(false);
    const reconciled = hostWithFile(descriptor);
    write(starterSettingsHost, reconciled);
    expect(apply().applied).toEqual([]);
    expect(readFileSync(hostFile, "utf8")).toBe(reconciled);
  }
  expect(settings(search).entries).toEqual(expect.arrayContaining([expect.objectContaining({ key: fee })]));
  expect(settings(["show", fee]).observation).toEqual({ state: "file", configuration: "sample", value: 12000 });
  expect(settings(["check"])).toMatchObject({ state: "checked", configuration: "sample", rows: expect.arrayContaining([
    expect.objectContaining({ key: fee, file: expect.objectContaining({ value: 12000 }) }),
  ]) });
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
  ["candidate", true, 1, false], ["candidate", false, 1, true], ["released", false, 0, false],
] as const)("requires the check smoke in %s mode with reported file values=%s", (mode, reportsFile, calls, rejects) => {
  const { directory: app, write } = fixture();
  write("package-lock.json", {});
  write("package.json", { scripts: { settings: "openlup settings --app ./owned/settings-host.ts" } });
  write(starterSettingsHost, `export function createSettingsBindings() { return ${reportsFile ? `{ file: {
    configuration: "sample", validate() {}, entries: {
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
  expect(settingsCalls).toEqual(calls ? [["settings", "--app", "./owned/settings-host.ts", "check", "--json"]] : []);
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
    "preview", key, "--value", "{}", "--database-url", "postgresql://unused.invalid/shop"], { cwd: directory, encoding: "utf8" });
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain(`Validation: ${validation.state}`);
  expect(text.stdout).toContain(`Horizon difference in days: ${difference?.renewalProtectionDays ?? "unavailable"}`);
  expect(text.stdout).toContain(detail);
  // The package formatter includes the new estimate beside the original current quantity.
  expect(text.stdout).toContain(`SKU-1: ${quantities}`);
  expect(text.stdout).toContain("Existing reservations keep their quantities and expiry times.");
  expect(text.stdout).toContain(result.uncertainty);
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

it("discovers, shows, explains and checks all six starter declarations through its settings script", () => {
  const starter = resolve("examples/neutral-store");
  const manifest = JSON.parse(readFileSync(join(starter, "package.json"), "utf8"));
  const [, ...script] = manifest.scripts.settings.split(" ");
  const invoke = (...args: string[]) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"),
      ...script, ...args, "--json"], { cwd: starter, encoding: "utf8" });
    expect(status, stderr).toBe(0);
    expect(stderr).toBe("");
    return JSON.parse(stdout);
  };
  const check = invoke("check");
  expect(check).toMatchObject({ schemaVersion: 1, state: "checked", appValidation: { state: "passed" } });
  for (const [key, goal, value] of [
    ["offer.freeShippingFromMinor", "free shipping", 1000],
    ["offer.subscriptionDiscountBps", "subscription discount", 500],
    ["purchase.reservationMinutes", "checkout reservation", 30],
    ["subscriptionCreation.editWindowHours", "edit cutoff", 72],
    ["subscriptionOffers.deliveryCycles", "delivery interval", expect.objectContaining({ classic: expect.any(Object), sized: expect.any(Object) })],
    ["subscriptions.lifecycleNoticeRetryBudget", "retry budget", 6],
  ] as const) {
    const show = invoke("show", key);
    const { setting, observation } = show;
    expect(setting).toMatchObject({ key, kind: "code", schema: expect.any(Object) });
    expect(observation).toEqual({ state: "file", configuration: check.configuration, value });
    expect(invoke("list", "--goal", goal).entries).toContainEqual({
      key, goal: setting.goal, kind: setting.kind, runtime: setting.runtime, change: setting.change,
    });
    expect(invoke("explain", key)).toEqual({ ...show, observation: { state: "offline" } });
    expect(check.rows).toContainEqual({
      key, kind: "code", file: { state: "present", value: observation.value, location: setting.change },
      validation: { state: "valid" }, effect: setting.effect.appliesTo, takesEffect: `${setting.change.file} ${setting.change.symbol}`,
    });
  }
});
