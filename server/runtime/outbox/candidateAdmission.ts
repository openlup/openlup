import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReadiness, type CandidateIdentity, type LoadedPackage, type ReadinessInput, type SchemaProbePort } from "@openlup/core/readiness";
import type { PlatformJobInvocation } from "@openlup/core/platform-runtime";
import type { ReferenceOutbox } from "./referenceContribution.js";
/** Admission is private to one candidate and checks no serving request or customer state. */
export async function admitReferenceOutbox(input: {
  runtime: ReferenceOutbox;
  candidate: CandidateIdentity;
  currentIdentity(): CandidateIdentity;
  loadedPackages?: readonly LoadedPackage[];
  inventoryComplete?: boolean;
  schemaProbe: SchemaProbePort;
  vocabulary: ReadinessInput["vocabulary"];
  exemptions: ReadinessInput["exemptions"];
  ports?: ReadinessInput["bindings"]["ports"];
  triggers?: ReadinessInput["bindings"]["triggers"];
}) {
  const runtime = input.runtime;
  const identity = { ...input.candidate };
  const observed = input.loadedPackages ? { loadedPackages: input.loadedPackages, inventoryComplete: input.inventoryComplete === true } : observeReferencePackages();
  const packages = observed.loadedPackages.map((p) => ({ ...p }));
  const triggers = { ...(input.triggers ?? runtime.triggers) };
  const ports: Record<string, unknown> = { ...(input.ports ?? runtime.ports) };
  // Evidence must identify this runtime's actual selected bindings, not an unrelated observational map.
  for (const key of Object.keys(runtime.ports)) if (ports[key] !== runtime.ports[key as keyof typeof runtime.ports]) delete ports[key];
  for (const key of Object.keys(runtime.triggers)) if (triggers[key] !== runtime.triggers[key]) delete triggers[key];
  const facts: ReadinessInput = { candidate: identity, loadedPackages: packages, inventoryComplete: observed.inventoryComplete,
    contributions: [runtime.contribution], vocabulary: input.vocabulary, exemptions: input.exemptions,
    bindings: { ports, triggers, routes: {}, env: {} }, schemaProbe: input.schemaProbe };
  const schedules = runtime.contribution.schedules.map((s) => ({ ...s }));
  const immediate = runtime.immediate;
  const report = await checkReadiness(facts);
  if (report.state !== "ready") return { admitted: false as const, report };
  // Identity includes the host's schema snapshot. A host must refresh it on configuration/schema changes.
  const assertCurrent = (): void => {
    const current = input.currentIdentity();
    if (Object.keys(identity).some((key) => current[key as keyof CandidateIdentity] !== identity[key as keyof CandidateIdentity])) throw new Error("outbox_candidate_admission_stale");
  };
  assertCurrent();
  return { admitted: true as const, report,
    immediate: () => { assertCurrent(); return immediate(); },
    run: (id: string, invocation: PlatformJobInvocation) => {
      assertCurrent();
      const trigger = schedules.find((s) => s.id === id)?.run;
      if (typeof trigger !== "function") throw new Error("outbox_schedule_unbound");
      return trigger(invocation as never);
    },
    start: async (host: { listen(): Promise<void>; bind(id: string, cadenceSeconds: number, run: () => Promise<unknown>): void }) => {
      assertCurrent();
      for (const schedule of schedules) host.bind(schedule.id, schedule.cadenceSeconds, async () => {
        assertCurrent();
        const trigger = schedule.run;
        if (typeof trigger !== "function") throw new Error("outbox_schedule_unbound");
        return trigger({triggerKind:"scheduler",invocationSource:"node-reference"} as never);
      });
      await host.listen();
    },
  };
}

/** Read the installed namespace and the actual exported package roots; never infer versions from a fixture. */
export function observeReferencePackages(): { loadedPackages: LoadedPackage[]; inventoryComplete: boolean } {
  const require = createRequire(import.meta.url);
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "node_modules", "@openlup"))) {
    const parent = dirname(directory);
    if (parent === directory) return { loadedPackages: [], inventoryComplete: false };
    directory = parent;
  }
  try {
  const names = readdirSync(join(directory, "node_modules", "@openlup")).sort();
  const loadedPackages: LoadedPackage[] = [];
  for (const name of names) {
    const pkg = `@openlup/${name}`;
    // The reference imports these two packages. An unexpected installation stays unknown.
    if (!["core", "outbox"].includes(name)) return { loadedPackages, inventoryComplete: false };
    let root = dirname(require.resolve(name === "core" ? "@openlup/core/readiness" : "@openlup/outbox"));
    while (!existsSync(join(root, "package.json"))) {
      const parent = dirname(root); if (parent === root) return { loadedPackages, inventoryComplete: false }; root = parent;
    }
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const gates = JSON.parse(readFileSync(join(root, "release-gates.json"), "utf8"));
    if (manifest.name !== pkg) return { loadedPackages, inventoryComplete: false };
    loadedPackages.push({ name: manifest.name, version: manifest.version, kind: gates.kind });
  }
  return { loadedPackages, inventoryComplete: names.length === 2 };
  } catch { return { loadedPackages: [], inventoryComplete: false }; }
}
