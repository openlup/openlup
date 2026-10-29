import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { ownedStackCleanup } from "./owned-stack-cleanup.mjs";

it.each([
  "scripts/public-ci-pgtap.mjs", "tests/postgres/runIdentityEnvelopeConformance.mjs",
  "tests/identity/runAcceptance.mjs", "tests/postgres/runOidcIdentityConformance.mjs",
])("%s uses the once-only bounded SIGTERM/finally cleanup", file => {
  const source = readFileSync(file, "utf8");
  expect(source).toContain("ownedStackCleanup(options =>");
  expect(source).toContain("await cleanup.finish();");
  const target = Object.assign(new EventEmitter(), { exit: vi.fn() }), stop = vi.fn(options => {
    expect(options()).toMatchObject({ killSignal: "SIGKILL", detached: true });
    expect(options().timeout).toBeLessThanOrEqual(30_000);
  });
  const cleanup = ownedStackCleanup(stop, { target });
  target.emit("SIGTERM"); target.emit("SIGTERM"); cleanup.run(); cleanup.dispose();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(target.exit).toHaveBeenCalledWith(143);
  expect(target.listenerCount("SIGTERM")).toBe(0);
});
it("keeps cleanup failures fatal without retrying them, and maps SIGINT to 130", () => {
  const target = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const stop = vi.fn(() => { throw new Error("owned cleanup failed"); });
  const cleanup = ownedStackCleanup(stop, { target });
  expect(() => cleanup.run()).toThrow("owned cleanup failed");
  target.emit("SIGINT");
  expect(() => cleanup.run()).toThrow("owned cleanup failed");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(target.exit).toHaveBeenCalledWith(130);
  cleanup.dispose();
});

it.each(["operation", "cleanup"])("handles a real SIGTERM queued during synchronous %s", async phase => {
  const source = `
    import {spawnSync} from 'node:child_process';
    import {ownedStackCleanup} from ${JSON.stringify(pathToFileURL(resolve("scripts/owned-stack-cleanup.mjs")).href)};
    const block=()=>spawnSync(process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)'],{timeout:2000,killSignal:'SIGKILL'});
    const cleanup=ownedStackCleanup(()=>{console.log('CLEANUP');if(${JSON.stringify(phase)}==='cleanup')block()});
    if(${JSON.stringify(phase)}==='operation'){console.log('READY');block()}
    await cleanup.finish(); console.log('SUCCESS');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "", signalled = false;
  child.stdout.on("data", data => {
    output += data;
    if (!signalled && output.includes(phase === "operation" ? "READY" : "CLEANUP")) {
      signalled = true; setTimeout(() => child.kill("SIGTERM"), 100);
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code] = await once(child, "exit");
    expect(code, output).toBe(143);
    expect(output.match(/CLEANUP/g)).toHaveLength(1);
    expect(output).not.toContain("SUCCESS");
  } finally { clearTimeout(timer); }
});

it("retains owned cleanup when a command closes stdin during a large replay", async () => {
  const source = `
    import {ownedStackCleanup} from ${JSON.stringify(pathToFileURL(resolve("scripts/owned-stack-cleanup.mjs")).href)};
    const cleanup=ownedStackCleanup(()=>console.log('CLEANUP'));
    try {
      const result=await cleanup.command(process.execPath,['-e','process.exit(1)'],{input:'x'.repeat(4000000)});
      if(result.error||result.status!==0)throw Error('replay failed');
    } catch { console.log('FAILED');process.exitCode=1; }
    finally { await cleanup.finish(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code] = await once(child, "exit");
    expect(code, errors).toBe(1);
    expect(output).toContain("FAILED"); expect(output.match(/CLEANUP/g)).toHaveLength(1);
    expect(errors).not.toContain("Unhandled");
  } finally { clearTimeout(timer); }
});
