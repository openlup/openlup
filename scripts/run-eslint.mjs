// Runs ESLint with a bounded local worker count so parallel agent sessions do
// not saturate the host, while keeping `--concurrency auto` on hosted CI.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_LOCAL_ESLINT_CONCURRENCY = "2";
export const MAX_GATED_ESLINT_CONCURRENCY = 4;

const hasExplicitConcurrency = (argv) => argv.some(
  (arg) => arg === "--concurrency" || arg.startsWith("--concurrency="),
);

const isValidConcurrency = (value) => value === "auto" || value === "off" || /^[1-9][0-9]*$/u.test(value);

/**
 * Resolves the `--concurrency` argument for ESLint, or `null` when the caller
 * already supplied one.
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveEslintConcurrency(argv, env = processEnvironment) {
  if (hasExplicitConcurrency(argv)) return null;
  if (env.CI === "true") return "auto";
  const explicit = env.OPENLUP_ESLINT_CONCURRENCY?.trim();
  if (explicit && isValidConcurrency(explicit)) return explicit;
  const tokens = Number(env.AI_RESOURCE_GATE_CPU_TOKENS);
  if (Number.isInteger(tokens) && tokens > 0) {
    return String(Math.max(1, Math.min(MAX_GATED_ESLINT_CONCURRENCY, tokens)));
  }
  return DEFAULT_LOCAL_ESLINT_CONCURRENCY;
}

/**
 * Builds the ESLint command invocation.
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 */
export function eslintInvocation(argv, env = processEnvironment, cwd = process.cwd()) {
  const concurrency = resolveEslintConcurrency(argv, env);
  const args = concurrency ? ["--concurrency", concurrency, ...argv] : [...argv];
  const binName = process.platform === "win32" ? "eslint.cmd" : "eslint";
  const localBin = join(resolve(cwd), "node_modules", ".bin", binName);
  const command = existsSync(localBin) ? localBin : binName;
  const binDir = join(resolve(cwd), "node_modules", ".bin");
  const nextEnv = {
    ...env,
    PATH: env.PATH ? `${binDir}${delimiter}${env.PATH}` : binDir,
  };
  return { command, args, env: nextEnv, concurrency };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const invocation = eslintInvocation(process.argv.slice(2), processEnvironment, process.cwd());
  const child = spawn(invocation.command, invocation.args, {
    stdio: "inherit",
    env: invocation.env,
    shell: process.platform === "win32",
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
