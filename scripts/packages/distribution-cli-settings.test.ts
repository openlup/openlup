import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertCompleteStarter, migrateStarterOwned, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

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
  const section = "\n## Change a business setting\n\nRun `node --experimental-strip-types host/settings.ts list`.\n";
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
