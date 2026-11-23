import * as disposableDocker from "../../scripts/disposable-docker.mjs";
import { env as processEnvironment } from "node:process";
import type { TestProject } from "vitest/node";
import { startPgTemplateBroker, type PgTemplateBroker } from "../helpers/pgTemplateBroker.js";

// Vitest loads this module in a separate runner for each inherited project.
const runsKey = Symbol.for("openlup.disposable.setup");
const wrappedKey = Symbol.for("openlup.disposable.wrapped");
const targetedKey = Symbol.for("openlup.disposable.targeted");
const brokerKey = Symbol.for("openlup.pgTemplateBroker");
const runs: Map<string, Promise<void>> = process[runsKey] ??= new Map();
type BrokerEntry = { ready: Promise<PgTemplateBroker> };
const brokers: Map<string, BrokerEntry> = process[brokerKey] ??= new Map();
const optionalExport = <K extends keyof typeof disposableDocker>(key: K): (typeof disposableDocker)[K] | undefined =>
  Object.prototype.hasOwnProperty.call(disposableDocker, key) ? disposableDocker[key] : undefined;

export default async function setup(project?: TestProject) {
  const run = disposableDocker.currentRunId();
  if (!run) return;
  let brokerEntry = brokers.get(run);
  if (!brokerEntry && project) {
    brokerEntry = { ready: startPgTemplateBroker() };
    brokers.set(run, brokerEntry);
  }
  const broker = brokerEntry ? await brokerEntry.ready : undefined;
  if (broker && project) {
    project.provide("pgTemplateBroker", { url: broker.url, token: broker.token });
  }
  if (runs.has(run)) return;
  const targeted = Boolean(process[targetedKey]);
  const start = (async () => {
    const explicitMode = processEnvironment.OPENLUP_DISPOSABLE_REAP;
    // Skip the host-wide dead-container sweep on targeted unit runs unless the
    // caller explicitly opted in via OPENLUP_DISPOSABLE_REAP.
    const mode = processEnvironment.CI === "true"
      ? "off"
      : explicitMode ?? (targeted ? "off" : "remove");
    if (mode !== "off") await disposableDocker.sweep({ mode: mode === "remove" ? "remove" : "report" });
  })();
  runs.set(run, start);
  await start;
  // Liveness alone guards this run's own containers: a helper child that exited
  // seconds ago is as dead as one that exited a minute ago. On targeted runs,
  // skip the teardown Docker CLI call when no test in this run ever labeled a
  // disposable container.
  return async () => {
    const activeEntry = brokers.get(run);
    if (activeEntry) {
      brokers.delete(run);
      // Close the broker and remove any lazily booted template containers BEFORE
      // the disposable-docker sweep, regardless of targeted/activity flags.
      await (await activeEntry.ready).close();
    }
    const checkActivity = optionalExport("hasDisposableRunActivity");
    const hasActivity = typeof checkActivity === "function" ? checkActivity(run) : true;
    if (targeted && !hasActivity) return;
    await disposableDocker.sweep({ mode: "remove", selector: `dev.disposable.run=${run}`, minAgeSeconds: 0 });
    const clearActivity = optionalExport("clearDisposableRunActivity");
    if (!process[wrappedKey] && typeof clearActivity === "function") {
      clearActivity(run);
    }
  };
}
