import { currentRunId, sweep } from "../../scripts/disposable-docker.mjs";

// Vitest loads this module in a separate runner for each inherited project.
const runsKey = Symbol.for("openlup.disposable.setup");
const runs: Map<string, Promise<void>> = process[runsKey] ??= new Map();
export default async function setup() {
  const run = currentRunId();
  if (!run || runs.has(run)) return;
  const start = (async () => {
    const mode = process.env.CI === "true" ? "off" : process.env.OPENLUP_DISPOSABLE_REAP ?? "report";
    if (mode !== "off") await sweep({ mode: mode === "remove" ? "remove" : "report" });
  })();
  runs.set(run, start);
  await start;
  return async () => { await sweep({ mode: "remove", selector: `dev.disposable.run=${run}` }); };
}
