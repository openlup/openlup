/** Source-checkout CLI binding; installed package code still comes from verified tarballs. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../../../scripts/packages/outbox-disposable-postgres.ts", import.meta.url))], { stdio: "inherit" });
const terminate = () => child.kill("SIGTERM"), interrupt = () => child.kill("SIGINT");
process.on("SIGTERM", terminate);
process.on("SIGINT", interrupt);
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", code => { process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", interrupt); process.exitCode = code ?? 1; });
