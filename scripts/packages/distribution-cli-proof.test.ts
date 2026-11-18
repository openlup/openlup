import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";
import { qualificationReceipt, qualifyReleasedSet } from "./exact-set-qualification.mjs";
import { assertCompleteStarter, assertUpgradeConflict, previousPublishedSet, migrateStarterOwned, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "upgrade-pair-unit-")); directories.push(directory);
  const write = (path: string, content: unknown) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), typeof content === "string" ? content : JSON.stringify(content)); };
  write("ownership.json", { managed: ["z.ts", "generated.json", "package.json"], owned: ["owned.ts"], generated: ["generated.json"] });
  write("z.ts", "previous bytes"); write("owned.ts", "local bytes");
  write("package.json", { dependencies: { "@openlup/core": "0.40.0" } });
  write("node_modules/@openlup/core/package.json", { version: "0.40.0" });
  return { directory, write };
}

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

it.each([false, true])("upgrades real 1.1.0 owned contracts to the next set, customized=%s", customized => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "starter-next-set-"))); directories.push(directory);
  const source = join(directory, "source"), app = join(directory, "app"), target = join(directory, "target");
  mkdirSync(source);
  const archive = join(directory, "starter.tar");
  execFileSync("git", ["archive", "--output", archive, "openlup-core-v1.1.0", "examples/neutral-store"]);
  execFileSync("tar", ["-xf", archive, "--strip-components=2", "-C", source]);
  // Materialize the same owned/managed source mappings as extraction, without
  // registry or provenance claims. Installed-package proof remains a separate gate.
  const materialize = (input: string, output: string) => {
    const ownership = JSON.parse(readFileSync(join(input, "ownership.json"), "utf8"));
    for (const path of [...ownership.owned, ...ownership.managed]) {
      mkdirSync(dirname(join(output, path)), { recursive: true });
      cpSync(join(input, ownership.sourceMappings?.[path] ?? path), join(output, path));
    }
  };
  materialize(source, app); materialize(resolve("examples/neutral-store"), target);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: app, stdio: "pipe" });
  const read = (path: string) => readFileSync(join(app, path), "utf8");
  const edit = (path: string, before: string, after: string) => {
    const bytes = read(path); expect(bytes).toContain(before);
    writeFileSync(join(app, path), bytes.replaceAll(before, after));
  };
  const customizations = [
    ["AGENTS.md", "Agent guide for this application", "Agent guide for the customized application"],
    ["owned/store.config.ts", "#3d6657", "#663d57"],
    ["owned/renewal.config.ts", "retryBackoffHours: [24, 48, 72]", "retryBackoffHours: [12, 36, 60]"],
    ["owned/fragments.ts", "offer-intro", "adopter-offer-intro"],
  ] as const;
  if (customized) for (const [path, before, after] of customizations) edit(path, before, after);
  const from = starterUpgradeSnapshot(app, "1.1.0"), to = starterUpgradeSnapshot(target, "999999.0.0");
  const managedTarget = { ...to.files };
  expect(existsSync(join(app, "owned/market.config.ts"))).toBe(false);
  migrateStarterOwned(app, target, from, to);
  expect(to.files).toEqual({ ...managedTarget, "owned/market.config.ts": readFileSync(join(target, "owned/market.config.ts"), "utf8") });
  expect(Object.keys(from.files).some(path => path.startsWith("owned/"))).toBe(false);
  // Reconcile customized files with the target contract, carrying their local
  // values forward deliberately, as the packaged migration instructs.
  if (customized) for (const [path, before, after] of customizations) if (path !== "owned/fragments.ts") edit(path, before, after);
  const ownership = JSON.parse(read("ownership.json"));
  const owned = Object.fromEntries(ownership.owned.map((path: string) => [path, read(path)]));
  writeFileSync(join(directory, "from.json"), JSON.stringify(from)); writeFileSync(join(directory, "to.json"), JSON.stringify(to));
  const run = () => spawnSync(process.execPath, [resolve("packages/platform/src/lifecycle/openlup.mjs"), "upgrade", "apply", "--root", app,
    "--from", join(directory, "from.json"), "--to", join(directory, "to.json"), "--schema-version", "0", "--json"], { encoding: "utf8" });
  writeFileSync(join(app, "owned/market.config.ts"), "local market divergence");
  const conflict = run(); expect(conflict.status).toBe(1); assertUpgradeConflict(JSON.parse(conflict.stdout), "owned/market.config.ts");
  rmSync(join(app, "owned/market.config.ts"));
  const result = run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).applied).toContain("owned/market.config.ts");
  expect(JSON.parse(run().stdout).applied).toEqual([]);
  for (const [path, bytes] of Object.entries(owned)) expect(read(path)).toBe(bytes);
  if (customized) for (const [path, , after] of customizations) expect(read(path)).toContain(after);
  symlinkSync(resolve("node_modules"), join(app, "node_modules"), "dir");
  for (const args of [["test"], ["run", "typecheck"], ["run", "build"]]) {
    const check = spawnSync("npm", args, { cwd: app, encoding: "utf8", timeout: 90_000 });
    expect(check.status, check.error?.message ?? check.stdout + check.stderr).toBe(0);
  }
  const startup = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval",
    'const { createApplication } = await import("./host/server.ts"); const server = createApplication(); server.listen(0, "127.0.0.1", () => server.close());'],
  { cwd: app, encoding: "utf8", timeout: 10_000 });
  expect(startup.status, startup.error?.message ?? startup.stdout + startup.stderr).toBe(0);
  // Same-version replay must not overwrite a later owned customization.
  edit("owned/store.config.ts", customized ? "#663d57" : "#3d6657", "#123456");
  migrateStarterOwned(app, target, { ...from, version: to.version }, to);
  expect(read("owned/store.config.ts")).toContain("#123456");
}, 180_000);
