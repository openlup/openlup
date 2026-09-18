import { execFileSync } from "node:child_process";

export type CommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Buffer | string;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandOptions,
): Buffer {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function outputText(output: Buffer | string): string {
  return typeof output === "string" ? output : output.toString("utf8");
}

export function sanitizedGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("GIT_")),
  );
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return sanitized;
}

export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error instanceof AggregateError) {
    const nested = error.errors.map(errorText).filter(Boolean);
    return nested.length > 0 ? `${error.message}: ${nested.join("; ")}` : error.message;
  }
  const stderr = "stderr" in error
    ? outputText((error as Error & { stderr?: Buffer | string }).stderr ?? "").trim()
    : "";
  return stderr ? `${error.message}: ${stderr}` : error.message;
}

export function runRequired(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
  env?: NodeJS.ProcessEnv,
): string {
  return outputText(runRequiredRaw(label, command, args, cwd, runner, env));
}

export function runRequiredRaw(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
  env?: NodeJS.ProcessEnv,
): Buffer | string {
  try {
    return runner(command, args, { cwd, env });
  } catch (error) {
    throw new Error(`${label} failed: ${errorText(error)}`, { cause: error });
  }
}

export function isMissingCommand(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "ENOENT",
  );
}

export function assertGitSha(value: string, label: string): string {
  const sha = value.trim();
  assert(
    /^[0-9a-f]{40,64}$/.test(sha),
    `${label} returned an invalid commit id: ${JSON.stringify(sha)}`,
  );
  return sha;
}
