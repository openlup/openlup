import { currentRunId, sweep } from "../../scripts/disposable-docker.mjs";
import { env as processEnvironment } from "node:process";

// Vitest loads this module in a separate runner for each inherited project.
const runsKey = Symbol.for("openlup.disposable.setup");
const runs: Map<string, Promise<void>> = process[runsKey] ??= new Map();
export default async function setup() {
  const run = currentRunId();
  if (!run || runs.has(run)) return;
  const start = (async () => {
    const mode = processEnvironment.CI === "true" ? "off" : processEnvironment.OPENLUP_DISPOSABLE_REAP ?? "remove";
    if (mode !== "off") await sweep({ mode: mode === "remove" ? "remove" : "report" });
  })();
  runs.set(run, start);
  await start;
  // Liveness alone guards this run's own containers: a helper child that exited
  // seconds ago is as dead as one that exited a minute ago.
  return async () => { await sweep({ mode: "remove", selector: `dev.disposable.run=${run}`, minAgeSeconds: 0 }); };
}
