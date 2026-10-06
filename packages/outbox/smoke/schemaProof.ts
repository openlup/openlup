// Outbox binding of common installed-artifact schema-budget test tooling.
import assert from "node:assert/strict";
import { createSchemaProbe, checkReadiness, schemaObjectKey } from "@openlup/core/readiness";
import { POSTGRES_OUTBOX_SCHEMA } from "@openlup/outbox/postgres";
import { proveSchemaBudget } from "./schema-budget-proof.mjs";
import { createReferenceOutbox } from "./referenceContribution.js";
import { observeReferencePackages } from "./candidateAdmission.js";

export async function proveSchemaReadiness() {
  let effects = 0;
  const results = await proveSchemaBudget({ schema: POSTGRES_OUTBOX_SCHEMA, createSchemaProbe, checkReadiness, schemaObjectKey,
    makeInput: ({ executor, schemaProbe, mode, database }) => {
      const runtime = createReferenceOutbox({ executor, lease: { claimJobRun: async () => { effects++; throw new Error("unexpected lease"); }, finishJobRun: async () => true },
        handlers: [{ eventType: "example.ready", timeoutMs: 100, handle: async () => { effects++; return { kind: "processed" }; } }], knownEventTypes: ["example.ready"],
        config: { batchSize: 25, maxAttempts: 8, visibilitySeconds: 300, backoffBaseSeconds: 60, backoffCapSeconds: 3600, snoozeSeconds: 300, maxSnoozes: 48, softBudgetMs: 40000 } });
      return { candidate: { artifact: "synthetic", configuration: "synthetic", environment: "test", database, schema: "synthetic" }, ...observeReferencePackages(),
        contributions: [runtime.contribution], vocabulary: [{ eventType: "example.ready", owner: "application" }], exemptions: [],
        bindings: { ports: mode === "ready" ? runtime.ports : {}, triggers: runtime.triggers, routes: {}, env: {} }, schemaProbe };
    } });
  for (const { mode, report } of results) if (mode !== "ready") assert.ok(report.issues.some(issue => issue.code === "OPENLUP_E_PORT_MISSING"));
  assert.equal(effects, 0);
}
