import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const files = ["config/openlup-packages.json", "packages/core/package.json", "packages/outbox/package.json", "server/runtime/outbox/referenceContribution.ts", "server/runtime/outbox/candidateAdmission.ts", "packages/outbox/smoke/wiring.ts", "packages/outbox/smoke/schemaProof.ts", "scripts/packages/schema-budget-proof.mjs", ...["outbox-consumer-proof", "outbox-disposable-postgres", "pack-manifest-input", "package-manifest-policy"].map(name => `scripts/packages/${name}.ts`)];
  for (const file of files) { mkdirSync(dirname(join(target, file)), { recursive: true }); cpSync(join(root, file), join(target, file)); }
  writeFileSync(join(target, "package.json"), '{"type":"module"}\n'); mkdirSync(join(target, "node_modules"));
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

it("interrupts the actual proof group, drops only its database and preserves the owned service", async () => {
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
    launcher = spawn(process.execPath, ["--experimental-strip-types", join(f.target, "scripts/packages/outbox-disposable-postgres.ts"), "--manifest", join(f.packs, "packages-manifest.json"), "--expected-commit", commit, "--service-container", container, "--service-port", port], { cwd: f.target, env: environment, stdio: ["ignore", "pipe", "pipe"] });
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
    const databaseCount = () => docker(["exec", container!, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select count(*) from pg_database where datname='openlup_outbox_proof'"]);
    expect(databaseCount()).toBe("1");
    const interrupted = performance.now();
    launcher.kill("SIGTERM");
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
    process.stdout.write(`Owned service ${container} interruption: startup ${Math.round(interrupted - started)} ms, signal/group/database cleanup ${Math.round(performance.now() - interrupted)} ms\n`);
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
