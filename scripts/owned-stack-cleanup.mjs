// Keep the same owned cleanup on finally and signals, including partial starts.
import { execFile } from "node:child_process";

export function ownedStackCleanup(cleanup, { target = process, budgetMs = 30_000 } = {}) {
  let completed = false, failure, child;
  const run = () => {
    if (completed) { if (failure) throw failure; return; }
    completed = true;
    child?.kill("SIGKILL");
    const deadline = performance.now() + budgetMs;
    const options = () => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Owned stack cleanup budget exhausted");
      // Survive a second signal broadcast to the runner's process group.
      return { timeout: remaining, killSignal: "SIGKILL", detached: true };
    };
    try { cleanup(options); } catch (error) { failure = error; throw error; }
  };
  const signal = code => {
    try { run(); } catch { console.error("Owned stack cleanup failed; resources retained for inspection"); }
    target.exit(code);
  };
  const onInt = () => signal(130), onTerm = () => signal(143);
  target.on("SIGINT", onInt); target.on("SIGTERM", onTerm);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const dispose = () => { target.removeListener("SIGINT", onInt); target.removeListener("SIGTERM", onTerm); };
  const command = (command, args, options = {}) => new Promise(resolve => {
    if (completed) throw new Error("Owned stack already cleaned");
    let inputError;
    child = execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 240_000, killSignal: "SIGKILL", ...options }, (error, stdout, stderr) => {
      child = undefined;
      const failure = error ?? inputError;
      resolve({ error: failure, stdout, stderr, status: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, signal: failure?.signal });
    });
    child.stdin?.on("error", error => { inputError = error; });
    child.stdin?.end(options.input);
  });
  return {
    run,
    async finish() {
      // Dispatch signals queued during synchronous probes/cleanup before removing
      // their handlers; otherwise the runner can incorrectly report success.
      await settle();
      try { run(); } finally { await settle(); dispose(); }
    },
    command,
    dispose,
    // Start must yield to the signal handler. A synchronous start delays cleanup
    // until after the entire CLI startup timeout, or never on a hung daemon.
    async start(executable, args, options = {}) {
      const result = await command(executable, args, options);
      if (result.error || result.status !== 0) throw new Error("Owned stack startup failed; credential-bearing output suppressed");
      return result.stdout.trim();
    },
  };
}
