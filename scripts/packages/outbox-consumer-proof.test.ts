import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { POSTGRES_PROOF_IMAGE } from "./outbox-disposable-postgres.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), env = isolatedConsumerEnv();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env }).trim();
let scratch: string, basePacks: string;
beforeAll(() => {
  // Owned warm mechanical fixtures, not cold-producer/candidate evidence.
  scratch = mkdtempSync(join(tmpdir(), "outbox-consumer-falsifiers-")); basePacks = join(scratch, "packs"); mkdirSync(basePacks);
  const config = JSON.parse(readFileSync(join(root, "config/openlup-packages.json"), "utf8"));
  const packages = config.packages.filter((p: { publish: boolean }) => p.publish).map((p: { name: string; directory: string }) => {
    const metadata = JSON.parse(readFileSync(join(root, p.directory, "package.json"), "utf8"));
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--workspaces=false", "--cache", join(scratch, "cache"), "--pack-destination", basePacks], { cwd: join(root, p.directory), env, encoding: "utf8", timeout: 30_000 }));
    return { name: p.name, version: metadata.version, filename: pack.filename };
  });
  writeFileSync(join(basePacks, "packages-manifest.json"), JSON.stringify({ schemaVersion: 2, commit, packages })); rehash(basePacks);
}, 30_000);
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

function rehash(packs: string) {
  const path = join(packs, "packages-manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of manifest.packages) { const bytes = readFileSync(join(packs, entry.filename)); entry.sha256 = createHash("sha256").update(bytes).digest("hex"); entry.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`; }
  writeFileSync(path, JSON.stringify(manifest));
}
function fixture() {
  const target = realpathSync(mkdtempSync(join(scratch, "fixture-"))), packs = join(target, "packs"); cpSync(basePacks, packs, { recursive: true });
  // This is a test-input subset, with no checkout or Git identity. Tooling is explicit.
  const files = ["config/openlup-packages.json", "packages/core/package.json", "packages/outbox/package.json", "packages/outbox/scripts/consumer-proof.ts", "server/runtime/outbox/referenceContribution.ts", "server/runtime/outbox/candidateAdmission.ts", "packages/outbox/smoke/wiring.ts", "packages/outbox/smoke/schemaProof.ts", "scripts/packages/schema-budget-proof.mjs", ...["outbox-consumer-proof", "outbox-disposable-postgres", "pack-manifest-input", "package-manifest-policy"].map(name => `scripts/packages/${name}.ts`)];
  for (const file of files) { mkdirSync(dirname(join(target, file)), { recursive: true }); cpSync(join(root, file), join(target, file)); }
  writeFileSync(join(target, "package.json"), '{"type":"module","workspaces":["packages/core","packages/outbox"]}\n'); mkdirSync(join(target, "node_modules"));
  cpSync(join(root, "node_modules/zod"), join(target, "node_modules/zod"), { recursive: true });
  for (const name of ["typescript", "pg"]) symlinkSync(join(root, "node_modules", name), join(target, "node_modules", name), "dir");
  return { target, packs };
}
function invoke(target: string, owned = false) {
  const input = ["--manifest", join(target, "packs/packages-manifest.json"), "--expected-commit", commit];
  const args = owned ? [join(target, "scripts/packages/outbox-disposable-postgres.ts"), ...input] : [join(target, "scripts/packages/outbox-consumer-proof.ts"), "postgresql://postgres@127.0.0.1:9/openlup_outbox_proof", join(target, ".context/scratch/proof"), ...input];
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ...args], { cwd: target, env, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  console.log(`Outbox falsifier ${owned ? "owned SQL" : "before SQL"}: ${Math.round(performance.now() - started)} ms`);
  expect(result.error).toBeUndefined(); return result;
}
function repackOutbox(packs: string, mutate: (directory: string) => void) {
  const manifest = JSON.parse(readFileSync(join(packs, "packages-manifest.json"), "utf8")), outbox = manifest.packages.find((p: { name: string }) => p.name === "@openlup/outbox");
  const extract = mkdtempSync(join(scratch, "artifact-")); execFileSync("tar", ["-xzf", join(packs, outbox.filename), "-C", extract]);
  mutate(join(extract, "package"));
  execFileSync("tar", ["-czf", join(packs, outbox.filename), "-C", extract, "package"]); rehash(packs);
}
function addIndependentPackage(target: string, packs: string) {
  const directory = "packages/independent", name = "@openlup/independent", version = "0.13.1";
  mkdirSync(join(target, directory), { recursive: true });
  writeFileSync(join(target, directory, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.js" }));
  writeFileSync(join(target, directory, "index.js"), "export const independent = true;\n");
  const configPath = join(target, "config/openlup-packages.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  config.packages.push({ name, directory, publish: true }); writeFileSync(configPath, JSON.stringify(config));
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--workspaces=false", "--cache", join(scratch, "cache"), "--pack-destination", packs], { cwd: join(target, directory), env, encoding: "utf8", timeout: 30_000 }));
  const manifestPath = join(packs, "packages-manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.packages.push({ name, version, filename: pack.filename }); writeFileSync(manifestPath, JSON.stringify(manifest)); rehash(packs);
  return join(packs, pack.filename);
}
it("retains the actual Outbox reference proof when the complete artifact set gains an independent package", () => {
  const f = fixture(); addIndependentPackage(f.target, f.packs);
  const result = invoke(f.target, true); expect(result.status).toBe(0); expect(result.stdout).toContain("Packed outbox/reference proof PASS");
  const reports = join(f.target, ".context/scratch"), owned = readdirSync(reports).filter(name => name.startsWith("owned-postgres-"));
  expect(owned).toHaveLength(1);
  const installed = JSON.parse(readFileSync(join(reports, owned[0]!, "installed-packages.json"), "utf8"));
  expect(installed.map((p: { name: string }) => p.name)).toEqual(["@openlup/core", "@openlup/outbox"]);
}, 240_000);
it("still rejects damaged independent artifacts before starting PostgreSQL", () => {
  const f = fixture(), artifact = addIndependentPackage(f.target, f.packs); writeFileSync(artifact, "changed after manifest");
  const result = invoke(f.target, true); expect(result.status).not.toBe(0); expect(result.stderr).toContain("digest mismatch"); expect(result.stdout).not.toContain("Owned PostgreSQL ready");
});
it("rejects changed tarball bytes before any install or SQL", () => {
  const f = fixture(), manifest = JSON.parse(readFileSync(join(f.packs, "packages-manifest.json"), "utf8"));
  writeFileSync(join(f.packs, manifest.packages[0].filename), "changed after manifest");
  const result = invoke(f.target); expect(result.status).not.toBe(0); expect(result.stderr).toContain("digest mismatch");
});
it("rejects a digest-consistent missing runtime export through the actual installed runner", () => {
  const f = fixture(); repackOutbox(f.packs, directory => writeFileSync(join(directory, "dist/postgres.js"), "export {};\n"));
  const result = invoke(f.target); expect(result.status).not.toBe(0); expect(result.stderr).toContain("does not provide an export named");
});
it("fails the real replay proof when synthetic application dedupe is removed", () => {
  const f = fixture(), path = join(f.target, "packages/outbox/smoke/wiring.ts"), source = readFileSync(path, "utf8");
  expect(source).toContain("on conflict (event_id) do nothing"); writeFileSync(path, source.replace("on conflict (event_id) do nothing", ""));
  const result = invoke(f.target, true); expect(result.status).not.toBe(0); expect(result.stderr).toContain("AssertionError"); expect(result.stdout).toContain("Owned PostgreSQL cleanup");
}, 240_000);
it("fails the actual reclaim proof if the adapter reports a formerly valid token accepted", () => {
  const f = fixture(); repackOutbox(f.packs, directory => {
    const path = join(directory, "dist/postgres.js"), source = readFileSync(path, "utf8"), method = "async markProcessed(input) {";
    expect(source).toContain(method);
    // Only the replay's once-valid token call has this marker; invented-token tests still run.
    writeFileSync(path, source.replace(method, `${method}\n if (input.metadata?.stale) return { applied: true };`));
  });
  const result = invoke(f.target, true); expect(result.status).not.toBe(0); expect(result.stderr).toContain("AssertionError"); expect(result.stdout).toContain("Owned PostgreSQL cleanup");
}, 240_000);

it.each(["direct", "package-group"] as const)("handles repeated interruption through %s, drops only its database and preserves the owned service", async mode => {
  const f = fixture(), owner = randomUUID(), name = `openlup-outbox-interruption-${owner}`;
  const environment = { ...env };
  delete environment.OPENLUP_PROOF_SERVICE_CONTAINER;
  delete environment.OPENLUP_PROOF_SERVICE_PORT;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", env: environment, timeout: 30_000 }).trim();
  const started = performance.now();
  let container: string | undefined, launcher: ReturnType<typeof spawn> | undefined;
  let proofPid: number | undefined, descendantPid: number | undefined;
  let stdout = "", stderr = "";
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
  try {
    container = docker(["run", "--detach", "--rm", "--name", name, "--label", `openlup-interruption-test=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
    const port = docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
    // Both processes resist TERM, exercising the launcher's bounded group KILL.
    writeFileSync(join(f.target, "scripts/packages/outbox-consumer-proof.ts"), [
      'import { spawn } from "node:child_process";',
      'process.on("SIGTERM", () => {});',
      `const code = 'process.on("SIGTERM", () => {}); console.log("DESCENDANT_READY"); setInterval(() => {}, 1000);';`,
      'const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });',
      'child.stdout.once("data", () => console.log("HANGING_PROOF_READY " + JSON.stringify({ proof: process.pid, descendant: child.pid })));',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const supplied = { ...environment, OPENLUP_PACK_MANIFEST: join(f.packs, "packages-manifest.json"), OPENLUP_PACK_COMMIT: commit, OPENLUP_PROOF_SERVICE_CONTAINER: container, OPENLUP_PROOF_SERVICE_PORT: port };
    launcher = mode === "direct"
      ? spawn(process.execPath, ["--experimental-strip-types", join(f.target, "scripts/packages/outbox-disposable-postgres.ts")], { cwd: f.target, env: supplied, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("npm", ["--workspace", "./packages/outbox", "run", "ci:required"], { cwd: f.target, env: supplied, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      launcher!.once("error", fail);
      launcher!.once("close", (code, signal) => done({ code, signal }));
    });
    launcher.stderr!.on("data", data => { stderr += data.toString(); });
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error(`Hanging proof startup deadline: ${stdout} ${stderr}`)), 45_000);
      launcher!.stdout!.on("data", data => {
        stdout += data.toString();
        const match = /HANGING_PROOF_READY (\{[^\n]+\})/.exec(stdout);
        if (match) {
          const identity = JSON.parse(match[1]);
          proofPid = identity.proof; descendantPid = identity.descendant;
          clearTimeout(timer); ready();
        }
      });
      completion.then(() => { clearTimeout(timer); fail(new Error(`Launcher exited before proof readiness: ${stdout} ${stderr}`)); }, error => { clearTimeout(timer); fail(error); });
    });
    expect(proofPid).toBeGreaterThan(0); expect(descendantPid).toBeGreaterThan(0);
    expect(running(proofPid!)).toBe(true); expect(running(descendantPid!)).toBe(true);
    const database = /database=(openlup_outbox_proof_[a-f0-9]{32})/u.exec(stdout)?.[1];
    expect(database).toBeDefined();
    const databaseCount = () => docker(["exec", container!, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", `select count(*) from pg_database where datname='${database}'`]);
    expect(databaseCount()).toBe("1");
    const interrupted = performance.now();
    const interrupt = () => { if (mode === "direct") launcher!.kill("SIGTERM"); else process.kill(-launcher!.pid!, "SIGTERM"); };
    interrupt();
    // Separate deliveries avoid signal coalescing hiding npm/wrapper forwarding.
    await new Promise(done => setTimeout(done, 50)); interrupt();
    let timer: NodeJS.Timeout | undefined;
    let result;
    try {
      result = await Promise.race([completion, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`Launcher interruption deadline: ${stdout} ${stderr}`)), 10_000); })]);
    } finally { if (timer) clearTimeout(timer); }
    expect(result.code).not.toBe(0);
    expect(stderr).toContain("deadline/interruption"); expect(stdout).toContain("Owned PostgreSQL cleanup");
    const goneDeadline = performance.now() + 3000;
    while ((running(proofPid!) || running(descendantPid!)) && performance.now() < goneDeadline) await new Promise(done => setTimeout(done, 25));
    expect(running(proofPid!)).toBe(false); expect(running(descendantPid!)).toBe(false);
    expect(JSON.parse(docker(["inspect", container]))[0].State.Running).toBe(true);
    expect(databaseCount()).toBe("0");
    process.stdout.write(`Owned service ${container} ${mode} interruption: startup ${Math.round(interrupted - started)} ms, signal/group/database cleanup ${Math.round(performance.now() - interrupted)} ms\n`);
  } finally {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      await new Promise<void>(done => {
        const timer = setTimeout(() => { launcher!.kill("SIGKILL"); done(); }, 3000);
        launcher!.once("close", () => { clearTimeout(timer); done(); });
        launcher!.kill("SIGTERM");
      });
    }
    for (const pid of [proofPid, descendantPid]) if (pid && running(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
    if (container) {
      const info = JSON.parse(docker(["inspect", container]))[0];
      expect(info.Config.Labels["openlup-interruption-test"]).toBe(owner);
      docker(["rm", "--force", container]);
    }
  }
}, 60_000);

// Exercise lost acknowledgements after real daemon/SQL effects, not a fake database.
it.each(["container-response", "container-owner-mismatch", "database-response"] as const)("cleans owned startup effects after %s", async mode => {
  const f = fixture(), environment = { ...env }, realDocker = execFileSync("which", ["docker"], { env, encoding: "utf8" }).trim();
  delete environment.OPENLUP_PROOF_SERVICE_CONTAINER; delete environment.OPENLUP_PROOF_SERVICE_PORT;
  const docker = (args: string[]) => spawnSync(realDocker, args, { env: environment, encoding: "utf8", timeout: 30_000 });
  const effect = join(f.target, "effect.json"), attempted = join(f.target, "attempted.json"), tools = join(f.target, "tools"); mkdirSync(tools);
  const shim = join(tools, "docker");
  writeFileSync(shim, `#!${process.execPath}
` + [
    'import { spawnSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'import { argv } from "node:process";',
    'const args = argv.slice(2);',
    `const mode = ${JSON.stringify(mode)}, effect = ${JSON.stringify(effect)}, attempted = ${JSON.stringify(attempted)};`,
    'const create = args.at(-1)?.match(/^CREATE DATABASE (openlup_outbox_proof_[a-f0-9]{32})$/);',
    'const intercepted = (args[0] === "run" && mode !== "database-response") || Boolean(create && mode === "database-response");',
    'const name = args[args.indexOf("--name") + 1], labelAt = args.indexOf("--label");',
    'if (intercepted && mode === "container-owner-mismatch") args[labelAt + 1] += "-different-owner";',
    'const record = { name, label: args[labelAt + 1], database: create?.[1] };',
    'if (intercepted) writeFileSync(attempted, JSON.stringify(record));',
    `const result = spawnSync(${JSON.stringify(realDocker)}, args, { encoding: "utf8", timeout: 30000 });`,
    'if (intercepted && result.status === 0) {',
    ' writeFileSync(effect, JSON.stringify({ ...record, id: result.stdout.trim() }));',
    ' process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 1000);',
    '} else { process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1); }',
  ].join("\n")); chmodSync(shim, 0o700);
  const owner = randomUUID(), serviceName = `openlup-startup-loss-${owner}`;
  let service: string | undefined, launcher: ReturnType<typeof spawn> | undefined, stdout = "", stderr = "";
  try {
    const supplied: NodeJS.ProcessEnv = { ...environment, PATH: `${tools}:${environment.PATH}`, OPENLUP_PACK_MANIFEST: join(f.packs, "packages-manifest.json"), OPENLUP_PACK_COMMIT: commit };
    if (mode === "database-response") {
      const started = docker(["run", "--detach", "--rm", "--name", serviceName, "--label", `openlup-startup-test=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
      expect(started.status).toBe(0); service = started.stdout.trim();
      const readyDeadline = performance.now() + 30_000;
      while (docker(["exec", service, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-t", "1"]).status !== 0) { if (performance.now() >= readyDeadline) throw new Error("Owned test service startup deadline"); await new Promise(done => setTimeout(done, 100)); }
      expect(docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE openlup_outbox_proof"]).status).toBe(0);
      supplied.OPENLUP_PROOF_SERVICE_CONTAINER = service; supplied.OPENLUP_PROOF_SERVICE_PORT = docker(["port", service, "5432/tcp"]).stdout.trim().split(":").at(-1)!;
    }
    launcher = spawn("npm", ["--workspace", "./packages/outbox", "run", "ci:required"], { cwd: f.target, env: supplied, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    launcher.stdout!.on("data", bytes => { stdout += bytes.toString(); }); launcher.stderr!.on("data", bytes => { stderr += bytes.toString(); });
    const completion = new Promise<number | null>((done, fail) => { launcher!.once("error", fail); launcher!.once("close", code => done(code)); });
    const startupDeadline = performance.now() + 45_000;
    while (!existsSync(effect)) { if (launcher.exitCode !== null || performance.now() >= startupDeadline) throw new Error(`Lost response setup: ${stdout} ${stderr}`); await new Promise(done => setTimeout(done, 25)); }
    const observed = JSON.parse(readFileSync(effect, "utf8"));
    if (!service) { const info = JSON.parse(docker(["inspect", observed.id]).stdout)[0]; expect(info.Name).toBe(`/${observed.name}`); expect(info.Config.Labels["openlup-proof"]).toBe(observed.label.slice("openlup-proof=".length)); expect(info.State.Running).toBe(true); }
    process.kill(-launcher.pid!, "SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try { expect(await Promise.race([completion, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`Lost response cleanup deadline: ${stdout} ${stderr}`)), 10_000); })])).not.toBe(0); } finally { if (timer) clearTimeout(timer); }
    expect(stdout).toContain("Owned PostgreSQL cleanup");
    if (service) {
      const remaining = docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", `select datname from pg_database where datname in ('${observed.database}', 'openlup_outbox_proof') order by datname`]);
      expect(remaining.status).toBe(0); expect(remaining.stdout.trim()).toBe("openlup_outbox_proof"); expect(JSON.parse(docker(["inspect", service]).stdout)[0].State.Running).toBe(true);
    } else if (mode === "container-owner-mismatch") {
      expect(stderr).toContain("Container cleanup ownership mismatch"); expect(JSON.parse(docker(["inspect", observed.id]).stdout)[0].State.Running).toBe(true);
    } else expect(docker(["inspect", observed.id]).status).not.toBe(0);
    expect(stdout).not.toContain("Packed proof process");
  } finally {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) { try { process.kill(-launcher.pid!, "SIGTERM"); } catch { /* Already stopped. */ } await new Promise(done => setTimeout(done, 1500)); if (launcher.exitCode === null) { try { process.kill(-launcher.pid!, "SIGKILL"); } catch { /* Already stopped. */ } } }
    if (service) { const info = JSON.parse(docker(["inspect", service]).stdout)[0]; expect(info.Config.Labels["openlup-startup-test"]).toBe(owner); expect(docker(["rm", "--force", service]).status).toBe(0); }
    if (!service && existsSync(attempted)) { const observed = JSON.parse(readFileSync(attempted, "utf8")), inspected = docker(["inspect", observed.name]); if (inspected.status === 0) { const info = JSON.parse(inspected.stdout)[0]; expect(info.Name).toBe(`/${observed.name}`); expect(info.Config.Labels["openlup-proof"]).toBe(observed.label.slice("openlup-proof=".length)); expect(docker(["rm", "--force", info.Id]).status).toBe(0); } }
  }
}, 90_000);
