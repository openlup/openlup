/** Source-checkout CLI binding; installed package code still comes from verified tarballs. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const detached = process.platform !== "win32";
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", fileURLToPath(new URL("../../../scripts/packages/platform-cold-consumer.ts", import.meta.url))],
  { stdio: "inherit", detached },
);
const forward = (signal: NodeJS.Signals) => {
  if (detached && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* process group may already have exited */ }
  }
  child.kill(signal);
};
const terminate = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
const detach = () => { process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", interrupt); };
process.on("SIGTERM", terminate);
process.on("SIGINT", interrupt);
child.once("error", error => { detach(); console.error(error); process.exitCode = 1; });
child.once("close", code => { detach(); process.exitCode = code ?? 1; });
