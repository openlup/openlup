import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";
import { qualificationReceipt, qualifyReleasedSet } from "./exact-set-qualification.mjs";
import { assertCompleteStarter, assertUpgradeConflict, previousPublishedSet, stageStarterSupplementPack, starterUpgradeSnapshot } from "./distribution-cli-proof.ts";

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

it("supplements_pack_artifact_matrix RP1-D-010b stages only first-use owned files and preserves a later edit", async () => {
  const app = fixture(), candidate = fixture();
  const paths = [
    "owned/catalog-packs/supplements/pack.ts", "owned/catalog-packs/supplements/catalogue.ts",
    "owned/catalog-packs/supplements/fixtures.ts", "owned/catalog-packs/supplements/policy.ts",
    "owned/market-packs/market-fictional/tax-table.ts",
  ];
  const registry = "owned/catalogue.ts";
  for (const { directory, write } of [app, candidate]) {
    const ownership = JSON.parse(readFileSync(join(directory, "ownership.json"), "utf8"));
    ownership.owned.push(registry, ...(directory === candidate.directory ? paths : []));
    write("ownership.json", ownership);
    write(registry, directory === candidate.directory ? "candidate registry" : "pristine old registry");
  }
  for (const path of paths) candidate.write(path, path);
  const from = starterUpgradeSnapshot(app.directory, "1.2.0"), to = starterUpgradeSnapshot(candidate.directory, "1.3.0");
  stageStarterSupplementPack(app.directory, candidate.directory, from, to);
  expect(paths.map(path => from.files[path])).toEqual(paths.map(() => undefined));
  expect(paths.map(path => to.files[path])).toEqual(paths);
  expect(readFileSync(join(app.directory, registry), "utf8")).toBe("candidate registry");

  // A later transition already owns these filenames and keeps their edited bytes.
  const ownership = readFileSync(join(candidate.directory, "ownership.json"), "utf8");
  app.write("ownership.json", ownership);
  app.write(registry, "custom registry");
  app.write(paths[0]!, "edited pack");
  const next = starterUpgradeSnapshot(candidate.directory, "1.4.0");
  stageStarterSupplementPack(app.directory, candidate.directory, from, next);
  expect(paths.every(path => !Object.hasOwn(next.files, path))).toBe(true);
  expect(readFileSync(join(app.directory, paths[0]!), "utf8")).toBe("edited pack");
  expect(readFileSync(join(app.directory, registry), "utf8")).toBe("custom registry");
});
