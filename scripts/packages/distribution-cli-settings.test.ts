import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertCompleteStarter, migrateStarterOwned, proveSettingsDiscovery, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

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

it.each([false, true])("reconciles settings guidance and the managed CLI upgrade, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const script = "host/settings.ts";
  const base = "# App guide\n";
  const section = "\n## Change a business setting\n\nRun `npm run --silent settings -- list`.\n";
  write("AGENTS.md", customized ? base + "\nLocal workflow.\n" : base);
  candidate("AGENTS.md", base + section);
  const targetOwnership = JSON.parse(readFileSync(join(target, "ownership.json"), "utf8"));
  targetOwnership.managed.push(script);
  candidate("ownership.json", targetOwnership);
  candidate("package.json", { dependencies: { "@openlup/core": "0.40.0" }, scripts: { settings: "node host/settings.ts" } });
  candidate(script, "export {};");
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "1.3.0");
  migrateStarterOwned(app, target, from, to);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe((customized ? base + "\nLocal workflow.\n" : base) + section);
  expect(Object.hasOwn(to.files, "AGENTS.md")).toBe(false);
  expect(() => assertCompleteStarter(app, to)).toThrow("incomplete_application_upgrade");
  write("from.json", from); write("to.json", to);
  const result = spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
    "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).applied.sort()).toEqual([script, "ownership.json", "package.json"]);
  expect(() => assertCompleteStarter(app, to)).not.toThrow();
});

it("refuses an extracted starter without the settings script", () => {
  const { directory } = fixture();
  expect(() => proveSettingsDiscovery(directory)).toThrow("extracted starter settings script missing");
});

it.each([false, true])("upgrades the preview CLI and editor while preserving the reconciled guide through apply and replay, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const settings = "host/settings.ts", editor = "host/editor-ports.ts";
  const base = "# App guide\n\n## Change a business setting\n\nRun the settings CLI.\n";
  const preview = "\nBefore changing renewal stock protection, run a connected, read-only preview.\n\nRun `npm run --silent settings -- preview`.\n";
  const local = "\n## Local operations\n\nUse our adoption checklist.\n";
  const ownership = { managed: ["package.json", "ownership.json", settings, editor], owned: ["AGENTS.md"], generated: [] };
  write("ownership.json", ownership); candidate("ownership.json", ownership);
  for (const [path, from, to] of [
    [settings, "console.log('show');", "console.log('Preview before any change.');"],
    [editor, "const method = 'readPort.read';", "const method = 'readInstalled';"],
  ]) {
    write(path!, from); candidate(path!, to);
  }
  write("AGENTS.md", base + (customized ? local : ""));
  candidate("AGENTS.md", base + preview);
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "1.3.0");
  migrateStarterOwned(app, target, from, to);
  migrateStarterOwned(app, target, from, to);
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe(base + preview + (customized ? local : ""));
  expect(Object.hasOwn(to.files, "AGENTS.md")).toBe(false);
  expect(() => assertCompleteStarter(app, to)).toThrow("incomplete_application_upgrade");
  write("from.json", from); write("to.json", to);
  const apply = () => spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
    "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
  const first = apply();
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).applied).toEqual([editor, settings]);
  const replay = apply();
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout).applied).toEqual([]);
  expect(() => assertCompleteStarter(app, to)).not.toThrow();
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe(base + preview + (customized ? local : ""));
});

it.each([false, true])("replaces the managed editor through apply and replay, customized=%s", customized => {
  const { directory: app, write } = fixture(), { directory: target, write: candidate } = fixture();
  const editor = "host/editor-ports.ts";
  const ownership = { managed: ["package.json", "ownership.json", editor], owned: ["AGENTS.md"], generated: [] };
  const guide = customized ? "# App guide\n\nLocal workflow.\n" : "# App guide\n";
  write("ownership.json", ownership); candidate("ownership.json", ownership);
  write(editor, "const method = 'readPort.read';");
  candidate(editor, "const method = 'readInstalled';");
  write("AGENTS.md", guide);
  const from = starterUpgradeSnapshot(app, "1.2.0"), to = starterUpgradeSnapshot(target, "1.3.0");
  write("from.json", from); write("to.json", to);
  const apply = () => spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
    "--from", join(app, "from.json"), "--to", join(app, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
  const first = apply();
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).applied).toEqual([editor]);
  const replay = apply();
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout).applied).toEqual([]);
  expect(() => assertCompleteStarter(app, to)).not.toThrow();
  expect(readFileSync(join(app, "AGENTS.md"), "utf8")).toBe(guide);
});
