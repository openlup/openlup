import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { classify, disposableLabelArgs, ownerStart, parseOwnerStart, sweep } from "./disposable-docker.mjs";
import { env as processEnvironment } from "node:process";

const exec = promisify(execFile), now = Date.UTC(2026, 9, 29, 12) / 1000;
const start = "Thu Oct 29 11:00:00 2026", epoch = parseOwnerStart(start);
const labels = { "dev.disposable": "1", "dev.disposable.owner_pid": "1234", "dev.disposable.owner_start": String(epoch), "dev.disposable.host": "fixture", "dev.disposable.pidns": "pid:[42]" };
const container = () => ({ Config: { Labels: { ...labels } }, Created: new Date((now - 120) * 1000).toISOString() });
const probe = () => ({ platform: "linux", hostname: () => "fixture", pidns: () => "pid:[42]", kill: () => {}, ps: () => start });
const error = (code: string) => { throw Object.assign(new Error(code), { code }); };

describe("disposable owner classification", () => {
  it.each([
    ["ESRCH", {}, { kill: () => error("ESRCH") }, "dead", "owner_gone"],
    ["alive", {}, {}, "keep", "owner_alive"],
    ["EPERM", {}, { kill: () => error("EPERM") }, "keep", "owner_probe_refused"],
    ["unknown kill error", {}, { kill: () => error("EIO") }, "keep", "owner_probe_refused"],
    ["recycled", { "dev.disposable.owner_start": String(epoch - 3) }, {}, "dead", "owner_pid_recycled"],
    ["two second tolerance", { "dev.disposable.owner_start": String(epoch + 2) }, {}, "keep", "owner_alive"],
    ["missing start", { "dev.disposable.owner_start": undefined }, {}, "keep", "owner_start_missing_or_malformed"],
    ["malformed start", { "dev.disposable.owner_start": "0garbage" }, {}, "keep", "owner_start_missing_or_malformed"],
    ["leading zero start", { "dev.disposable.owner_start": `0${epoch}` }, {}, "keep", "owner_start_missing_or_malformed"],
    ["unreadable ps", {}, { ps: () => "" }, "keep", "owner_start_unreadable"],
    ["daemon timeout", {}, { ps: () => error("ETIMEDOUT") }, "keep", "probe_failed"],
    ["missing marker", { "dev.disposable": undefined }, {}, "keep", "not_disposable"],
    ["non-1 marker", { "dev.disposable": "true" }, {}, "keep", "not_disposable"],
    ["Supabase CLI project", { "com.supabase.cli.project": "openlup-ci-0000" }, {}, "keep", "supabase_project"],
    ["foreign host", { "dev.disposable.host": "elsewhere" }, {}, "keep", "host_mismatch"],
    ["missing pidns", { "dev.disposable.pidns": undefined }, {}, "keep", "pidns_mismatch_or_missing"],
    ["foreign pidns", { "dev.disposable.pidns": "pid:[43]" }, {}, "keep", "pidns_mismatch_or_missing"],
    ["macOS omits pidns", { "dev.disposable.pidns": undefined }, { platform: "darwin" }, "keep", "owner_alive"],
  ])("%s", (_name, changes, probes, decision, reason) => {
    const info = container(); Object.assign(info.Config.Labels, changes);
    expect(classify(info, { ...probe(), ...probes }, now)).toEqual({ decision, reason });
  });
  it.each([undefined, "", "0", "1", "01", "01234", "-2", "1.2", "12x", "1234567890", " 1234"])("keeps malformed owner_pid=%s", pid => {
    const info = container(); Object.assign(info.Config.Labels, { "dev.disposable.owner_pid": pid });
    expect(classify(info, { ...probe(), kill: () => error("ESRCH") }, now).reason).toBe("owner_pid_malformed");
  });
  it("keeps young and unreadable creation dates, including for dead owners", () => {
    const info = container(), dead = { ...probe(), kill: () => error("ESRCH") };
    info.Created = new Date((now - 59) * 1000).toISOString();
    expect(classify(info, dead, now).reason).toBe("too_young");
    expect(classify(info, dead, now, { minAgeSeconds: 0 }).decision).toBe("dead");
    info.Created = "unknown";
    expect(classify(info, dead, now, { minAgeSeconds: 0 }).reason).toBe("created_unparsable");
    expect(classify({}, dead, now).decision).toBe("keep");
  });
  it("adds the ownership contract at creation", () => {
    const args = disposableLabelArgs({ run: "fixture-run" });
    expect(args).toContain(`dev.disposable.owner_pid=${process.pid}`);
    expect(args).toContain("dev.disposable=1");
    expect(args).toContain("dev.disposable.run=fixture-run");
    const token = args.find(value => value.startsWith("dev.disposable.owner_start="))!.split("=")[1];
    expect(Math.abs(Number(token) - (Date.now() / 1000 - process.uptime()))).toBeLessThanOrEqual(1);
  });
});

it("parses real lstart independently of inherited locale and agrees with a live Node and shell owner", async () => {
  const child = spawn(process.execPath, ["-e", "console.log(Math.round(Date.now()/1000-process.uptime()));setInterval(()=>{},1000)"]);
  const shell = spawn("sh", ["-c", "echo ready; read ignored"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const token = await new Promise<number>(resolve => child.stdout.once("data", data => resolve(Number(String(data).trim()))));
    await new Promise<void>(resolve => shell.stdout.once("data", () => resolve()));
    const starts = await Promise.all(["pl_PL.UTF-8", "en_GB.UTF-8", "C"].map(locale => ownerStart(child.pid!, { ...processEnvironment, LANG: locale, LC_ALL: locale })));
    expect(new Set(starts).size).toBe(1);
    expect(Math.abs(starts[0] - token)).toBeLessThanOrEqual(2);
    const shellStart = await ownerStart(shell.pid!);
    const { stdout } = await exec("ps", ["-p", String(shell.pid), "-o", "lstart="], { env: { ...processEnvironment, LC_ALL: "C", TZ: "UTC" } });
    expect(parseOwnerStart(stdout)).toBe(shellStart);
    expect(Number.isFinite(shellStart)).toBe(true);
  } finally {
    child.kill("SIGKILL"); shell.kill("SIGKILL");
    await Promise.all([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => shell.once("exit", resolve))]);
  }
});

const scratch = mkdtempSync(join(tmpdir(), "disposable-docker-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function fakeDocker(source: string) {
  const path = join(scratch, `docker-${Math.random()}.mjs`);
  writeFileSync(path, `#!${process.execPath}\n${source}`); chmodSync(path, 0o700); return path;
}
it("bounds a hung Docker call by the aggregate sweep budget and reports a missing daemon", async () => {
  const started = performance.now();
  const result = await sweep({ mode: "remove", docker: fakeDocker("setInterval(()=>{},1000)"), budgetMs: 100 });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(result).toEqual([expect.objectContaining({ decision: "keep", reason: expect.stringContaining("docker_unavailable_or_timeout") })]);
  expect((await sweep({ docker: join(scratch, "missing") }))[0].decision).toBe("keep");
});
it("uses inspected full IDs and rechecks selectors; failures never become removals", async () => {
  const id = "a".repeat(64), info = { ...container(), Id: "a".repeat(64), Created: new Date(Date.now() - 120_000).toISOString() };
  info.Config.Labels["dev.disposable.owner_pid"] = "999999999";
  Object.assign(info.Config.Labels, { "test.scope": "own", "dev.disposable.host": (await import("node:os")).hostname().split(".")[0], "dev.disposable.pidns": process.platform === "linux" ? (await import("node:fs")).readlinkSync("/proc/self/ns/pid") : "" });
  const log = join(scratch, "calls");
  const docker = fakeDocker(`import {appendFileSync} from 'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='ps')console.log(${JSON.stringify(id)});else if(args[0]==='inspect')console.log(${JSON.stringify(JSON.stringify([info]))});`);
  expect((await sweep({ mode: "report", docker, selector: "test.scope=own" }))[0].action).toBe("would_remove");
  expect((await sweep({ mode: "remove", docker, selector: "test.scope=foreign" }))[0].reason).toBe("selector_mismatch");
  expect((await sweep({ mode: "remove", docker, selector: "test.scope=own" }))[0].action).toBe("removed");
  const calls = (await import("node:fs")).readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(args => args[0] === "rm")).toEqual([["rm", "-f", "-v", id]]);
});
