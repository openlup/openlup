// Governing document: docs/platform/DOCUMENTATION.md, "Reader guide contract".
/**
 * Runs only the page's `sh tutorial` fences, in one bash process.
 * Candidate mode makes exactly one substitution through a PATH-local npm shim:
 * `npm view @openlup/core version` returns the candidate version, and exact
 * @openlup/<name>@<candidate-version> install arguments become verified tarball
 * paths. All other npm arguments and all page bytes remain unchanged. Registry
 * mode has no shim. Neither mode supplies application code or database SQL.
 * Defaults: 120 seconds per step, 210 seconds total (including installation).
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedConsumerEnv, readPackManifest } from "./pack-manifest-input.ts";

export const DATABASE_VARIABLE = "OPENLUP_TUTORIAL_DATABASE_URL";
export type TutorialStep = { command: string; expected: string[] };
export type Candidate = { version: string; tarballs: Record<string, string> };

export function extractTutorial(page: string): TutorialStep[] {
  const steps: TutorialStep[] = [];
  let fence: { character: string; length: number; info: string; lines: string[] } | undefined;
  for (const line of page.split(/\r?\n/u)) {
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (open) fence = { character: open[1]![0]!, length: open[1]!.length, info: open[2]!.trim(), lines: [] };
    } else if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`, "u").test(line)) {
      if (fence.info === "sh tutorial") steps.push({ command: fence.lines.join("\n"), expected: [] });
      if (fence.info === "text tutorial-expect") {
        const step = steps.at(-1);
        if (!step) throw new Error("tutorial: expectation has no preceding step");
        step.expected.push(...fence.lines.filter(line => line.trim() !== ""));
      }
      fence = undefined;
    } else fence.lines.push(line);
  }
  if (fence) throw new Error("tutorial: unclosed fence");
  if (!steps.length) throw new Error("tutorial: page has no sh tutorial step");
  return steps;
}

export function assertExpectation(stdout: string, expected: readonly string[]): void {
  let position = 0;
  for (const line of expected) {
    const found = stdout.indexOf(line, position);
    if (found < 0) throw new Error(`expected output missing or out of order: ${line}`);
    position = found + line.length;
  }
}

export function readCandidate(directory: string): Candidate {
  const manifestPath = join(resolve(directory), "packages-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.packages)) throw new Error("tutorial: missing candidate packages");
  const packs = readPackManifest(manifestPath, manifest.commit, manifest.packages.map((entry: { name: string; version: string }) => ({ name: entry.name, version: entry.version })));
  const core = packs.get("@openlup/core");
  if (!core || [...packs.values()].some(pack => pack.version !== core.version || !/^@openlup\/[a-z0-9-]+$/u.test(pack.name))) throw new Error("tutorial: candidate needs core and one matching set version");
  return { version: core.version, tarballs: Object.fromEntries([...packs.values()].map(pack => [pack.name, pack.path])) };
}

export function candidateNpm(args: string[], candidate: Candidate): { stdout: string } | { args: string[] } {
  if (args.join("\0") === "view\0@openlup/core\0version") return { stdout: `${candidate.version}\n` };
  if (args[0] !== "install") return { args };
  return { args: args.map(argument => {
    if (!argument.startsWith("@openlup/")) return argument;
    const spec = /^(@openlup\/[a-z0-9-]+)@(.+)$/u.exec(argument);
    if (!spec || spec[2] !== candidate.version || !candidate.tarballs[spec[1]!]) throw new Error(`tutorial: no exact candidate tarball for ${argument}`);
    return candidate.tarballs[spec[1]!]!;
  }) };
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export type TutorialOptions = {
  steps: TutorialStep[]; databaseUrl: string; packages?: string; work?: string;
  env?: NodeJS.ProcessEnv; stepTimeoutMs?: number; totalTimeoutMs?: number;
};
export type StepOutput = { stdout: string; stderr: string };

export async function runTutorial(options: TutorialOptions): Promise<StepOutput[]> {
  if (!options.steps.length) throw new Error("tutorial: no steps");
  const temporary = mkdtempSync(join(tmpdir(), "openlup-guide-tutorial-"));
  const work = options.work ? resolve(options.work) : join(temporary, "app");
  const outputs: StepOutput[] = [];
  const environment: NodeJS.ProcessEnv = { ...isolatedConsumerEnv(), ...options.env, [DATABASE_VARIABLE]: options.databaseUrl };
  // Do not allow ancestor/workspace module overrides into the reader process.
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  const redact = (value: string): string => options.databaseUrl ? value.replaceAll(options.databaseUrl, "[database URL]") : value;
  const outputAt = (index: number): StepOutput => ({
    stdout: readFileSync(join(temporary, `${index}.stdout`), "utf8"),
    stderr: readFileSync(join(temporary, `${index}.stderr`), "utf8"),
  });
  try {
    mkdirSync(work, { recursive: true });
    if (readdirSync(work).length) throw new Error("tutorial: --work must be an empty directory");
    if (options.packages) {
      const candidate = readCandidate(options.packages);
      const realNpm = execFileSync("bash", ["-c", "command -v npm"], { env: environment, encoding: "utf8" }).trim();
      const config = join(temporary, "candidate.json");
      writeFileSync(config, JSON.stringify({ candidate, realNpm }));
      const shim = join(temporary, "npm.mjs");
      writeFileSync(shim, `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { candidateNpm } from ${JSON.stringify(import.meta.url)};
const { candidate, realNpm } = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
try {
  const result = candidateNpm(process.argv.slice(2), candidate);
  if ('stdout' in result) process.stdout.write(result.stdout);
  else {
    const child = spawnSync(realNpm, result.args, { stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
      const bin = join(temporary, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "npm"), `#!/bin/bash\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(shim)} "$@"\n`, { mode: 0o755 });
      environment.PATH = `${bin}${delimiter}${environment.PATH ?? ""}`;
    }
    // Braces preserve cwd, variables, functions and shell options across steps.
    // Separate files keep stderr from satisfying a stdout expectation; fd 3
    // marks boundaries without mixing markers into application output.
    const scripts = options.steps.map((step, index) => {
      writeFileSync(join(temporary, `${index}.stdout`), "");
      writeFileSync(join(temporary, `${index}.stderr`), "");
      return `printf 'start ${index}\\n' >&3\n{\n${step.command}\n} >${quote(join(temporary, `${index}.stdout`))} 2>${quote(join(temporary, `${index}.stderr`))}\nprintf 'done ${index}\\n' >&3\n`;
    });
    await new Promise<void>((fulfill, reject) => {
      const child = spawn("bash", ["-euo", "pipefail"], { cwd: work, env: environment, detached: true, stdio: ["pipe", "ignore", "pipe", "pipe"] });
      const input = child.stdin!;
      let active = 0, completed = 0, control = "", shellError = "", failure: string | undefined;
      let stepTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals): void => {
        if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      };
      const stop = (reason: string): void => {
        if (failure) return;
        failure = reason;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 250);
      };
      const totalTimer = setTimeout(() => stop("total time limit exceeded"), options.totalTimeoutMs ?? 210_000);
      const interrupt = (): void => stop("interrupted");
      process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
      child.stderr!.on("data", chunk => { shellError = (shellError + chunk.toString()).slice(-8000); });
      const controlPipe = child.stdio[3]!;
      controlPipe.on("data", (chunk: Buffer) => {
        control += chunk.toString();
        let newline: number;
        while ((newline = control.indexOf("\n")) >= 0) {
          const line = control.slice(0, newline); control = control.slice(newline + 1);
          const match = /^(start|done) (\d+)$/u.exec(line);
          if (!match || failure) continue;
          active = Number(match[2]);
          clearTimeout(stepTimer);
          if (match[1] === "start") stepTimer = setTimeout(() => stop("step time limit exceeded"), options.stepTimeoutMs ?? 120_000);
          else {
            const output = outputAt(active);
            outputs.push(output);
            try {
              assertExpectation(output.stdout, options.steps[active]!.expected); completed++;
              if (completed === options.steps.length) input.end();
              else input.write(scripts[completed]!);
            }
            catch (error) { stop((error as Error).message); }
          }
        }
      });
      // Expected termination after a failure can close stdin before it is read.
      input.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error.message); });
      child.once("error", error => { failure = error.message; });
      child.once("close", (code, signal) => {
        clearTimeout(stepTimer); clearTimeout(totalTimer); clearTimeout(killTimer);
        process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
        if (!failure && code === 0 && completed === options.steps.length) { fulfill(); return; }
        kill("SIGKILL");
        const output = outputAt(active);
        const tail = (output.stdout + output.stderr + shellError).split("\n").slice(-20).join("\n").slice(-8000);
        reject(new Error(redact(`tutorial: step ${active + 1} failed (${failure ?? `exit ${code}, signal ${signal}`})\nCommand:\n${options.steps[active]!.command}\nOutput tail:\n${tail}`)));
      });
      input.write(scripts[0]!);
    });
    return outputs.map(output => ({ stdout: redact(output.stdout), stderr: redact(output.stderr) }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function main(args: string[]): Promise<number> {
  const started = performance.now();
  let count = 0, success = false;
  try {
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index++) {
      const name = args[index]!;
      if (!["--page", "--packages", "--registry", "--database-url", "--work"].includes(name) || flags.has(name)) throw new Error("tutorial: invalid or duplicate option");
      const value = name === "--registry" ? "true" : args[++index];
      if (!value || value.startsWith("--")) throw new Error(`tutorial: missing value for ${name}`);
      flags.set(name, value);
    }
    if (!flags.has("--page") || !flags.has("--database-url") || flags.has("--packages") === flags.has("--registry")) throw new Error("Use --page <md> (--packages <dir> | --registry) --database-url <url> [--work <empty-dir>]");
    const steps = extractTutorial(readFileSync(resolve(flags.get("--page")!), "utf8"));
    count = steps.length;
    const outputs = await runTutorial({ steps, databaseUrl: flags.get("--database-url")!, packages: flags.get("--packages"), work: flags.get("--work") });
    outputs.forEach((output, index) => {
      console.log(`Tutorial step ${index + 1}: PASS`);
      process.stdout.write(output.stdout); process.stderr.write(output.stderr);
    });
    success = true;
    console.log(`Guide tutorial PASS (${count} steps, ${((performance.now() - started) / 1000).toFixed(2)}s)`);
    return 0;
  } catch (error) { console.error((error as Error).message); return 1; }
  finally {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Guide tutorial: ${success ? "PASS" : "FAIL"}\n\nMode: ${args.includes("--registry") ? "registry" : "packed candidate"}. Steps: ${count}. Wall time: ${((performance.now() - started) / 1000).toFixed(2)}s.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
