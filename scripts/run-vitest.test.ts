import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { availableParallelism } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { afterAll, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "vitest-worker-witness-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
const executable = join(bin, "vitest");
writeFileSync(executable, `#!${process.execPath}\nimport {env} from 'node:process'; console.log(JSON.stringify({workers:env.VITEST_MAX_WORKERS,args:process.argv.slice(2)}));\n`);
chmodSync(executable, 0o700);
const docker = join(bin, "docker");
writeFileSync(docker, `#!${process.execPath}\n`);
chmodSync(docker, 0o700);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function witness(overrides: NodeJS.ProcessEnv, args = ["run", "example.test.ts"]) {
  const env: NodeJS.ProcessEnv = { ...processEnvironment, PATH: `${bin}${delimiter}${processEnvironment.PATH}` };
  for (const name of ["CI", "VITEST_MAX_WORKERS", "OPENLUP_VITEST_MAX_WORKERS", "OPENLUP_VITEST_COVERAGE_MAX_WORKERS", "OPENLUP_HEAVY_ACTIVE", "AI_RESOURCE_GATE_ACTIVE", "AI_RESOURCE_GATE_CPU_TOKENS", "AI_RESOURCE_GATE_LANE", "AI_RESOURCE_GATE_RESOURCE", "OPENLUP_VITEST_EXCLUDE_FILE"]) delete env[name];
  const output = spawnSync(process.execPath, [resolve("scripts/run-vitest.mjs"), ...args], {
    cwd: scratch, env: { ...env, ...overrides }, encoding: "utf8", timeout: 5_000,
  });
  expect(output.status).toBe(0); return output;
}
function run(overrides: NodeJS.ProcessEnv, args?: string[]) { return JSON.parse(witness(overrides, args).stdout.trim().split("\n").at(-1)!); }

it("caps plain local verification and leaves CPU capacity for the parent", () => {
  expect(run({ AI_RESOURCE_GATE_ACTIVE: "1", AI_RESOURCE_GATE_CPU_TOKENS: "2" })).toEqual({ workers: "1", args: ["run", "example.test.ts"] });
  expect(Number(run({ OPENLUP_HEAVY_ACTIVE: scratch, AI_RESOURCE_GATE_CPU_TOKENS: "16" }).workers)).toBeLessThanOrEqual(4);
  expect(Number(run({ OPENLUP_HEAVY_ACTIVE: scratch }).workers)).toBeLessThanOrEqual(4);
});

it("preserves explicit caller and machine pins and leaves CI scheduling unchanged", () => {
  const broker = { AI_RESOURCE_GATE_ACTIVE: "1", AI_RESOURCE_GATE_CPU_TOKENS: "2" };
  expect(run({ ...broker, VITEST_MAX_WORKERS: "3", OPENLUP_VITEST_MAX_WORKERS: "1" }).workers).toBe("3");
  expect(run({ ...broker, OPENLUP_VITEST_MAX_WORKERS: "1" }).workers).toBe("1");
  expect(run({ ...broker, CI: "true" }).workers).toBeUndefined();
});

// Vitest's own rule for a configured percentage: round(cores * percent), at least one.
const percentOfCores = (percent: number) => String(Math.max(1, Math.min(availableParallelism(), Math.round(percent / 100 * availableParallelism()))));

it("reports the effective explicit worker pin before any child fixture output", () => {
  for (const [workers, effective] of [["3", "3"], ["40%", percentOfCores(40)]]) {
    const output = witness({ OPENLUP_HEAVY_ACTIVE: scratch, VITEST_MAX_WORKERS: workers });
    expect(output.stderr.trim()).toBe(`Local verification Vitest workers=${effective}`);
    expect(JSON.parse(output.stdout).workers).toBe(effective);
  }
});

it("resolves env worker percentages to integer workers, as Vitest's parseInt would read 50% as 50", () => {
  for (const [workers, effective] of [["50%", percentOfCores(50)], ["40%", percentOfCores(40)], ["37.5%", percentOfCores(37)], ["4", "4"]]) {
    expect(run({ VITEST_MAX_WORKERS: workers }).workers).toBe(effective);
  }
  // The wrapper's own coverage default is 50%, or 40% under contention.
  expect([percentOfCores(40), percentOfCores(50)]).toContain(run({}, ["run", "--coverage"]).workers);
});

it("defaults local config workers to 37.5% and keeps explicit pins and CI scheduling", () => {
  const configWorkers = (overrides: NodeJS.ProcessEnv) => {
    const env: NodeJS.ProcessEnv = { ...processEnvironment };
    for (const name of ["CI", "VITEST_MAX_WORKERS"]) delete env[name];
    // Vite's own loader bundles the config, as Vitest does (it relies on __dirname).
    const output = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import { loadConfigFromFile } from 'vite'; const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts'); console.log(JSON.stringify({ workers: config.test.maxWorkers ?? null }));"],
    { cwd: resolve("."), env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000 });
    expect(output.status, output.stderr).toBe(0);
    return JSON.parse(output.stdout.trim().split("\n").at(-1)!).workers;
  };
  expect(configWorkers({})).toBe("37.5%");
  expect(configWorkers({ VITEST_MAX_WORKERS: "3" })).toBe("3");
  expect(configWorkers({ CI: "true" })).toBeNull();
}, 60_000);
