import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertCompleteStarter, migrateStarterOwned, proveSettingsDiscovery,
  includeSettingsHost, reconcileEditorCustomization, starterEditorPorts, starterSettingsHost, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

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
  const pkg = { dependencies: { "@openlup/core": "0.40.0" }, scripts: { settings: "openlup settings --app ./owned/settings-host.ts" } };
  candidate("package.json", pkg);
  const file = "file: { configuration: 'sample', entries: { 'offer.freeShippingFromMinor': { value: 12000 } } }";
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

it("refuses an extracted starter without the settings script", () => {
  const { directory } = fixture();
  expect(() => proveSettingsDiscovery(directory)).toThrow("extracted starter settings script missing");
});

it("reports a missing explicit settings module on both offline and connected show", () => {
  const { directory } = fixture();
  const show = (...args: string[]) => spawnSync(process.execPath, [
    resolve("packages/platform/src/lifecycle/openlup.mjs"), "settings", "show", "inventory_renewal_protection", "--json", ...args,
  ], { cwd: directory, encoding: "utf8" });
  const offline = show();
  expect(offline.status, offline.stderr).toBe(0);
  expect(JSON.parse(offline.stdout)).toMatchObject({ observation: { state: "offline" } });
  for (const args of [[], ["--database-url", "postgresql://unused.invalid/shop"]]) {
    const missing = show("--app", starterSettingsHost, ...args);
    expect(missing.status, missing.stderr).toBe(74);
    expect(JSON.parse(missing.stdout)).toMatchObject({ refusal: {
      code: "commerce_setting_read_unavailable", path: [args.length ? "key" : "app"], hint: expect.stringContaining("createSettingsBindings"),
    } });
  }
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
