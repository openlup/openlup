import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, chmodSync, existsSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
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
function fixture(copyZod = true) {
  const target = realpathSync(mkdtempSync(join(scratch, "fixture-"))), packs = join(target, "packs"); cpSync(basePacks, packs, { recursive: true });
  // This is a test-input subset, with no checkout or Git identity. Tooling is explicit.
  const config = JSON.parse(readFileSync(join(root, "config/openlup-packages.json"), "utf8"));
  const directories = config.packages.filter((entry: { publish: boolean }) => entry.publish).map((entry: { directory: string }) => entry.directory);
  const files = ["config/openlup-packages.json", ...directories.map((directory: string) => `${directory}/package.json`), "packages/outbox/scripts/consumer-proof.ts", "server/runtime/outbox/referenceContribution.ts", "server/runtime/outbox/candidateAdmission.ts", "packages/outbox/smoke/wiring.ts", "packages/outbox/smoke/schemaProof.ts", "packages/outbox/smoke/groupedSchemaProof.ts", "scripts/packages/schema-budget-proof.mjs", ...["outbox-consumer-proof", "outbox-disposable-postgres", "pack-manifest-input", "package-manifest-policy"].map(name => `scripts/packages/${name}.ts`)];
  for (const file of files) { mkdirSync(dirname(join(target, file)), { recursive: true }); cpSync(join(root, file), join(target, file)); }
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module", workspaces: directories }) + "\n"); mkdirSync(join(target, "node_modules"));
  if (copyZod) cpSync(join(root, "node_modules/zod"), join(target, "node_modules/zod"), { recursive: true });
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
}, 30_000);
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

// The Vitest worker owns no Docker resource. A plain Node owner remains in the
// required-test process group and finishes cleanup even if that worker exits.
function fixtureDriver(f: ReturnType<typeof fixture>, operation: string, mode: string) {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const driver = join(f.target, "fixture-owner.ts");
  const body = source.slice(source.indexOf("\nasync function fixtureWait("), source.indexOf("\n// End standalone fixture functions."));
  assert.ok(body.startsWith("\nasync function fixtureWait("));
  writeFileSync(driver, [
    'import assert from "node:assert/strict";',
    'import {execFileSync, spawn, spawnSync} from "node:child_process";',
    'import {randomUUID} from "node:crypto";',
    'import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync} from "node:fs";',
    'import {join} from "node:path";',
    'import {isolatedConsumerEnv} from "./scripts/packages/pack-manifest-input.ts";',
    `const env = isolatedConsumerEnv(), commit = ${JSON.stringify(commit)}, root = ${JSON.stringify(root)}, POSTGRES_PROOF_IMAGE = ${JSON.stringify(POSTGRES_PROOF_IMAGE)};`,
    // A dead worker closes its output pipe. Output errors must not kill cleanup.
    'process.stdout.on("error", () => {}); process.stderr.on("error", () => {});',
    body,
    `await ${operation}(${JSON.stringify(mode)}, ${JSON.stringify(f)});`,
  ].join("\n"));
  return spawn(process.execPath, ["--experimental-strip-types", driver], { cwd: f.target, env, stdio: ["ignore", "pipe", "pipe"] });
}
async function driverCompletion(child: ReturnType<typeof spawn>) {
  let stdout = "", stderr = "";
  child.stdout!.on("data", bytes => { stdout += bytes.toString(); }); child.stderr!.on("data", bytes => { stderr += bytes.toString(); });
  const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
  assert.equal(code, 0, `${stdout} ${stderr}`);
}
it.each(["direct", "package-group"] as const)("handles repeated interruption through %s, drops only its database and preserves the owned service", async mode => {
  await driverCompletion(fixtureDriver(fixture(false), "exerciseInterruption", mode));
}, 60_000);
it.each(["container-response", "container-owner-mismatch", "database-response"] as const)("cleans owned startup effects after %s", async mode => {
  await driverCompletion(fixtureDriver(fixture(false), "exerciseStartupLoss", mode));
}, 90_000);
it.each(["cleanup-inspect", "cleanup-remove", "cleanup-drop"] as const)("finishes actual owned cleanup despite group cancellation during %s", async mode => {
  await driverCompletion(fixtureDriver(fixture(false), "exerciseStartupLoss", mode));
}, 90_000);
it.each(["service-created", "proof-ready"] as const)("cleans its owned resources before releasing the root cancellation lock at %s", async stage => {
  await driverCompletion(fixtureDriver(fixture(false), "exerciseRootCancellation", stage));
}, 120_000);

it.each(["inspect-term", "remove-term", "remove-after-effect", "second-term", "cross-phase-term", "wrong-owner", "nonzero", "timeout", "deadline"] as const)("retains owned cleanup effects, refusal and original budget after %s", async mode => {
  await driverCompletion(fixtureDriver(fixture(false), "exerciseCleanupRecovery", mode));
}, 60_000);

it("keeps a denied process group present until its probe confirms absence", () => {
  const pid = 12345, outcomes = [undefined, "EPERM", "EPERM", "ESRCH"] as const;
  let calls = 0;
  const probe: typeof process.kill = (target, signal) => {
    assert.equal(target, -pid); assert.equal(signal, 0);
    const code = outcomes[calls++];
    if (code) throw Object.assign(new Error(code), { code });
    return true;
  };
  assert.deepEqual(outcomes.map(() => fixtureGroupExists(pid, probe)), [true, true, true, false]);
  assert.equal(calls, 4);
  const unexpected = Object.assign(new Error("Unexpected probe failure"), { code: "EINVAL" });
  assert.throws(() => fixtureGroupExists(pid, () => { throw unexpected; }), error => error === unexpected);
});

async function fixtureWait(ready: () => boolean, signal: AbortSignal | undefined, timeout: number, check?: () => void) {
  const deadline = performance.now() + timeout;
  while (!ready()) {
    if (signal?.aborted) throw new Error("Fixture interrupted");
    check?.();
    if (performance.now() >= deadline) throw new Error("Fixture deadline");
    await new Promise(done => setTimeout(done, 25));
  }
  if (signal?.aborted) throw new Error("Fixture interrupted");
}
function fixtureGroupExists(pid: number | undefined, probe = process.kill) {
  if (!pid) return false;
  try { probe(-pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // Darwin can retain a zombie-only group until reaping; EPERM never proves absence.
    if (code === "EPERM") return true;
    throw error;
  }
}
function fixtureRemoveService(identity: string, name: string, label: string, environment: NodeJS.ProcessEnv) {
  // A TERM may reach a child before detachment. Recover at most once in this
  // finite two-TERM fixture, without extending either original 10-second phase.
  let recovered = false;
  const run = (args: string[], deadline: number) => {
    const remaining = Math.floor(deadline - performance.now());
    assert.ok(remaining > 0, "Fixture cleanup operation deadline");
    const options: { env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number; detached: boolean } = {
      env: environment, encoding: "utf8", timeout: remaining, detached: true,
    };
    const result = spawnSync("docker", args, options);
    if (result.error) throw result.error;
    return result;
  };
  const terminated = (result: ReturnType<typeof run>) => result.status === null && result.signal === "SIGTERM" && result.error === undefined;
  const absent = (result: ReturnType<typeof run>) => result.status !== null && result.status !== 0
    && result.signal === null && result.error === undefined && result.stderr.toLowerCase().includes("no such object");
  const checked = (result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
    const info = JSON.parse(result.stdout)[0], separator = label.indexOf("=");
    assert.equal(info.Name, `/${name}`); assert.match(info.Id, /^[a-f0-9]{64}$/u);
    assert.equal(info.Config.Labels[label.slice(0, separator)], label.slice(separator + 1));
    return info;
  };
  const inspectDeadline = performance.now() + 10_000;
  let inspected = run(["inspect", identity], inspectDeadline);
  if (terminated(inspected)) { recovered = true; inspected = run(["inspect", identity], inspectDeadline); }
  if (absent(inspected)) return;
  const info = checked(inspected), removalDeadline = performance.now() + 10_000;
  let removed = run(["rm", "--force", info.Id], removalDeadline);
  if (!recovered && terminated(removed)) {
    recovered = true;
    const observed = run(["inspect", info.Id], removalDeadline);
    if (absent(observed)) return; // Actual Docker absence, never TERM-as-success.
    const current = checked(observed); assert.equal(current.Id, info.Id);
    removed = run(["rm", "--force", current.Id], removalDeadline);
  }
  assert.equal(removed.status, 0);
}
function fixturePublishJson(path: string, value: object) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

async function fixtureStopPoint(stage: string, identity: object, signal: AbortSignal) {
  if (env.OPENLUP_FIXTURE_CANCEL_STAGE === stage && env.OPENLUP_FIXTURE_WITNESS) {
    fixturePublishJson(env.OPENLUP_FIXTURE_WITNESS, identity);
    await fixtureWait(() => false, signal, 45_000);
  }
}

async function exerciseInterruption(mode: string, f: { target: string; packs: string }) {

  const owner = randomUUID(), name = `openlup-outbox-interruption-${owner}`;
  const environment = { ...env };
  delete environment.OPENLUP_PROOF_SERVICE_CONTAINER;
  delete environment.OPENLUP_PROOF_SERVICE_PORT;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", env: environment, timeout: 30_000 }).trim();
  const started = performance.now(), life = new AbortController(), interrupt = () => life.abort();
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  let attemptedService = false;
  let container: string | undefined, launcher: ReturnType<typeof spawn> | undefined;
  let proofPid: number | undefined, descendantPid: number | undefined;
  let stdout = "", stderr = "";
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
  let failure: unknown;
  try {
    attemptedService = true;
    container = docker(["run", "--detach", "--rm", "--name", name, "--label", `openlup-interruption-test=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
    await fixtureStopPoint("service-created", { id: container, name, label: `openlup-interruption-test=${owner}` }, life.signal);
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
    void completion.catch(() => {}); // Observe spawn errors until the readiness/teardown checks report them.
    launcher.stderr!.on("data", data => { stderr += data.toString(); });
    launcher.stdout!.on("data", data => {
      stdout += data.toString();
      const match = /HANGING_PROOF_READY (\{[^\n]+\})/.exec(stdout);
      if (match) { const identity = JSON.parse(match[1]); proofPid = identity.proof; descendantPid = identity.descendant; }
    });
    await fixtureWait(() => proofPid !== undefined, life.signal, 45_000, () => {
      if (launcher!.exitCode !== null || launcher!.signalCode !== null) throw new Error(`Launcher exited before proof readiness: ${stdout} ${stderr}`);
    });
    await fixtureStopPoint("proof-ready", { id: container, name, label: `openlup-interruption-test=${owner}`, proofPid, descendantPid }, life.signal);
    assert.ok((proofPid) > (0)); assert.ok((descendantPid) > (0));
    assert.equal(running(proofPid!), true); assert.equal(running(descendantPid!), true);
    const database = /database=(openlup_outbox_proof_[a-f0-9]{32})/u.exec(stdout)?.[1];
    assert.notEqual(database, undefined);
    const databaseCount = () => docker(["exec", container!, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", `select count(*) from pg_database where datname='${database}'`]);
    assert.equal(databaseCount(), "1");
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
    assert.notEqual(result.code, 0);
    assert.ok((stderr).includes("deadline/interruption")); assert.ok((stdout).includes("Owned PostgreSQL cleanup"));
    const goneDeadline = performance.now() + 3000;
    while ((running(proofPid!) || running(descendantPid!)) && performance.now() < goneDeadline) await new Promise(done => setTimeout(done, 25));
    assert.equal(running(proofPid!), false); assert.equal(running(descendantPid!), false);
    assert.equal(JSON.parse(docker(["inspect", container]))[0].State.Running, true);
    assert.equal(databaseCount(), "0");
    process.stdout.write(`Owned service ${container} ${mode} interruption: startup ${Math.round(interrupted - started)} ms, signal/group/database cleanup ${Math.round(performance.now() - interrupted)} ms\n`);
  } catch (error) { failure = error; } finally {
    const cleanupErrors: unknown[] = [];
    const stop = () => { if (launcher?.pid) { try { if (mode === "direct") launcher.kill("SIGTERM"); else process.kill(-launcher.pid, "SIGTERM"); } catch { /* Already stopped. */ } } };
    stop(); // The child cleans its proof in parallel with our service teardown.
    try { if (attemptedService) fixtureRemoveService(container ?? name, name, `openlup-interruption-test=${owner}`, env); } catch (error) { cleanupErrors.push(error); }
    try {
      await fixtureWait(() => !launcher || (launcher.exitCode !== null || launcher.signalCode !== null), undefined, 32_000);
    } catch (error) {
      if (launcher?.pid) { try { if (mode === "direct") launcher.kill("SIGKILL"); else process.kill(-launcher.pid, "SIGKILL"); } catch { /* Already stopped. */ } }
      cleanupErrors.push(error);
    }
    for (const pid of [proofPid, descendantPid]) if (pid && running(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
    try { await fixtureWait(() => [proofPid, descendantPid].every(pid => !pid || !running(pid)), undefined, 2000); } catch (error) { cleanupErrors.push(error); }
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
    if (cleanupErrors.length) failure = new AggregateError([failure, ...cleanupErrors].filter(Boolean), "Fixture and cleanup failed");
  }
  if (failure) throw failure;
}

async function exerciseStartupLoss(mode: string, f: { target: string; packs: string }) {

  const environment = { ...env }, realDocker = execFileSync("which", ["docker"], { env, encoding: "utf8" }).trim();
  delete environment.OPENLUP_PROOF_SERVICE_CONTAINER; delete environment.OPENLUP_PROOF_SERVICE_PORT;
  const docker = (args: string[]) => spawnSync(realDocker, args, { env: environment, encoding: "utf8", timeout: 30_000 });
  const effect = join(f.target, "effect.json"), attempted = join(f.target, "attempted.json"), tools = join(f.target, "tools"); mkdirSync(tools);
  const shim = join(tools, "docker"), cleanupMode = mode.startsWith("cleanup-");
  if (cleanupMode) writeFileSync(join(f.target, "scripts/packages/outbox-consumer-proof.ts"), 'console.log("SYNTHETIC_PROCESS_FINISHED");\n');
  writeFileSync(shim, `#!${process.execPath}
` + [
    'import { spawnSync } from "node:child_process";',
    'import { readFileSync, writeFileSync, renameSync } from "node:fs";',
    'import { argv } from "node:process";',
    'const args = argv.slice(2);',
    'const publish = (path, value) => { writeFileSync(path + ".tmp", JSON.stringify(value)); renameSync(path + ".tmp", path); };',
    `const mode = ${JSON.stringify(mode)}, effect = ${JSON.stringify(effect)}, attempted = ${JSON.stringify(attempted)};`,
    'const create = args.at(-1)?.match(/^CREATE DATABASE (openlup_outbox_proof_[a-f0-9]{32})$/);',
    'const cleanup = mode.startsWith("cleanup-");',
    'const drop = args.at(-1)?.match(/^DROP DATABASE IF EXISTS (openlup_outbox_proof_[a-f0-9]{32}) WITH [(]FORCE[)]$/);',
    'const cleanupStep = cleanup && ((mode === "cleanup-inspect" && args[0] === "inspect") || (mode === "cleanup-remove" && args[0] === "rm") || (mode === "cleanup-drop" && Boolean(drop)));',
    'const intercepted = !cleanup && ((args[0] === "run" && mode !== "database-response") || Boolean(create && mode === "database-response"));',
    'const name = args[args.indexOf("--name") + 1], labelAt = args.indexOf("--label");',
    'if (intercepted && mode === "container-owner-mismatch") args[labelAt + 1] += "-different-owner";',
    'const record = { name, label: args[labelAt + 1], database: create?.[1] };',
    'if (intercepted || (cleanup && args[0] === "run")) publish(attempted, record);',
    'if (cleanupStep) {',
    ' const owned = mode === "cleanup-drop" ? {database: drop[1]} : JSON.parse(readFileSync(attempted, "utf8"));',
    ' process.on("SIGTERM", () => process.exit(143));',
    ' publish(effect, {...owned, id: args[0] === "rm" ? args.at(-1) : args[1]});',
    ' await new Promise(done => setTimeout(done, 800));',
    '}',
    `const result = spawnSync(${JSON.stringify(realDocker)}, args, { encoding: "utf8", timeout: 30000 });`,
    'if (intercepted && result.status === 0) {',
    ' publish(effect, { ...record, id: result.stdout.trim() });',
    ' process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 1000);',
    '} else { process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1); }',
  ].join("\n")); chmodSync(shim, 0o700);
  const owner = randomUUID(), serviceName = `openlup-startup-loss-${owner}`;
  const life = new AbortController(), interrupt = () => life.abort();
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  let attemptedService = false;
  let service: string | undefined, launcher: ReturnType<typeof spawn> | undefined, stdout = "", stderr = "";
  let failure: unknown;
  try {
    const supplied: NodeJS.ProcessEnv = { ...environment, PATH: `${tools}:${environment.PATH}`, OPENLUP_PACK_MANIFEST: join(f.packs, "packages-manifest.json"), OPENLUP_PACK_COMMIT: commit };
    if (mode === "database-response" || mode === "cleanup-drop") {
      attemptedService = true;
      const started = docker(["run", "--detach", "--rm", "--name", serviceName, "--label", `openlup-startup-test=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
      assert.equal(started.status, 0); service = started.stdout.trim();
      const readyDeadline = performance.now() + 30_000;
      while (!life.signal.aborted && docker(["exec", service, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-t", "1"]).status !== 0) { if (performance.now() >= readyDeadline) throw new Error("Owned test service startup deadline"); await new Promise(done => setTimeout(done, 100)); }
      if (life.signal.aborted) throw new Error("Fixture interrupted");
      assert.equal(docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE openlup_outbox_proof"]).status, 0);
      supplied.OPENLUP_PROOF_SERVICE_CONTAINER = service; supplied.OPENLUP_PROOF_SERVICE_PORT = docker(["port", service, "5432/tcp"]).stdout.trim().split(":").at(-1)!;
    }
    launcher = spawn("npm", ["--workspace", "./packages/outbox", "run", "ci:required"], { cwd: f.target, env: supplied, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    launcher.stdout!.on("data", bytes => { stdout += bytes.toString(); }); launcher.stderr!.on("data", bytes => { stderr += bytes.toString(); });
    const completion = new Promise<number | null>((done, fail) => { launcher!.once("error", fail); launcher!.once("close", code => done(code)); });
    void completion.catch(() => {});
    const startupDeadline = performance.now() + 45_000;
    while (!existsSync(effect) && !life.signal.aborted) { if (launcher.exitCode !== null || performance.now() >= startupDeadline) throw new Error(`Lost response setup: ${stdout} ${stderr}`); await new Promise(done => setTimeout(done, 25)); }
    if (life.signal.aborted) throw new Error("Fixture interrupted");
    const observed = JSON.parse(readFileSync(effect, "utf8"));
    if (!service) { const info = JSON.parse(docker(["inspect", observed.id]).stdout)[0]; assert.equal(info.Name, `/${observed.name}`); assert.equal(info.Config.Labels["openlup-proof"], observed.label.slice("openlup-proof=".length)); assert.equal(info.State.Running, true); }
    process.kill(-launcher.pid!, "SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([completion, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`Lost response cleanup deadline: ${stdout} ${stderr}`)), 10_000); })]);
      if (!cleanupMode) assert.notEqual(result, 0);
    } finally { if (timer) clearTimeout(timer); }
    assert.ok((stdout).includes("Owned PostgreSQL cleanup"));
    if (service) {
      const remaining = docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", `select datname from pg_database where datname in ('${observed.database}', 'openlup_outbox_proof') order by datname`]);
      assert.equal(remaining.status, 0); assert.equal(remaining.stdout.trim(), "openlup_outbox_proof"); assert.equal(JSON.parse(docker(["inspect", service]).stdout)[0].State.Running, true);
    } else if (mode === "container-owner-mismatch") {
      assert.ok((stderr).includes("Container cleanup ownership mismatch")); assert.equal(JSON.parse(docker(["inspect", observed.id]).stdout)[0].State.Running, true);
    } else assert.notEqual(docker(["inspect", observed.id]).status, 0);
    if (!cleanupMode) assert.ok(!(stdout).includes("Packed proof process"));
    else assert.ok(stdout.includes("SYNTHETIC_PROCESS_FINISHED"));
  } catch (error) { failure = error; } finally {
    const cleanupErrors: unknown[] = [];
    if (launcher?.pid) { try { process.kill(-launcher.pid, "SIGTERM"); } catch { /* Already stopped. */ } }
    try { if (attemptedService) fixtureRemoveService(service ?? serviceName, serviceName, `openlup-startup-test=${owner}`, environment); } catch (error) { cleanupErrors.push(error); }
    try { await fixtureWait(() => !launcher || (launcher.exitCode !== null || launcher.signalCode !== null), undefined, 32_000); }
    catch (error) { if (launcher?.pid) { try { process.kill(-launcher.pid, "SIGKILL"); } catch { /* Already stopped. */ } } cleanupErrors.push(error); }
    try {
      if (!service && existsSync(attempted)) { const observed = JSON.parse(readFileSync(attempted, "utf8")); fixtureRemoveService(observed.name, observed.name, observed.label, environment); }
    } catch (error) { cleanupErrors.push(error); }
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
    if (cleanupErrors.length) failure = new AggregateError([failure, ...cleanupErrors].filter(Boolean), "Fixture and cleanup failed");
  }
  if (failure) throw failure;
}

async function exerciseCleanupRecovery(mode: string, f: { target: string; packs: string }) {
  const owner = randomUUID(), name = `openlup-cleanup-recovery-${owner}`, label = `openlup-cleanup-recovery=${owner}`;
  const realDocker = execFileSync("which", ["docker"], { env, encoding: "utf8" }).trim();
  const environment = { ...env }; delete environment.OPENLUP_PROOF_SERVICE_CONTAINER; delete environment.OPENLUP_PROOF_SERVICE_PORT;
  const tools = join(f.target, "cleanup-tools"), calls = join(f.target, "cleanup-calls.json"); mkdirSync(tools);
  const shim = join(tools, "docker");
  writeFileSync(shim, `#!${process.execPath}\n` + [
    'import {spawnSync} from "node:child_process";',
    'import {existsSync,readFileSync,writeFileSync,renameSync} from "node:fs";',
    'import {argv} from "node:process";',
    `const mode=${JSON.stringify(mode)}, marker=${JSON.stringify(calls)}, docker=${JSON.stringify(realDocker)};`,
    'const args=argv.slice(2), calls=existsSync(marker)?JSON.parse(readFileSync(marker,"utf8")):[];',
    'calls.push(args[0]); writeFileSync(marker+".tmp",JSON.stringify(calls)); renameSync(marker+".tmp",marker);',
    'const count=calls.length;',
    'const term=()=>process.kill(process.pid,"SIGTERM");',
    'if ((mode==="inspect-term" && count===1) || (mode==="second-term" && count<=2) || (mode==="cross-phase-term" && (count===1 || count===3)) || ((mode==="remove-term" || mode==="wrong-owner") && count===2)) term();',
    'else if (mode==="nonzero" && count===1) {process.stderr.write("FIXTURE_INSPECT_REFUSAL");process.exit(2);}',
    'else if (mode==="timeout" && count===1) setInterval(()=>{},1000);',
    'else if (mode==="deadline" && count===1) setTimeout(term,4000);',
    'else if (mode==="deadline" && count===2) setInterval(()=>{},1000);',
    'else {',
    ' const result=spawnSync(docker,args,{encoding:"utf8",timeout:10000});',
    ' if(result.error)throw result.error;',
    ' if(mode==="remove-after-effect" && count===2){if(result.status!==0)throw new Error("Fixture removal setup failed");term();}',
    ' else if(mode==="wrong-owner" && count===3){if(result.status!==0)throw new Error("Fixture inspect setup failed");const info=JSON.parse(result.stdout);info[0].Config.Labels["openlup-cleanup-recovery"]="not-the-owner";process.stdout.write(JSON.stringify(info));}',
    ' else {process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);}',
    '}',
  ].join("\n")); chmodSync(shim, 0o755);
  const supplied = { ...environment, PATH: `${tools}:${environment.PATH}` };
  const life = new AbortController(), interrupt = () => life.abort();
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  let container: string | undefined, attempted = false, failure: unknown;
  try {
    attempted = true;
    container = execFileSync(realDocker, ["run", "--detach", "--rm", "--name", name, "--label", label, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE], { env: environment, encoding: "utf8", timeout: 30_000 }).trim();
    if (life.signal.aborted) throw new Error("Fixture interrupted");
    let refused: unknown; const started = performance.now();
    try { fixtureRemoveService(container, name, label, supplied); } catch (error) { refused = error; }
    const elapsed = performance.now() - started;
    const observed = JSON.parse(readFileSync(calls, "utf8"));
    const expected: Record<string, string[]> = {
      "inspect-term": ["inspect", "inspect", "rm"], "remove-term": ["inspect", "rm", "inspect", "rm"],
      "remove-after-effect": ["inspect", "rm", "inspect"], "second-term": ["inspect", "inspect"], "cross-phase-term": ["inspect", "inspect", "rm"],
      "wrong-owner": ["inspect", "rm", "inspect"], "nonzero": ["inspect"], "timeout": ["inspect"], "deadline": ["inspect", "inspect"],
    };
    assert.deepEqual(observed, expected[mode]);
    const positive = ["inspect-term", "remove-term", "remove-after-effect"].includes(mode);
    if (positive) assert.equal(refused, undefined); else assert.ok(refused);
    if (mode === "timeout" || mode === "deadline") { assert.equal((refused as NodeJS.ErrnoException).code, "ETIMEDOUT"); assert.ok(elapsed < 13_000, "Original 10-second operation budget was reset"); }
    const residual = spawnSync(realDocker, ["inspect", container], { env: environment, encoding: "utf8", timeout: 30_000 });
    assert.equal(residual.status === 0, !positive);
    if (positive) assert.ok(residual.stderr.toLowerCase().includes("no such object"));
  } catch (error) { failure = error; } finally {
    try { if (attempted) fixtureRemoveService(container ?? name, name, label, environment); }
    catch (error) { failure = new AggregateError([failure, error].filter(Boolean), "Recovery fixture and cleanup failed"); }
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
  }
  if (failure) throw failure;
}

async function exerciseRootCancellation(stage: string, f: { target: string; packs: string }) {
  const witness = join(f.target, "root-witness.json"), lock = join(f.target, "root-verify.lock"); mkdirSync(lock);
  const life = new AbortController(), interrupt = () => life.abort();
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  const child = spawn(process.execPath, [join(root, "scripts/run-vitest.mjs"), "run", "scripts/packages/outbox-consumer-proof.test.ts", "-t", "handles repeated interruption through package-group,"], {
    cwd: root, env: { ...env, VITEST_MAX_WORKERS: "1", OPENLUP_FIXTURE_CANCEL_STAGE: stage, OPENLUP_FIXTURE_WITNESS: witness }, detached: true, stdio: "ignore",
  });
  let spawnError: Error | undefined; child.once("error", error => { spawnError = error; });
  const groupExists = () => fixtureGroupExists(child.pid);
  let groupDeadline: number | undefined;
  const stop = () => { groupDeadline ??= performance.now() + 60_000; if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ } } };
  const waitForGroup = () => fixtureWait(() => !groupExists(), undefined, Math.max(1, groupDeadline! - performance.now()));
  let observed: { id: string; name: string; label: string; proofPid?: number; descendantPid?: number } | undefined;
  let failure: unknown;
  try {
    await fixtureWait(() => existsSync(witness), life.signal, 45_000, () => { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode !== null) throw new Error("Nested Vitest exited before witness"); });
    observed = JSON.parse(readFileSync(witness, "utf8"));
    stop(); await new Promise(done => setTimeout(done, 50)); stop();
    // This follows the verifier's group-liveness contract, without a real stamp
    // or shared lock. The resource owner must remain in that group until cleanup.
    await waitForGroup();
    rmSync(lock, { recursive: true });
    assert.equal(spawnSync("docker", ["inspect", observed!.id], { env, encoding: "utf8", timeout: 30_000 }).status === 0, false, "Root cancellation leaked fixture service");
    for (const pid of [observed!.proofPid, observed!.descendantPid]) if (pid) { assert.throws(() => process.kill(pid, 0), /ESRCH/u); }
    assert.equal(existsSync(lock), false);
  } catch (error) { failure = error; } finally {
    const cleanupErrors: unknown[] = [];
    stop();
    try { await waitForGroup(); }
    catch (error) {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ } }
      try { await fixtureWait(() => !groupExists(), undefined, 2000); } catch (stopError) { cleanupErrors.push(stopError); }
      cleanupErrors.push(error);
    }
    try {
      if (!observed && existsSync(witness)) observed = JSON.parse(readFileSync(witness, "utf8"));
      if (observed) fixtureRemoveService(observed.id, observed.name, observed.label, env);
    } catch (error) { cleanupErrors.push(error); }
    if (!groupExists()) rmSync(lock, { recursive: true, force: true });
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
    if (cleanupErrors.length) failure = new AggregateError([failure, ...cleanupErrors].filter(Boolean), "Root fixture and cleanup failed");
  }
  if (failure) throw failure;
}
// End standalone fixture functions.
