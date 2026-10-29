import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pullWithRetry, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { disposableLabelArgs, sweep } from "../../scripts/disposable-docker.mjs";
import { defaultPostgresImage, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const exec = promisify(execFile);
const docker = async (args: string[]) => (await exec("docker", args, { timeout: 30_000, killSignal: "SIGKILL" })).stdout.trim();
const scope = `openlup.reap.witness=${randomUUID()}`, selectorArgs = ["--label", scope];
const ids = new Set<string>(), names = new Set<string>(), children = new Set<ChildProcess>(), clients = new Map<ChildProcess, number>();
let available = false, image = defaultPostgresImage;
const inspect = async (id: string) => JSON.parse(await docker(["inspect", id]))[0];
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  const client = clients.get(child);
  if (client) { clients.delete(child); try { process.kill(client, "SIGKILL"); } catch { /* This owner's captured create proxy only. */ } }
}
async function owner(kind: "run" | "create") {
  const name = `openlup-reap-${randomUUID()}`; names.add(name);
  const source = `
    import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
    import {runPostgresContainer, waitForPostgresTcpReady} from './tests/helpers/postgresContainer.ts';
    import {disposableLabelArgs} from './scripts/disposable-docker.mjs';
    const exec=promisify(execFile), name=${JSON.stringify(name)}, scope=${JSON.stringify(scope)};
    if (${JSON.stringify(kind)} === 'run') {
      const c=await runPostgresContainer({name,password:'disposable',image:${JSON.stringify(image)},labels:{[scope.split('=')[0]]:scope.split('=')[1]}});
      if(!await waitForPostgresTcpReady(c.connectionString))throw Error('owner database not ready');
    } else {
      // Hold the successful create response so SIGKILL lands while the owner's
      // CLI call is still pending, after Docker has persisted Created state.
      const args=['create','--name',name,...disposableLabelArgs(),'--label',scope,'--tmpfs','/var/lib/postgresql/data',${JSON.stringify(image)}];
      const client=\`const {execFile}=require('node:child_process');execFile('docker',\${JSON.stringify(args)},{timeout:30000,killSignal:'SIGKILL'},(error,stdout)=>{if(error)process.exit(1);console.log(JSON.stringify({id:stdout.trim(),client:process.pid}));setInterval(()=>{},1000)});\`;
      const pending=exec(process.execPath,['-e',client],{timeout:30000,killSignal:'SIGKILL'});
      pending.child.stdout.on('data',data=>process.stdout.write(data));
      await pending;
    }
    const {stdout}=await exec('docker',['inspect',name],{timeout:30000,killSignal:'SIGKILL'});
    console.log(JSON.stringify({id:JSON.parse(stdout)[0].Id})); setInterval(()=>{},1000);
  `;
  const run = randomUUID();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, OPENLUP_DISPOSABLE_RUN: run }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const id = await new Promise<string>((resolve, reject) => {
    let out = "", err = "";
    const timer = setTimeout(() => reject(new Error(`owner startup timed out: ${err}`)), postgresSetupTimeoutMs - 30_000);
    const finish = () => { clearTimeout(timer); };
    child.stderr!.on("data", data => { err += data; });
    child.stdout!.on("data", data => {
      out += data;
      for (const line of out.split("\n")) {
        try { const value = JSON.parse(line); if (value.id) { if (value.client) clients.set(child, value.client); finish(); resolve(value.id); return; } } catch { /* Helper diagnostics share stdout. */ }
      }
    });
    child.once("error", error => { finish(); reject(error); });
    child.once("exit", code => { finish(); reject(new Error(`owner exited ${code}: ${err}`)); });
  });
  ids.add(id); return { child, id, run };
}
async function create(extra: string[], labelled = true) {
  const name = `openlup-reap-${randomUUID()}`; names.add(name);
  const id = await docker(["create", "--name", name, ...selectorArgs, ...(labelled ? disposableLabelArgs() : []), ...extra, "--tmpfs", "/var/lib/postgresql/data", image]);
  ids.add(id); return id;
}
beforeAll(async () => {
  available = await dockerAvailable();
  if (!available) process.stderr.write("SKIP disposable Docker reclaim real-daemon witnesses: Docker socket unavailable\n");
  else image = await pullWithRetry(readCiImage("test-postgres"));
}, postgresSetupTimeoutMs);
afterAll(async () => {
  await Promise.all([...children].map(stop));
  if (!available) return;
  // A lost create response still has this test's unique name; resolve to exact ID.
  for (const name of names) { try { ids.add((await inspect(name)).Id); } catch { /* Already removed. */ } }
  await Promise.all([...ids].map(id => docker(["rm", "-f", "-v", id]).catch(() => {})));
}, postgresTeardownTimeoutMs);

describe("real disposable Docker ownership", () => {
  for (const kind of ["run", "create"] as const) it(`reclaims a SIGKILLed ${kind} owner and proves the pre-sweep leak`, async context => {
    if (!available) { context.skip("Docker socket unavailable; real reclaim proof not executed"); return; }
    const { child, id } = await owner(kind);
    if (kind === "create") expect((await inspect(id)).State.Status).toBe("created");
    await stop(child);
    expect((await inspect(id)).Id).toBe(id); // SIGKILL alone leaves the base failure class.
    const report = await sweep({ mode: "report", selector: scope, minAgeSeconds: 0 });
    expect(report).toContainEqual(expect.objectContaining({ id, action: "would_remove", reason: "owner_gone" }));
    expect((await inspect(id)).Id).toBe(id);
    const result = await sweep({ mode: "remove", selector: scope, minAgeSeconds: 0 });
    expect(result).toContainEqual(expect.objectContaining({ id, action: "removed" }));
    await expect(inspect(id)).rejects.toThrow();
  }, postgresSetupTimeoutMs);
  it("preserves a live helper owner during a concurrent process sweep, plus unlabeled and foreign-host containers", async context => {
    if (!available) { context.skip("Docker socket unavailable; real reclaim proof not executed"); return; }
    const live = await owner("run");
    const unlabeled = await create([], false);
    const foreign = await create(["--label", "dev.disposable.host=foreign-reap-witness"]);
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `import {sweep} from './scripts/disposable-docker.mjs'; console.log(JSON.stringify(await sweep({mode:'remove',selector:${JSON.stringify(scope)},minAgeSeconds:0})));`], { timeout: 65_000, killSignal: "SIGKILL" });
    const result = JSON.parse(stdout.trim());
    expect(result).toContainEqual(expect.objectContaining({ id: live.id, decision: "keep", reason: "owner_alive" }));
    for (const id of [live.id, unlabeled, foreign]) expect((await inspect(id)).Id).toBe(id);
    await stop(live.child);
  }, postgresSetupTimeoutMs);
  it("keeps the live parent run when a separate nested run is reaped", async context => {
    if (!available) { context.skip("Docker socket unavailable; real reclaim proof not executed"); return; }
    const parent = await owner("run"), nested = await owner("create");
    expect(parent.run).not.toBe(nested.run);
    await stop(nested.child);
    const decisions = await sweep({ mode: "remove", selector: `dev.disposable.run=${nested.run}`, minAgeSeconds: 0 });
    expect(decisions).toContainEqual(expect.objectContaining({ id: nested.id, action: "removed" }));
    expect(decisions.some(row => row.id === parent.id)).toBe(false);
    expect((await inspect(parent.id)).Id).toBe(parent.id);
    await stop(parent.child);
  }, postgresSetupTimeoutMs);
  it("retains a young dead owner's container under the default age floor", async context => {
    if (!available) { context.skip("Docker socket unavailable; real reclaim proof not executed"); return; }
    const { child, id } = await owner("create"); await stop(child);
    const created = Date.parse((await inspect(id)).Created);
    console.info(`Docker witness host-minus-VM creation clock ms=${Date.now() - created}`);
    const decisions = await sweep({ mode: "remove", selector: scope });
    expect(decisions).toContainEqual(expect.objectContaining({ id, action: "keep", reason: "too_young" }));
    expect((await inspect(id)).Id).toBe(id);
  }, postgresSetupTimeoutMs);
});
