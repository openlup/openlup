import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { env as processEnvironment } from "node:process";

const scratch = mkdtempSync(join(tmpdir(), "disposable-lifecycle-")), bin = join(scratch, "bin");
mkdirSync(bin);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function executable(name: string, source: string) {
  const file = join(bin, name); writeFileSync(file, `#!${process.execPath}\n${source}`); chmodSync(file, 0o700);
}
const log = join(scratch, "docker.log");
executable("docker", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');`);
executable("vitest", `import {env as childEnv} from 'node:process';console.log(childEnv.OPENLUP_DISPOSABLE_RUN_FROM_WRAPPER);if(process.argv.includes('signal-child'))process.kill(process.pid,'SIGTERM');else if(process.argv.includes('hang')){process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)}else process.exit(Number(process.argv.at(-1))||0);`);
async function wrapper(arg: string, signal?: NodeJS.Signals) {
  const child = spawn(process.execPath, [resolve("scripts/run-vitest.mjs"), arg], { cwd: scratch,
    env: { ...processEnvironment, CI: "true", OPENLUP_DISPOSABLE_RUN: "parent-run", OPENLUP_DISPOSABLE_RUN_FROM_WRAPPER: "inherited-wrapper", PATH: `${bin}:${processEnvironment.PATH}` } });
  let out = "", err = "";
  child.stderr.on("data", data => { err += data; });
  const exited = once(child, "exit");
  try {
    const run = await new Promise<string>((resolveRun, reject) => {
      child.stdout.on("data", data => { out += data; if (out.includes("\n")) resolveRun(out.trim()); });
      child.once("error", reject); child.once("exit", () => reject(new Error(`no identity: ${err}`)));
    });
    if (signal) child.kill(signal);
    const [code, stopped] = await exited;
    return { run, code, stopped };
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
}
it("gives nested wrappers distinct fresh IDs and sweeps only their own failed run", async () => {
  const a = await wrapper("1"), b = await wrapper("1");
  expect(a.code).toBe(1); expect(b.code).toBe(1);
  expect(a.run).not.toBe(b.run); expect(a.run).not.toBe("parent-run");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const { run } of [a, b]) expect(calls).toContainEqual(["ps", "-a", "-q", "--no-trunc", "--filter", "label=dev.disposable=1", "--filter", `label=dev.disposable.run=${run}`]);
});
it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("forwards %s, waits for the child and returns %s after exactly one scoped sweep", async (signal, code) => {
  const { run, code: actual } = await wrapper("hang", signal);
  expect(actual).toBe(code);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(args => args.includes(`label=dev.disposable.run=${run}`))).toHaveLength(1);
});
it("reaps after a successful child closes its worker pool", async () => {
  const { run, code } = await wrapper("0");
  expect(code).toBe(0);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(args => args.includes(`label=dev.disposable.run=${run}`))).toHaveLength(1);
});
it("reaps and re-raises an independently signalled child exit", async () => {
  const { run, code, stopped } = await wrapper("signal-child");
  expect(code).toBeNull(); expect(stopped).toBe("SIGTERM");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(args => args.includes(`label=dev.disposable.run=${run}`))).toHaveLength(1);
});
it("runs setup only once across inherited projects and reaps the same run on teardown, including CI", async () => {
  const sweep = vi.fn().mockResolvedValue([]);
  vi.doMock("./disposable-docker.mjs", () => ({ currentRunId: () => "setup-witness", sweep }));
  const previousCi = processEnvironment.CI, previousMode = processEnvironment.OPENLUP_DISPOSABLE_REAP;
  try {
    processEnvironment.CI = "false"; processEnvironment.OPENLUP_DISPOSABLE_REAP = "report";
    const { default: setup } = await import("../tests/setup/disposable-docker.ts");
    const [teardown, duplicate] = await Promise.all([setup(), setup()]);
    expect(duplicate).toBeUndefined();
    expect(sweep).toHaveBeenCalledExactlyOnceWith({ mode: "report" });
    processEnvironment.CI = "true";
    await teardown!();
    expect(sweep).toHaveBeenLastCalledWith({ mode: "remove", selector: "dev.disposable.run=setup-witness" });
  } finally {
    if (previousCi === undefined) delete processEnvironment.CI; else processEnvironment.CI = previousCi;
    if (previousMode === undefined) delete processEnvironment.OPENLUP_DISPOSABLE_REAP; else processEnvironment.OPENLUP_DISPOSABLE_REAP = previousMode;
    vi.doUnmock("./disposable-docker.mjs");
  }
});
it("preserves one wrapper identity and one setup across real Vitest project loaders", async () => {
  const directory = mkdtempSync(join(scratch, "projects-")), calls = join(directory, "docker.log"), ownBin = join(directory, "bin");
  mkdirSync(ownBin);
  writeFileSync(join(ownBin, "docker"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');`, { mode: 0o700 });
  const config = join(directory, "vitest.config.mts"), run = `project-witness-${Date.now()}`;
  writeFileSync(config, `import base from ${JSON.stringify(resolve("vitest.config.ts"))}; export default {...base, test: {...base.test, root:${JSON.stringify(directory)},setupFiles:[],globalSetup:[${JSON.stringify(resolve("tests/setup/disposable-docker.ts"))}],projects:[{extends:true,test:{name:'one',include:['one.test.ts']}},{extends:true,test:{name:'two',include:['two.test.ts']}}]}};`);
  for (const project of ["one", "two"]) writeFileSync(join(directory, `${project}.test.ts`), `import {it,expect} from ${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))}; import {writeFileSync} from 'node:fs';import {env as childEnv} from 'node:process';it('identity',()=>{expect(childEnv.OPENLUP_DISPOSABLE_RUN_FROM_WRAPPER).toBeUndefined();writeFileSync(${JSON.stringify(join(directory, `${project}.run`))},childEnv.OPENLUP_DISPOSABLE_RUN)});`);
  const child = spawn(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config, "--maxWorkers=1"], {
    env: { ...processEnvironment, CI: "false", OPENLUP_DISPOSABLE_REAP: "report", OPENLUP_DISPOSABLE_RUN: "parent", OPENLUP_DISPOSABLE_RUN_FROM_WRAPPER: run, PATH: `${ownBin}:${processEnvironment.PATH}` },
  });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [code] = await once(child, "exit");
    expect(code, output).toBe(0);
    expect(readFileSync(join(directory, "one.run"), "utf8")).toBe(run);
    expect(readFileSync(join(directory, "two.run"), "utf8")).toBe(run);
    const rows = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual([
      ["ps", "-a", "-q", "--no-trunc", "--filter", "label=dev.disposable=1"],
      ["ps", "-a", "-q", "--no-trunc", "--filter", "label=dev.disposable=1", "--filter", `label=dev.disposable.run=${run}`],
    ]);
  } finally { clearTimeout(timer); }
}, 25_000);

it("handles SIGTERM queued during synchronous coverage finalization", async () => {
  const directory = mkdtempSync(join(scratch, "coverage-")), ownBin = join(directory, "bin"), calls = join(directory, "docker.log");
  mkdirSync(ownBin);
  writeFileSync(join(ownBin, "vitest"), `#!${process.execPath}\nimport {mkdirSync,writeFileSync} from 'node:fs';import {env as childEnv} from 'node:process';mkdirSync(childEnv.VITEST_COVERAGE_DIR,{recursive:true});writeFileSync(childEnv.VITEST_COVERAGE_DIR+'/witness','coverage');`, { mode: 0o700 });
  writeFileSync(join(ownBin, "docker"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');`, { mode: 0o700 });
  const preload = join(directory, "copy-signal.mjs");
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const copy=fs.cpSync;fs.cpSync=(...args)=>{process.kill(process.pid,'SIGTERM');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);return copy(...args)};syncBuiltinESMExports();`);
  const env = { ...processEnvironment, CI: "true", PATH: `${ownBin}:${processEnvironment.PATH}` };
  for (const key of ["VITEST_COVERAGE_DIR", "OPENLUP_COVERAGE_PROOF_PATH", "OPENLUP_COVERAGE_SINGLEFLIGHT_MARKER", "VITEST_COVERAGE_SUMMARY_ONLY"]) delete env[key];
  const child = spawn(process.execPath, ["--import", preload, resolve("scripts/run-vitest.mjs"), "run", "--coverage"], { cwd: directory, env });
  let errors = ""; child.stderr.on("data", data => { errors += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code] = await once(child, "exit");
    expect(code, errors).toBe(143);
    const rows = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].at(-1)).toMatch(/^label=dev\.disposable\.run=/);
  } finally { clearTimeout(timer); }
});
