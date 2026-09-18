import { spawn } from "node:child_process";

export type Command = {
  program: string;
  args: string[];
  cwd: string;
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type CommandResult = { code: number; stdout: string };

export async function runCommand(command: Command): Promise<CommandResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      env: command.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: command.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationRequested = false;
    let settled = false;
    const signalChild = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      if (!child.pid) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
      } catch { /* already exited */ }
      terminationTimer = setTimeout(() => {
        try {
          process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL");
        } catch { /* already exited */ }
      }, 10_000);
    };
    const abortChild = () => {
      terminationRequested = true;
      if (terminationTimer) clearTimeout(terminationTimer);
      if (!child.pid) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch { /* already exited */ }
    };
    const cleanup = () => {
      process.removeListener("SIGINT", signalChild);
      process.removeListener("SIGTERM", signalChild);
      command.signal?.removeEventListener("abort", abortChild);
      if (terminationTimer) clearTimeout(terminationTimer);
    };
    process.on("SIGINT", signalChild);
    process.on("SIGTERM", signalChild);
    command.signal?.addEventListener("abort", abortChild, { once: true });
    if (command.signal?.aborted) abortChild();
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult({ code: terminationRequested ? 1 : (code ?? 1), stdout });
    });
  });
}
