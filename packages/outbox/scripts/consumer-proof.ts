/** Source-checkout CLI binding; installed package code still comes from verified tarballs. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../../../scripts/packages/outbox-disposable-postgres.ts", import.meta.url))], { stdio: "inherit" });
const interrupt = (signal: NodeJS.Signals) => child.kill(signal);
process.once("SIGTERM", interrupt);
process.once("SIGINT", interrupt);
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", code => { process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt); process.exitCode = code ?? 1; });
