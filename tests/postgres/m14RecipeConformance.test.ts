import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialReceipt, loadCredentials, main } from "./runM14RecipeConformance.mjs";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recipe-input-")); directories.push(root);
  const secret = "private-credential-do-not-print";
  const config = { schemaVersion: 1, target: "self-host", region: "local", disposable: true,
    previousApplicationPath: "/external/previous/dist/payments/index.js",
    installations: Object.fromEntries(["installer-managed", "operator-provisioned", "schema"].map((mode, index) => [mode, {
      disposable: true, systemIdentifier: String(7000000000000000000n + BigInt(index)),
      connectionString: `postgresql://postgres:${secret}@127.0.0.1:1/postgres`,
      ca: "-----BEGIN CERTIFICATE-----\nunusable-private-input\n-----END CERTIFICATE-----",
    }])) };
  const path = join(root, "credentials.json");
  const save = () => writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); save();
  return { root, path, secret, config, save };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("refuses missing and undeclared selections before creating a receipt", async () => {
  const f = fixture();
  await expect(main([])).rejects.toThrow("usage:");
  expect(() => loadCredentials(f.path, "unknown")).toThrow("target_input_required");
  delete (f.config as { disposable?: boolean }).disposable; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("explicit_disposable_target_required");
  expect(() => loadCredentials(f.path, "neon")).toThrow("explicit_disposable_target_required");
});

it("requires private mode, an external ordinary file, and three declared distinct clusters", () => {
  const f = fixture();
  chmodSync(f.path, 0o644);
  expect(() => loadCredentials(f.path, "self-host")).toThrow("credential_file_requires_owner_mode_600");
  chmodSync(f.path, 0o600);
  const link = join(f.root, "link.json"); symlinkSync(f.path, link);
  expect(() => loadCredentials(link, "self-host")).toThrow("credential_symlink_refused");
  const inside = resolve(".context/scratch/m14-recipe-input-test"); mkdirSync(inside, { recursive: true });
  const internal = join(inside, `credentials-${process.pid}.json`);
  try {
    writeFileSync(internal, JSON.stringify(f.config), { mode: 0o600 });
    expect(() => loadCredentials(internal, "self-host")).toThrow("credential_file_must_be_external");
  } finally { rmSync(internal); }
  f.config.installations.schema.systemIdentifier = f.config.installations["installer-managed"].systemIdentifier; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("separate_clusters_required");
});

it("keeps credentials, paths and raw worker errors out of process output and failed receipts", () => {
  const f = fixture();
  const receipt = join(f.root, "receipt.json");
  const result = spawnSync(process.execPath, ["tests/postgres/runM14RecipeConformance.mjs", "--target", "self-host",
    "--credentials", f.path, "--receipt", receipt], { encoding: "utf8", timeout: 30000 });
  expect(result.status).toBe(1);
  const bytes = readFileSync(receipt, "utf8");
  const allOutput = result.stdout + result.stderr + bytes;
  for (const privateValue of [f.secret, f.path, f.config.installations.schema.connectionString, "unusable-private-input"])
    expect(allOutput).not.toContain(privateValue);
  expect(JSON.parse(bytes)).toMatchObject({ status: "FAIL", install: { status: "PENDING" }, transfer: { status: "PENDING", owner: "8D/10P" } });
  expect(() => loadCredentials(f.path, "self-host")).not.toThrow();
  // Receipts never overwrite an earlier result or a caller-selected link.
  const again = spawnSync(process.execPath, ["tests/postgres/runM14RecipeConformance.mjs", "--target", "self-host",
    "--credentials", f.path, "--receipt", receipt], { encoding: "utf8", timeout: 30000 });
  expect(again.status).toBe(1);
  expect(readFileSync(receipt, "utf8")).toBe(bytes);
}, 35000);

it("starts every unfinished appendix section explicitly pending with its owner", () => {
  expect(initialReceipt("self-host")).toMatchObject({ status: "INCOMPLETE", schema: { status: "PENDING", owner: "10A" },
    transfer: { status: "PENDING", owner: "8D/10P" }, recovery: { status: "PENDING", owner: "9A/10P" },
    oidc: { status: "PENDING", owner: "10I" }, s3: { status: "PENDING", owner: "10O" },
    nodeHosts: { status: "PENDING", owner: "10H" }, effortCleanup: { status: "PENDING", owner: "10H/10S" } });
});
