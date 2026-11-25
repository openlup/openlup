/** The common premerge route; package manifests own their semantic proof, not a second registry. */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePackagesConfig } from "./package-manifest-policy.ts";
import { preparePackages } from "./package-build.ts";
import { isolatedConsumerEnv, readCurrentPackManifest } from "./pack-manifest-input.ts";

const NPM_CLI = realpathSync(resolve(dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));

function runAsync(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [NPM_CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    let settled = false;
    child.once("error", error => {
      if (settled) return;
      settled = true;
      rejectPromise(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(Object.assign(new Error(`npm ${args.join(" ")} exited with ${signal ?? code}`), { status: code, signal, stdout, stderr }));
    });
  });
}

export function runRequiredPackageGates(
  root: string,
  output: string,
  commit: string,
  options: { prepacked?: boolean } = {},
): Promise<void> {
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
  const input = join(directory, "packages-manifest.json");
  if (options.prepacked) {
    readCurrentPackManifest(root, input, commit);
    console.log(`Verified prepacked package set ${Math.round(performance.now() - started)} ms (${packages.length} publishable packages)`);
  } else {
    // Existing cold preparation still owns dependency order, cleanup and package budgets.
    run(["run", "packages:check", "--", "--cold", "--out", directory]);
    readCurrentPackManifest(root, input, commit);
    console.log(`Cold package set ${Math.round(performance.now() - started)} ms (${packages.length} publishable packages)`);
  }
  // Cold preparation clears every workspace per target (and a fresh runner starts without dist/).
  // Restore built declarations once in topological dependency order without touching the
  // retained tarballs so shared prerequisites are not rebuilt per package.
  preparePackages(root, packages, catalog.packages, false);
  // Reject every package's cheap API drift before any package's expensive proof.
  for (const { name, directory: workspace } of packages) {
    const phase = performance.now();
    run(["--workspace", `./${workspace}`, "run", "api:check"]);
    console.log(`Package API ${name}: ${Math.round(performance.now() - phase)} ms`);
  }
  // Every publishable package's ci:required consumes the immutable prebuilt dist/ and verified
  // tarballs inside its own isolated temp directory and disposable database; cap at 2 concurrent
  // package lanes so 4-vCPU hosted runners overlap heavy proofs without 3-way Vitest worker thrashing.
  return (async () => {
    const queue = [...packages];
    const failures: unknown[] = [];
    const workerCount = Math.min(2, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const { name, directory: workspace } = entry;
        const phase = performance.now();
        const env = { ...isolatedConsumerEnv(), OPENLUP_PACK_MANIFEST: input, OPENLUP_PACK_COMMIT: commit, OPENLUP_DIST_READY: "1" };
        try {
          const { stdout, stderr } = await runAsync(["--workspace", `./${workspace}`, "run", "ci:required"], root, env);
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          console.log(`Package proof ${name}: ${Math.round(performance.now() - phase)} ms`);
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          if (failure.stdout) process.stdout.write(failure.stdout);
          if (failure.stderr) process.stderr.write(failure.stderr);
          console.error(`Package proof ${name} FAILED (${Math.round(performance.now() - phase)} ms): ${failure.message}`);
          failures.push(failure);
        }
      }
    }));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `package-gates: ${failures.length} package proofs failed`,
      );
    }
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || (args[0] !== "--out" && args[0] !== "--packages") || args[2] !== "--expected-commit") {
    throw new Error("Use (--out <empty-output> | --packages <packed-dir>) --expected-commit <full-sha>");
  }
  await runRequiredPackageGates(process.cwd(), args[1]!, args[3]!, { prepacked: args[0] === "--packages" });
}
