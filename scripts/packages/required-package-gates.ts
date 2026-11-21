/** The common premerge route; package manifests own their semantic proof, not a second registry. */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";
import { parsePackagesConfig } from "./package-manifest-policy.ts";
import { preparePackages } from "./package-build.ts";
import { isolatedConsumerEnv, readCurrentPackManifest } from "./pack-manifest-input.ts";
import { checkReleasedApi } from "./released-api-check.ts";
import { localPacks } from "./released-api-baseline.ts";

export async function runRequiredPackageGates(root: string, output: string, commit: string, released?: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(commit) || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: isolatedConsumerEnv() }).trim() !== commit) throw new Error("package-gates: expected commit differs from the actual checkout");
  const catalog = parsePackagesConfig(readFileSync(join(root, "config/openlup-packages.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(workspaces)) throw new Error("package-gates: actual workspace discovery is missing");
  const packages = catalog.packages.filter(({ publish }) => publish);
  if (!packages.length) throw new Error("package-gates: no publishable packages");
  for (const entry of packages) {
    if (!workspaces.includes(entry.directory)) throw new Error(`package-gates: ${entry.directory} is not an actual workspace`);
    const metadata = JSON.parse(readFileSync(join(root, entry.directory, "package.json"), "utf8"));
    if (metadata.name !== entry.name) throw new Error(`package-gates: workspace identity differs for ${entry.name}`);
    for (const script of ["api:check", "ci:required", "test:consumer"]) if (typeof metadata.scripts?.[script] !== "string" || !metadata.scripts[script].trim()) throw new Error(`package-gates: ${entry.name} needs executable ${script}`);
  }
  const directory = resolve(root, output), started = performance.now();
  const run = (args: string[], env = isolatedConsumerEnv()) => execFileSync("npm", args, { cwd: root, env, stdio: "inherit" });
  // Existing cold preparation still owns dependency order, cleanup and package budgets.
  run(["run", "packages:check", "--", "--cold", "--out", directory]);
  const input = join(directory, "packages-manifest.json");
  const packs = readCurrentPackManifest(root, input, commit);
  console.log(`Cold package set ${Math.round(performance.now() - started)} ms (${packages.length} publishable packages)`);
  await checkReleasedApi(root, packages, [...packs.values()], released ? localPacks(resolve(root, released)) : undefined, processEnvironment.OPENLUP_AUTHORIZED_API_MAJOR);
  // Cold preparation clears every workspace per target. Restore built
  // declarations once in topological dependency order without touching the
  // retained tarballs so shared prerequisites are not rebuilt per package.
  preparePackages(root, packages, catalog.packages, false);
  // Reject every package's cheap API drift before any package's expensive proof.
  for (const { name, directory: workspace } of packages) {
    const phase = performance.now();
    run(["--workspace", `./${workspace}`, "run", "api:check"]);
    console.log(`Package API ${name}: ${Math.round(performance.now() - phase)} ms`);
  }
  for (const { name, directory: workspace } of packages) {
    const phase = performance.now();
    const env = { ...isolatedConsumerEnv(), OPENLUP_PACK_MANIFEST: input, OPENLUP_PACK_COMMIT: commit, OPENLUP_DIST_READY: "1" };
    run(["--workspace", `./${workspace}`, "run", "ci:required"], env);
    console.log(`Package proof ${name}: ${Math.round(performance.now() - phase)} ms`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if ((args.length !== 4 && (args.length !== 6 || args[4] !== "--released")) || args[0] !== "--out" || args[2] !== "--expected-commit") {
    throw new Error("Use --out <empty-output> --expected-commit <full-sha> [--released <pack-directory>]");
  }
  await runRequiredPackageGates(process.cwd(), args[1]!, args[3]!, args[5]);
}
