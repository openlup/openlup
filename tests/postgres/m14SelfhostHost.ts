// Synthetic local or declared hosted composition of existing Node/HTTP, scheduler, outbox, blob and captured delivery seams.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { reservePort } from "../helpers/postgresContainer.js";

export async function runSelfhostHost(input: { image: string; database: { connectionString: string; ca: string }; hosted?: { origin: string; certificatePath: string; keyPath: string } }) {
  const started = performance.now();
  let dockerActions = 0;
  const hosted = input.hosted;
  const claim = hosted ? "hosted Node/OCI recipe receipt (single synthetic VM)" : "local self-host recipe receipt";
  const root = process.cwd(), owner = randomUUID(), label = "openlup.recipe-host.owner";
  const parent = resolve(".context/scratch/selfhost-receipt"); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(parent, "host-"));
  const data = join(scratch, "state"); mkdirSync(data, { mode: 0o700 });
  const docker = (args: string[]) => { dockerActions++; return execFileSync("docker", args, { encoding: "utf8", timeout: 120000,
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim(); };
  const inspect = (kind: "container" | "image", id: string) => JSON.parse(docker([kind, "inspect", id]))[0];
  const base = inspect("image", input.image); assert.equal(base.Id, input.image);
  const basePin = base.RepoDigests.find((value: string) => value.startsWith("node@sha256:") || value.startsWith("node:") || value.includes("library/node@sha256:"));
  assert(basePin, "Cached immutable Node repository digest required");
  const url = new URL(input.database.connectionString);
  assert(["127.0.0.1", "localhost"].includes(url.hostname), "Local host recipe requires a loopback database");
  const ssl = { ca: input.database.ca, rejectUnauthorized: true,
    checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(url.hostname, cert) };
  const bootstrap = new Pool({ connectionString: url.toString(), ssl });
  const login = `recipe_host_${randomBytes(8).toString("hex")}`, password = randomBytes(24).toString("hex");
  const events: string[] = [], images: string[] = [], containers: string[] = [];
  let roleCreated = false;
  let runtime: Pool | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let report: Record<string, unknown> | undefined;
  const cleanup: string[] = [];
  const owned = (kind: "container" | "image", id: string) => {
    const value = inspect(kind, id); assert.equal(value.Config.Labels[label], owner); return value;
  };
  const until = async (check: () => Promise<boolean> | boolean, reason: string, seconds = 30) => {
    const deadline = Date.now() + seconds * 1000;
    while (!await check()) { assert(Date.now() < deadline, reason); await delay(100); }
  };
  try {
    await bootstrap.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD '${password}'`);
    roleCreated = true;
    await bootstrap.query(`GRANT service_role TO ${login} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
    url.username = login; url.password = password;
    runtime = new Pool({ connectionString: url.toString(), ssl });
    assert.equal((await runtime.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false);
    const caPath = join(scratch, "ca.pem"); writeFileSync(caPath, input.database.ca, { mode: 0o600 });
    const insideUrl = new URL(url); if (!hosted) insideUrl.hostname = "host.docker.internal";
    const envPath = join(scratch, "runtime.env");
    writeFileSync(envPath, `DATABASE_URL=${insideUrl}\nRECIPE_TLS_SERVER_NAME=${new URL(input.database.connectionString).hostname}\nCRON_SECRET=${randomBytes(24).toString("hex")}\n${hosted ? "RECIPE_HTTPS=true\n" : ""}PLATFORM_BUNDLE=node-postgres\nPLATFORM_BLOB=filesystem\nBLOB_FS_ROOT=/state\nBLOB_FS_BASE_URL=http://localhost:8080/storage\nAPP_BASE_URL=http://localhost:8080\n`, { mode: 0o600 });
    const bundle = join(scratch, "app.mjs");
    await build({ entryPoints: [join(root, "tests/postgres/fixtures/m14SelfhostActor.ts")], outfile: bundle,
      bundle: true, platform: "node", format: "esm", target: "node24", external: ["pg-native"],
      banner: { js: "import { createRequire as recipeCreateRequire } from 'node:module'; const require = recipeCreateRequire(import.meta.url);" } });
    for (const release of ["A", "B"]) {
      const context = join(scratch, release); mkdirSync(context);
      copyFileSync(bundle, join(context, "app.mjs")); writeFileSync(join(context, "release"), release);
      writeFileSync(join(context, "Dockerfile"), `FROM ${basePin}\nLABEL ${label}="${owner}"\nWORKDIR /app\nCOPY app.mjs release ./\nCMD ["node","/app/app.mjs"]\n`);
      const id = docker(["build", "--pull=false", "--network=none", "--quiet", context]);
      assert.match(id, /^sha256:[a-f0-9]{64}$/u); images.push(id); owned("image", id);
    }
    assert.notEqual(images[0], images[1], "A and B must be distinct immutable application images");
    browser = await chromium.launch({ headless: true });
    let launchCount = 0;
    const deploymentStarted = performance.now();
    let deploymentSeconds = 0;
    const observed: { release: string; image: string; node: string; processed: number; mail: number }[] = [];
    const launch = async (index: number) => {
      const port = hosted ? 443 : await reservePort();
      const id = docker(["run", "--detach", "--pull=never", "--label", `${label}=${owner}`,
        ...(hosted ? ["--name", `m14-10h-host-${owner}-${++launchCount}`, "--network", "host", "--cap-add", "NET_BIND_SERVICE"] : []),
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--env-file", envPath,
        "--mount", `type=bind,source=${data},target=/state`, "--mount", `type=bind,source=${caPath},target=/run/ca.pem,readonly`,
        ...(hosted ? ["--mount", `type=bind,source=${hosted.certificatePath},target=/run/host-cert.pem,readonly`,
          "--mount", `type=bind,source=${hosted.keyPath},target=/run/host-key.pem,readonly`] : ["--publish", `127.0.0.1:${port}:8080`]), images[index]]);
      assert.match(id, /^[a-f0-9]{64}$/u); containers.push(id);
      assert.equal(owned("container", id).Image, images[index]);
      const origin = hosted?.origin ?? `http://127.0.0.1:${port}`;
      const state = async () => { const response = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(2000) }); assert(response.ok); return response.json(); };
      await until(async () => {
        if (!owned("container", id).State.Running) {
          const logs = spawnSync("docker", ["logs", id], { encoding: "utf8", timeout: 30000 });
          const diagnostic = (logs.stdout + logs.stderr).replaceAll(password, "[redacted]").replaceAll(url.toString(), "[redacted]");
          writeFileSync(join(parent, "host-start-refusal.log"), diagnostic, { mode: 0o600 });
          throw new Error("Node fixture exited; inspect private redacted start diagnostic");
        }
        try { await state(); return true; } catch { return false; }
      }, "Node fixture did not start");
      if (hosted) assert.equal(owned("container", id).HostConfig.NetworkMode, "host");
      else assert.deepEqual(owned("container", id).NetworkSettings.Ports["8080/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
      return { id, origin, state };
    };
    const stop = async (id: string) => { owned("container", id); docker(["kill", "--signal=TERM", id]);
      await until(() => !owned("container", id).State.Running, "Node fixture did not drain");
      assert.equal(owned("container", id).State.ExitCode, 0); };
    const enqueue = async () => {
      const id = randomUUID();
      await runtime!.query("INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,'recipe',$2,'recipe.delivery',$3,'{}')", [id, randomUUID(), `recipe:${owner}:${id}`]);
      events.push(id); return id;
    };
    const readUi = async (host: Awaited<ReturnType<typeof launch>>, release: string, processed: number) => {
      const value = await host.state(); assert.equal(value.release, release); assert.equal(value.node, "v24.21.0");
      assert.equal(value.login, login); assert.equal(value.storage, "durable local recipe bytes");
      assert.equal(value.events.filter((row: { status: string }) => row.status === "processed").length, processed);
      assert.equal(value.mail, processed);
      const page = await browser!.newPage();
      try { await page.goto(host.origin); await page.locator("#refresh").click();
        await page.waitForFunction(expected => { const value = document.querySelector("#state")?.textContent; return value ? JSON.parse(value).release === expected : false; }, release);
        const ui = JSON.parse((await page.locator("#state").textContent())!); assert.deepEqual(ui, value);
      } finally { await page.close(); }
      observed.push({ release, image: owned("container", host.id).Image, node: value.node, processed, mail: value.mail });
    };
    const a = await launch(0); await enqueue();
    const immediate = await (await fetch(`${a.origin}/api/dispatch`)).json(); assert.equal(immediate.processed, 1);
    await readUi(a, "A", 1); deploymentSeconds = (performance.now() - deploymentStarted) / 1000;
    const scheduled = await enqueue();
    await stop(a.id); // Queued work remains in the database while this host is absent.
    assert.equal((await runtime.query("SELECT status FROM public.outbox_events WHERE id=$1", [scheduled])).rows[0].status, "pending");
    const restarted = await launch(0); writeFileSync(join(data, "schedule"), "enabled");
    await until(async () => (await restarted.state()).mail === 2, "Durable scheduled work was not recovered after restart");
    await readUi(restarted, "A", 2);
    writeFileSync(join(data, "hold"), "hold admitted callback"); await enqueue();
    await until(() => existsSync(join(data, "entered")), "No callback admitted for drain proof");
    const swapStarted = performance.now();
    owned("container", restarted.id); docker(["kill", "--signal=TERM", restarted.id]);
    assert.equal(owned("container", restarted.id).State.Running, true);
    assert.equal((await restarted.state()).release, "A", "Listener must remain available while callback drains");
    rmSync(join(data, "hold"));
    await until(() => !owned("container", restarted.id).State.Running, "Admitted callback did not drain");
    assert.equal(owned("container", restarted.id).State.ExitCode, 0);
    const b = await launch(1); await enqueue();
    await until(async () => (await b.state()).mail === 4, "B did not read/recover durable work");
    await readUi(b, "B", 4); await stop(b.id);
    const rollback = await launch(0); await readUi(rollback, "A", 4);
    await delay(1200); await readUi(rollback, "A", 4); await stop(rollback.id);
    report = { status: "PASS", claim, tls: hosted ? "public CA and hostname verified by Node fetch and Chromium" : "local HTTP", deploymentSeconds, images: { base: input.image, A: images[0], B: images[1] },
      bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"), observed,
      immediate: true, durableScheduledAfterRestart: true, admittedCallbackDrained: true, rollback: "A→B→A",
      hostSwapSeconds: (performance.now() - swapStarted) / 1000,
      storage: "retained across restart and both code swaps", capturedDeliveries: 4, duplicateDeliveries: 0,
      limits: ["finite synthetic application composed from public host seams", "captured delivery commands; no live email provider", "preinstalled declared local TLS PostgreSQL; no production host qualification", ...(hosted ? ["single synthetic VM; no availability SLO", "operator owns database, certificates and external file teardown"] : [])], hostedQualification: false };
  } finally {
    try { await browser?.close(); } catch { cleanup.push("browser"); }
    for (const id of containers.reverse()) try { owned("container", id); docker(["rm", "--force", "--volumes", id]);
      assert.equal(docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`]), ""); } catch { cleanup.push("container"); }
    for (const id of images.reverse()) try { owned("image", id); docker(["image", "rm", id]); } catch { cleanup.push("image"); }
    try { assert.equal(docker(["image", "ls", "--quiet", "--filter", `label=${label}=${owner}`]), ""); } catch { cleanup.push("image-absence"); }
    try { await runtime?.end(); } catch { cleanup.push("runtime-pool"); }
    try { if (events.length) await bootstrap.query("DELETE FROM public.outbox_events WHERE id=ANY($1::uuid[]) AND event_type='recipe.delivery'", [events]);
      if (roleCreated) { await bootstrap.query(`REVOKE service_role FROM ${login}`); await bootstrap.query(`DROP ROLE ${login}`); }
      assert.equal((await bootstrap.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1", [login])).rows[0].n, 0);
      if (events.length) assert.equal((await bootstrap.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE id=ANY($1::uuid[])", [events])).rows[0].n, 0);
    } catch { cleanup.push("database-fixture"); }
    await bootstrap.end();
    if (!cleanup.length) { rmSync(scratch, { recursive: true }); assert.equal(existsSync(scratch), false); }
    assert.deepEqual(cleanup, [], "Owned Node recipe cleanup failed; private scratch retained");
  }
  assert(report);
  return { ...report, wallSeconds: (performance.now() - started) / 1000, actions: { dockerCommands: dockerActions, imageBuilds: 2, queuedEvents: 4, uiReadbacks: 5 },
    cleanup: { status: "PASS", containersAbsent: true, imagesRemoved: true, rolesAbsent: true, eventsAbsent: true, privateDirectoryAbsent: true } };
}
