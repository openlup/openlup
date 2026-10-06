/** Own only this proof's disposable database/container, never an ambient service. */
import { env as processEnvironment } from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedConsumerEnv, readCurrentPackManifest } from "./pack-manifest-input.ts";

export const POSTGRES_PROOF_IMAGE = "postgres:17@sha256:ae69c452f483507a6b99fb654cf93aad7fe156ffd2c56247707eef4e36d3c12b";
const deadlineMs = 180_000;
const docker = (args: string[], timeout = 30_000): string => execFileSync("docker", args, { encoding: "utf8", timeout, env: isolatedConsumerEnv() }).trim();

function proof(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolveProof, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: isolatedConsumerEnv(), detached: true });
    let expired = false, killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (expired) return;
      expired = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* An exited group needs no signal. */ }
        killTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ } }, 1000);
      }
    };
    const timer = setTimeout(stop, deadlineMs);
    signal.addEventListener("abort", stop, { once: true });
    const finish = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener("abort", stop); };
    child.once("error", (error) => { finish(); reject(error); });
    child.once("exit", (code, stopped) => {
      if (expired && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* No surviving children. */ } }
      finish();
      if (expired || code !== 0) reject(new Error(`outbox proof ${expired ? "deadline/interruption" : `exit ${code ?? stopped}`}`)); else resolveProof();
    });
    if (signal.aborted) stop();
  });
}

export async function runDisposablePostgres(args: readonly string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--manifest", "--expected-commit", "--service-container", "--service-port"].includes(key) || !value || options.has(key)) throw new Error("Use --manifest/--expected-commit, optionally both trusted job service identity/port inputs");
    options.set(key, value);
  }
  if (options.has("--manifest") !== options.has("--expected-commit") || options.has("--service-container") !== options.has("--service-port")) throw new Error("Supply both artifact inputs and both optional service inputs");
  const manifest = options.get("--manifest") ?? processEnvironment.OPENLUP_PACK_MANIFEST, commit = options.get("--expected-commit") ?? processEnvironment.OPENLUP_PACK_COMMIT;
  const service = options.get("--service-container") ?? processEnvironment.OPENLUP_PROOF_SERVICE_CONTAINER, port = options.get("--service-port") ?? processEnvironment.OPENLUP_PROOF_SERVICE_PORT;
  if (!manifest || !commit || !/^[a-f0-9]{40}$/u.test(commit) || Boolean(service) !== Boolean(port) || (service && (!/^[a-f0-9]{12,64}$/u.test(service) || !/^\d{1,5}$/u.test(port!) || Number(port) < 1 || Number(port) > 65535))) throw new Error("Missing or malformed artifact/job-service identity");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), scratchParent = join(root, ".context", "scratch");
  readCurrentPackManifest(root, resolve(manifest), commit); // Refuse before install, SQL or service startup.
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "owned-postgres-"));
  const owner = randomUUID(), name = `openlup-outbox-proof-${owner}`, database = `openlup_outbox_proof_${owner.replaceAll("-", "")}`;
  const controller = new AbortController(), interrupt = () => controller.abort();
  // npm and the package wrapper may forward the same group signal. Keep the
  // idempotent abort handler installed until owned cleanup has finished.
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  let container: string | undefined, attemptedContainer = false, attemptedDatabase = false, failure: unknown;
  const started = performance.now();
  try {
    if (service) {
      // Identity comes from job.services, not an ambient port/URL. Require the pinned image.
      const info = JSON.parse(docker(["inspect", service]))[0];
      if (info?.Id !== service || info?.Config?.Image !== POSTGRES_PROOF_IMAGE || !info?.State?.Running || !info?.NetworkSettings?.Ports?.["5432/tcp"]?.some((binding: { HostPort: string }) => binding.HostPort === port)) throw new Error("Job service is not the exact pinned running container/port");
      container = service;
    } else {
      // Creation can succeed even when its response is interrupted. The known
      // unique name and owner label remain sufficient for checked cleanup.
      attemptedContainer = true;
      container = docker(["run", "--detach", "--rm", "--name", name, "--label", `openlup-proof=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
    }
    let ready = false;
    const startupDeadline = performance.now() + 30_000;
    while (performance.now() < startupDeadline && !controller.signal.aborted) {
      try { docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-t", "1"], 3000); ready = true; break; } catch { await new Promise((done) => setTimeout(done, 1000)); }
    }
    if (!ready || controller.signal.aborted) throw new Error("Owned PostgreSQL startup failed/interrupted");
    const mapped = port ?? docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
    attemptedDatabase = true; // Only this run's unique name, including a lost CREATE response.
    docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${database}`]);
    console.log(`Owned PostgreSQL ready in ${Math.round(performance.now() - started)} ms; ${POSTGRES_PROOF_IMAGE}; database=${database}`);
    const proofStarted = performance.now();
    try { await proof(["--experimental-strip-types", join(root, "scripts/packages/outbox-consumer-proof.ts"), `postgresql://postgres@127.0.0.1:${mapped}/${database}`, scratch, "--manifest", resolve(manifest), "--expected-commit", commit], controller.signal); }
    finally { console.log(`Packed proof process ${Math.round(performance.now() - proofStarted)} ms`); }
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = performance.now();
    try {
      if (service && attemptedDatabase) docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
      if (!service && attemptedContainer) {
        const info = JSON.parse(docker(["inspect", container ?? name]))[0];
        if (info?.Name !== `/${name}` || info?.Config?.Labels?.["openlup-proof"] !== owner || !/^[a-f0-9]{64}$/u.test(info?.Id ?? "") || (container && info.Id !== container)) failure = new AggregateError([failure, new Error("Container cleanup ownership mismatch")].filter(Boolean), "Owned PostgreSQL failure");
        else docker(["rm", "--force", info.Id]);
      }
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Proof and cleanup failed") : error;
    } finally {
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      console.log(`Owned PostgreSQL cleanup ${Math.round(performance.now() - cleanup)} ms`);
    }
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await runDisposablePostgres(process.argv.slice(2));
