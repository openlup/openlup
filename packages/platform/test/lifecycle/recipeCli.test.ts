import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../../..");
const OPENLUP_BIN = resolve(REPO_ROOT, "packages/platform/src/lifecycle/openlup.mjs");
const CATALOG_DIR = resolve(REPO_ROOT, "recipes");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runCli(
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [OPENLUP_BIN, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("openlup recipe CLI (Agent-DX list|show|add|verify)", () => {
  it("lists and filters all 15 catalog recipes in both JSON (formatVersion=1) and human formats", async () => {
    const listAll = await runCli(["recipe", "list", "--json"]);
    expect(listAll.exitCode).toBe(0);
    const body = JSON.parse(listAll.stdout) as {
      formatVersion: number;
      command: string;
      state: string;
      totalCount: number;
      filteredCount: number;
      domainCounts: Record<string, number>;
      recipes: readonly { id: string; domain: string; status: string }[];
    };
    expect(body.formatVersion).toBe(1);
    expect(body.command).toBe("recipe list");
    expect(body.state).toBe("complete");
    expect(body.totalCount).toBe(15);
    expect(body.filteredCount).toBe(15);
    expect(Object.keys(body.domainCounts)).toHaveLength(8);

    const filtered = await runCli(["recipe", "list", "--domain", "shipping", "--status", "exemplar", "--json"]);
    expect(filtered.exitCode).toBe(0);
    const filteredBody = JSON.parse(filtered.stdout) as { recipes: readonly { id: string }[] };
    expect(filteredBody.recipes.map((r) => r.id)).toEqual(["shipping/easypost"]);

    const human = await runCli(["recipe", "list", "--domain", "channels"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("channels/shopify");
    expect(human.stdout).toContain("openlup recipe add <id> --verify");
  });

  it("shows recipe manifests and fails cleanly on missing or invalid recipe ids", async () => {
    const shown = await runCli(["recipe", "show", "payments/adyen", "--json"]);
    expect(shown.exitCode).toBe(0);
    const body = JSON.parse(shown.stdout) as {
      formatVersion: number;
      command: string;
      installCommand: string;
      manifest: { id: string; providerKind: string; browserSurface: { kind: string } };
    };
    expect(body.formatVersion).toBe(1);
    expect(body.command).toBe("recipe show");
    expect(body.manifest.id).toBe("payments/adyen");
    expect(body.manifest.providerKind).toBe("adyen");
    expect(body.manifest.browserSurface.kind).toBe("adapter-component");
    expect(body.installCommand).toContain("openlup recipe add payments/adyen --verify");

    const missing = await runCli(["recipe", "show", "payments/nonexistent", "--json"]);
    expect(missing.exitCode).toBe(1);
    const missingBody = JSON.parse(missing.stdout) as { findings: readonly { code: string }[] };
    expect(missingBody.findings[0]?.code).toBe("OPENLUP_E_RECIPE_NOT_FOUND");

    const badId = await runCli(["recipe", "show", "../escape/hack", "--json"]);
    expect(badId.exitCode).toBe(64);
    const badIdBody = JSON.parse(badId.stdout) as { findings: readonly { code: string }[] };
    expect(badIdBody.findings[0]?.code).toBe("OPENLUP_E_CLI_INPUT");
  });

  it("installs recipes into owned/adapters/<domain>/<provider> and passes Stages 1-3 via 1-command --verify", async () => {
    const appDir = await makeTempDir("openlup-recipe-cli-app-");

    // 1. Install + verify payments/adyen (includes browser/ + csp.json!) into default owned/adapters/payments/adyen
    const adyenDest = join(appDir, "owned/adapters/payments/adyen");
    const addAdyen = await runCli([
      "recipe",
      "add",
      "payments/adyen",
      "--dest",
      adyenDest,
      "--catalog",
      CATALOG_DIR,
      "--verify",
      "--json",
    ]);
    expect(addAdyen.exitCode).toBe(0);
    const adyenBody = JSON.parse(addAdyen.stdout) as {
      formatVersion: number;
      command: string;
      state: string;
      filesCopied: number;
      recipeTreeSha256: string;
      verification: {
        state: string;
        provenanceState: string;
        stages: {
          manifest: { passed: boolean };
          staticIsolation: { passed: boolean; filesScanned: number };
          stages1to3Tests: { passed: boolean; numTotalTests: number; numFailedTests: number };
        };
      };
    };
    expect(adyenBody.formatVersion).toBe(1);
    expect(adyenBody.command).toBe("recipe add");
    expect(adyenBody.state).toBe("installed-and-verified");
    expect(adyenBody.filesCopied).toBeGreaterThanOrEqual(9);
    expect(adyenBody.recipeTreeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(adyenBody.verification.state).toBe("satisfied");
    expect(adyenBody.verification.provenanceState).toBe("pristine");
    expect(adyenBody.verification.stages.manifest.passed).toBe(true);
    expect(adyenBody.verification.stages.staticIsolation.passed).toBe(true);
    expect(adyenBody.verification.stages.stages1to3Tests.passed).toBe(true);
    expect(adyenBody.verification.stages.stages1to3Tests.numTotalTests).toBeGreaterThanOrEqual(8);
    expect(adyenBody.verification.stages.stages1to3Tests.numFailedTests).toBe(0);

    // Verify provenance ledger exists outside RECIPE_DIR so allFiles parity stays exact
    const provRaw = await fs.readFile(join(appDir, "owned/adapters/.openlup-provenance.json"), "utf8");
    const prov = JSON.parse(provRaw) as { recipes: Record<string, { recipeTreeSha256: string }> };
    expect(prov.recipes["payments/adyen"]?.recipeTreeSha256).toBe(adyenBody.recipeTreeSha256);

    // 2. Also prove a second domain (shipping/easypost) installs cleanly into the same owned/adapters container
    const easypostDest = join(appDir, "owned/adapters/shipping/easypost");
    const addEasyPost = await runCli([
      "recipe",
      "add",
      "shipping/easypost",
      "--dest",
      easypostDest,
      "--catalog",
      CATALOG_DIR,
      "--verify",
      "--json",
    ]);
    expect(addEasyPost.exitCode).toBe(0);
    const epBody = JSON.parse(addEasyPost.stdout) as { state: string; verification: { stages: { stages1to3Tests: { passed: boolean } } } };
    expect(epBody.state).toBe("installed-and-verified");
    expect(epBody.verification.stages.stages1to3Tests.passed).toBe(true);
  }, 30_000);

  it("enforces overwrite refusal, --force, symlink refusal, local-edit provenance, and ADR-001 isolation checks", async () => {
    const appDir = await makeTempDir("openlup-recipe-cli-sec-");
    const dest = join(appDir, "owned/adapters/channels/shopify");

    // Initial install without --verify
    const initial = await runCli([
      "recipe",
      "add",
      "channels/shopify",
      "--dest",
      dest,
      "--catalog",
      CATALOG_DIR,
      "--json",
    ]);
    expect(initial.exitCode).toBe(0);

    // Re-add without --force refuses cleanly (exit 1)
    const conflict = await runCli([
      "recipe",
      "add",
      "channels/shopify",
      "--dest",
      dest,
      "--catalog",
      CATALOG_DIR,
      "--json",
    ]);
    expect(conflict.exitCode).toBe(1);
    const conflictBody = JSON.parse(conflict.stdout) as { findings: readonly { code: string }[] };
    expect(conflictBody.findings[0]?.code).toBe("OPENLUP_E_RECIPE_DEST_EXISTS");

    // Legitimate local edit preserves verify pass while marking provenance locally-modified
    const adapterPath = join(dest, "server/adapter.ts");
    const originalAdapter = await fs.readFile(adapterPath, "utf8");
    await fs.writeFile(adapterPath, `// local store ownership note\n${originalAdapter}`, "utf8");

    const verifyModified = await runCli(["recipe", "verify", dest, "--skip-tests", "--json"]);
    expect(verifyModified.exitCode).toBe(0);
    const modBody = JSON.parse(verifyModified.stdout) as { state: string; provenanceState: string };
    expect(modBody.state).toBe("satisfied");
    expect(modBody.provenanceState).toBe("locally-modified");

    // Planted ADR-001 violation (ambient env read + vendor SDK import) fails verify (exit 1)
    const envExpr = `${"proc" + "ess"}.${"env"}.LEAKED_KEY`;
    await fs.writeFile(
      adapterPath,
      `import fakeSdk from "vendor-sdk-package";\nconst bad = ${envExpr};\nvoid fakeSdk;\nvoid bad;\n${originalAdapter}`,
      "utf8",
    );
    const verifyViolation = await runCli(["recipe", "verify", dest, "--skip-tests", "--json"]);
    expect(verifyViolation.exitCode).toBe(1);
    const violBody = JSON.parse(verifyViolation.stdout) as {
      findings: readonly { code: string }[];
      stages: { staticIsolation: { passed: boolean; violations: readonly string[] } };
    };
    expect(violBody.findings.some((f) => f.code === "OPENLUP_E_RECIPE_ISOLATION_VIOLATION")).toBe(true);
    expect(violBody.stages.staticIsolation.passed).toBe(false);
    expect(violBody.stages.staticIsolation.violations.length).toBeGreaterThanOrEqual(2);

    // --force cleanly restores pristine recipe files
    const forced = await runCli([
      "recipe",
      "add",
      "channels/shopify",
      "--dest",
      dest,
      "--catalog",
      CATALOG_DIR,
      "--force",
      "--json",
    ]);
    expect(forced.exitCode).toBe(0);
    const verifyRestored = await runCli(["recipe", "verify", dest, "--skip-tests", "--json"]);
    expect(verifyRestored.exitCode).toBe(0);
    expect((JSON.parse(verifyRestored.stdout) as { provenanceState: string }).provenanceState).toBe("pristine");

    // Symlinked destination is refused (exit 74) without writing into target
    const outsideTarget = join(appDir, "outside-target");
    await fs.mkdir(outsideTarget, { recursive: true });
    const symlinkDest = join(appDir, "linked-dest");
    await fs.symlink(outsideTarget, symlinkDest, "dir");
    const symlinkAdd = await runCli([
      "recipe",
      "add",
      "channels/shopify",
      "--dest",
      symlinkDest,
      "--catalog",
      CATALOG_DIR,
      "--json",
    ]);
    expect(symlinkAdd.exitCode).toBe(74);
    expect((await fs.readdir(outsideTarget)).length).toBe(0);

    // Invalid invocation and missing catalog exit 64 and 74 respectively
    const badCmd = await runCli(["recipe", "unknown-subcommand", "--json"]);
    expect(badCmd.exitCode).toBe(64);
    const missingCatalog = await runCli(["recipe", "list", "--catalog", join(appDir, "does-not-exist"), "--json"]);
    expect(missingCatalog.exitCode).toBe(74);
  });

  it("installs into default owned/adapters/<domain>/<provider> from an external app cwd and prints --help", async () => {
    const helpRes = await runCli(["recipe", "--help"]);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain("openlup recipe add <id>");

    const appDir = await makeTempDir("openlup-recipe-cli-default-dest-");
    const added = await runCli(["recipe", "add", "shipping/usps", "--catalog", CATALOG_DIR, "--verify", "--json"], {
      cwd: appDir,
    });
    expect(added.exitCode).toBe(0);
    const body = JSON.parse(added.stdout) as {
      dest: string;
      state: string;
      verification: { state: string; stages: { stages1to3Tests: { passed: boolean; numTotalTests: number } } };
    };
    expect(body.dest).toBe("owned/adapters/shipping/usps");
    expect(body.state).toBe("installed-and-verified");
    expect(body.verification.state).toBe("satisfied");
    expect(body.verification.stages.stages1to3Tests.passed).toBe(true);
    expect(body.verification.stages.stages1to3Tests.numTotalTests).toBeGreaterThanOrEqual(15);

    // Owned-adapters index.json was materialized cleanly outside RECIPE_DIR
    const ownedIdx = JSON.parse(await fs.readFile(join(appDir, "owned/adapters/index.json"), "utf8")) as {
      recipes: readonly { id: string }[];
    };
    expect(ownedIdx.recipes.map((r) => r.id)).toEqual(["shipping/usps"]);
  }, 30_000);

  it("blocks schema/ symlink escape, catalog overlap under tmpdir, ADR-001 bypasses, manifest drift, and test failures", async () => {
    const appDir = await makeTempDir("openlup-recipe-cli-regressions-");

    // 1. Symlinked owned/adapters/schema must be refused (exit 74) with zero writes to outside dir OR dest
    const outsideSchema = join(appDir, "outside-schema");
    await fs.mkdir(outsideSchema, { recursive: true });
    await fs.mkdir(join(appDir, "owned/adapters"), { recursive: true });
    await fs.symlink(outsideSchema, join(appDir, "owned/adapters/schema"), "dir");
    const schemaEscape = await runCli(
      ["recipe", "add", "payments/adyen", "--catalog", CATALOG_DIR, "--json"],
      { cwd: appDir },
    );
    expect(schemaEscape.exitCode).toBe(74);
    expect((JSON.parse(schemaEscape.stdout) as { findings: readonly { code: string }[] }).findings[0]?.code).toBe(
      "OPENLUP_E_RECIPE_UNSAFE_PATH",
    );
    expect(await fs.readdir(outsideSchema)).toEqual([]);
    await fs.unlink(join(appDir, "owned/adapters/schema"));

    // 2. Source-dest overlap under tmpdir (even with --force) is refused with OPENLUP_E_RECIPE_DEST_CONFLICT
    const tempCatalog = join(appDir, "temp-catalog");
    await fs.cp(join(CATALOG_DIR, "shipping/usps"), join(tempCatalog, "shipping/usps"), { recursive: true });
    await fs.cp(join(CATALOG_DIR, "schema"), join(tempCatalog, "schema"), { recursive: true });
    await fs.copyFile(join(CATALOG_DIR, "index.json"), join(tempCatalog, "index.json"));
    const overlap = await runCli([
      "recipe",
      "add",
      "shipping/usps",
      "--catalog",
      tempCatalog,
      "--dest",
      join(tempCatalog, "shipping/usps"),
      "--force",
      "--json",
    ]);
    expect(overlap.exitCode).toBe(1);
    const overlapBody = JSON.parse(overlap.stdout) as {
      command: string;
      state: string;
      findings: readonly { code: string }[];
    };
    expect(overlapBody.command).toBe("recipe add");
    expect(overlapBody.state).toBe("refused");
    expect(overlapBody.findings[0]?.code).toBe("OPENLUP_E_RECIPE_DEST_CONFLICT");

    // 3. Positive control: valid export containing "from '...'" inside a string must NOT false-positive
    const uspsDest = join(appDir, "owned/adapters/shipping/usps");
    const installUsps = await runCli(
      ["recipe", "add", "shipping/usps", "--catalog", CATALOG_DIR, "--json"],
      { cwd: appDir },
    );
    expect(installUsps.exitCode).toBe(0);
    const adapterPath = join(uspsDest, "server/adapter.ts");
    const originalAdapter = await fs.readFile(adapterPath, "utf8");
    await fs.writeFile(
      adapterPath,
      `${originalAdapter}\nexport function describeSource() { return "Loaded from 'USPS' catalog"; }\n`,
      "utf8",
    );
    const positiveVerify = await runCli(["recipe", "verify", uspsDest, "--skip-tests", "--json"]);
    expect(positiveVerify.exitCode).toBe(0);
    expect((JSON.parse(positiveVerify.stdout) as { stages: { staticIsolation: { passed: boolean } } }).stages.staticIsolation.passed).toBe(true);

    // 4. Negative control: multiline export + side-effect/whitespace-free import bypass is caught AND skips Vitest
    await fs.writeFile(
      adapterPath,
      `export const ok = 1;\nimport"vendor-sdk";\nimport{x}from"vendor-sdk-2";\nvoid ok; void x;\n${originalAdapter}`,
      "utf8",
    );
    const bypassVerify = await runCli(["recipe", "verify", uspsDest, "--json"]);
    expect(bypassVerify.exitCode).toBe(1);
    const bypassBody = JSON.parse(bypassVerify.stdout) as {
      stages: {
        staticIsolation: { passed: boolean; violations: readonly string[] };
        stages1to3Tests: { state: string; passed: boolean };
      };
    };
    expect(bypassBody.stages.staticIsolation.passed).toBe(false);
    expect(bypassBody.stages.staticIsolation.violations.some((v) => v.includes("vendor-sdk"))).toBe(true);
    expect(bypassBody.stages.staticIsolation.violations.some((v) => v.includes("vendor-sdk-2"))).toBe(true);
    expect(bypassBody.stages.stages1to3Tests.state).toBe("skipped");
    expect(bypassBody.stages.stages1to3Tests.passed).toBe(false);

    // Restore clean adapter, then verify manifest/disk inventory drift fails with OPENLUP_E_RECIPE_MANIFEST_INVALID
    await fs.writeFile(adapterPath, originalAdapter, "utf8");
    const extraFile = join(uspsDest, "server/undeclared.ts");
    await fs.writeFile(extraFile, "export const extra = 1;\n", "utf8");
    const driftVerify = await runCli(["recipe", "verify", uspsDest, "--skip-tests", "--json"]);
    expect(driftVerify.exitCode).toBe(1);
    expect((JSON.parse(driftVerify.stdout) as { findings: readonly { code: string }[] }).findings[0]?.code).toBe(
      "OPENLUP_E_RECIPE_MANIFEST_INVALID",
    );
    await fs.unlink(extraFile);

    // 5. Failing Vitest assertion fails verify with OPENLUP_E_RECIPE_TESTS_FAILED
    const mountProofPath = join(uspsDest, "tests/mount-proof.test.ts");
    const origMountProof = await fs.readFile(mountProofPath, "utf8");
    await fs.writeFile(
      mountProofPath,
      `${origMountProof}\nimport { it as _it, expect as _expect } from "vitest";\n_it("planted failure", () => { _expect(1).toBe(2); });\n`,
      "utf8",
    );
    const failingTests = await runCli(["recipe", "verify", uspsDest, "--json"]);
    expect(failingTests.exitCode).toBe(1);
    expect((JSON.parse(failingTests.stdout) as { findings: readonly { code: string }[] }).findings[0]?.code).toBe(
      "OPENLUP_E_RECIPE_TESTS_FAILED",
    );
    await fs.writeFile(mountProofPath, origMountProof, "utf8");

    // 6. Cross-subcommand invalid flags, empty verify path, --region filtering, and non-canonical --dest hint
    expect((await runCli(["recipe", "list", "--force", "--json"])).exitCode).toBe(64);
    expect((await runCli(["recipe", "verify", uspsDest, "--catalog", CATALOG_DIR, "--json"])).exitCode).toBe(64);
    expect((await runCli(["recipe", "verify", "", "--json"])).exitCode).toBe(64);

    const regionFiltered = await runCli(["recipe", "list", "--region", "US", "--json"]);
    expect(regionFiltered.exitCode).toBe(0);
    expect((JSON.parse(regionFiltered.stdout) as { filteredCount: number }).filteredCount).toBeGreaterThanOrEqual(5);

    const nonCanonical = await runCli([
      "recipe",
      "add",
      "payments/adyen",
      "--dest",
      join(appDir, "custom-adyen"),
      "--catalog",
      CATALOG_DIR,
      "--verify",
      "--json",
    ]);
    expect(nonCanonical.exitCode).toBe(1);
    const ncBody = JSON.parse(nonCanonical.stdout) as { verification: { findings: readonly { code: string }[] } };
    expect(ncBody.verification.findings.some((f) => f.code === "OPENLUP_E_RECIPE_NONCANONICAL_DEST")).toBe(true);
  }, 30_000);
});
