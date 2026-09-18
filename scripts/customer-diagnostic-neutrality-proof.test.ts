import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FALSIFIERS,
  buildNeutralityReceipt,
  composeEnv,
  providerEnvKeys,
  readFlag,
  type NeutralityReceipt,
} from "./customer-diagnostic-neutrality-proof.ts";
import type { LegOutcome } from "./customer-diagnostic-neutrality-legs.ts";

const pass = (id: number, name: string): LegOutcome => ({ id, name, status: "pass", detail: `${name} ok` });

function receipt(legs: LegOutcome[]): NeutralityReceipt {
  return buildNeutralityReceipt({
    legs, migrationUnits: 67,
    operatorId: "7f4d0a52-0c3a-4f2f-9f4a-1c9b5e0d8a31",
    database: "postgres://postgres:postgres@127.0.0.1:55432/customer_diagnostic_neutrality_probe",
    dataLane: "postgres", providerEnvKeys: [],
    generatedAt: "2026-09-14T00:00:00.000Z",
  });
}

describe("customer diagnostic neutrality receipt", () => {
  it("emits its own shape and is deliberately not a CanaryReceipt", () => {
    const built = receipt([pass(1, "ingest")]);
    expect(Object.keys(built)).toEqual([
      "schemaVersion", "legs", "counts", "outcomes", "unknowns", "generatedAt",
    ]);
    // `scripts/edge-canary/receipt.ts` requires these; this axis proves a database, not a deployment.
    for (const foreign of ["sourceSha", "targetClasses", "rollback", "identifiers", "immutableDeploymentUrl"]) {
      expect(built).not.toHaveProperty(foreign);
    }
  });

  it("refuses a green verdict on an unknown leg and records it rather than dropping it", () => {
    const built = receipt([
      pass(1, "ingest"),
      { id: 12, name: "node-scheduler-drive", status: "unknown", detail: "no scheduler handler on this bundle" },
    ]);
    expect(built.outcomes.verdict).toBe("fail");
    expect(built.counts.unknown).toBe(1);
    expect(built.counts.pass).toBe(1);
    expect(built.unknowns).toEqual(["node-scheduler-drive: no scheduler handler on this bundle"]);
  });

  it("fails on a failed leg and passes only when every leg is a pass", () => {
    const failed = receipt([pass(1, "ingest"), { id: 8, name: "browser-role-denial", status: "fail", detail: "reached" }]);
    expect(failed.outcomes.verdict).toBe("fail");
    expect(failed.counts.fail).toBe(1);
    const green = receipt([pass(1, "ingest"), pass(2, "search")]);
    expect(green.outcomes.verdict).toBe("pass");
    expect(green.unknowns).toEqual([]);
  });

  it("fingerprints the operator and the database instead of recording either value", () => {
    const built = receipt([pass(1, "ingest")]);
    expect(built.outcomes.operator).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.outcomes.database).toMatch(/^sha256:[0-9a-f]{64}$/);
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain("7f4d0a52-0c3a-4f2f-9f4a-1c9b5e0d8a31");
    expect(serialized).not.toContain("127.0.0.1");
  });

  it("names the neutrality facts the packet reads and never launders delivery", () => {
    const built = receipt([pass(1, "ingest")]);
    expect(built.outcomes.bundle).toBe("node-postgres");
    expect(built.outcomes.migrationSource).toContain("db/platform/migrations");
    expect(built.outcomes.pruneDriver).toContain("node_cron");
    expect(built.outcomes.pruneDriver).toContain("driver=worker");
    expect(built.outcomes.deliveryHealth).toBe("unknown");
    expect(built.counts.migrationUnits).toBe(67);
  });

  it("reports the lane it measured and separates it from the claim it only declares", () => {
    const built = receipt([pass(1, "ingest")]);
    expect(built.outcomes.dataLane).toBe("postgres (measured via resolveCustomerDiagnosticLane)");
    expect(built.outcomes.providerEnvKeys).toBe("none");
    expect(built.counts.providerEnvKeys).toBe(0);
    // The module graph is not readable from inside an ESM process, so this must not read as measured.
    expect(built.outcomes.providerIndependence).toMatch(/^declared design fact/);
    expect(built.outcomes).not.toHaveProperty("providerModulesOnPath");
  });

  it("records provider credentials it finds instead of asserting none", () => {
    const built = buildNeutralityReceipt({
      legs: [pass(1, "ingest")], migrationUnits: 67, operatorId: "operator", database: "db",
      dataLane: "managed", providerEnvKeys: ["SUPABASE_URL", "VERCEL_ENV"],
    });
    expect(built.outcomes.providerEnvKeys).toBe("SUPABASE_URL, VERCEL_ENV");
    expect(built.counts.providerEnvKeys).toBe(2);
    expect(built.outcomes.dataLane).toContain("managed");
  });
});

describe("provider credential measurement", () => {
  it("finds provider-owned keys and ignores the portable ones", () => {
    expect(providerEnvKeys(composeEnv("postgres://localhost/probe"))).toEqual([]);
    expect(providerEnvKeys({
      DATABASE_URL: "postgres://localhost/probe", PLATFORM_BUNDLE: "node-postgres",
      VERCEL_ENV: "preview", SUPABASE_SERVICE_ROLE_KEY: "x", NEXT_PUBLIC_SUPABASE_URL: "y",
    })).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VERCEL_ENV"]);
  });
});

describe("seeded falsifiers", () => {
  it("carries one planted defect per named leg, including the ledger anti-masking count", () => {
    expect(Object.keys(FALSIFIERS).sort()).toEqual(["browser-role-grant", "ledger-inactive-driver"]);
    expect(FALSIFIERS["browser-role-grant"]!.leg).toBe(8);
    expect(FALSIFIERS["browser-role-grant"]!.sql).toContain("GRANT EXECUTE ON FUNCTION");
    const ledger = FALSIFIERS["ledger-inactive-driver"]!;
    expect(ledger.leg).toBe(13);
    // The refusal reason lives in the `error` COLUMN, and the row is backdated so only the
    // anti-masking count can trip - never leg 13's "latest run" assertion.
    expect(ledger.sql).toContain("'inactive_driver'");
    expect(ledger.sql).toContain("error");
    expect(ledger.sql).toContain("now() - interval '1 hour'");
    expect(ledger.sql).not.toContain("metadata");
  });
});

describe("customer diagnostic neutrality driver inputs", () => {
  it("composes one node-postgres env whose throwaway ingress key is fresh per run", () => {
    const first = composeEnv("postgres://localhost/probe");
    const second = composeEnv("postgres://localhost/probe");
    expect(first.PLATFORM_BUNDLE).toBe("node-postgres");
    expect(first.DATABASE_URL).toBe("postgres://localhost/probe");
    expect(first.COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED).toBe("true");
    expect(first.VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED).toBe("true");
    expect(first.COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED).toBe("true");
    expect(first.CUSTOMER_DIAGNOSTIC_RETENTION_DAYS).toBe("14");
    // 32 characters is the binding's own floor (`readHistoryConfig`), below which ingest refuses.
    expect(first.CUSTOMER_DIAGNOSTIC_INGRESS_KEY!.length).toBeGreaterThanOrEqual(32);
    expect(first.CUSTOMER_DIAGNOSTIC_INGRESS_KEY).not.toBe(second.CUSTOMER_DIAGNOSTIC_INGRESS_KEY);
  });

  it("keeps the throwaway ingress key out of the receipt entirely", () => {
    const env = composeEnv("postgres://localhost/probe");
    const built = buildNeutralityReceipt({
      legs: [pass(1, "ingest")], migrationUnits: 67,
      operatorId: "operator", database: env.DATABASE_URL!,
      dataLane: "postgres", providerEnvKeys: providerEnvKeys(env),
    });
    expect(JSON.stringify(built)).not.toContain(env.CUSTOMER_DIAGNOSTIC_INGRESS_KEY!);
  });

  it("reads --out and --falsifier in both spellings", () => {
    expect(readFlag(["--out=receipt.json"], "out")).toBe("receipt.json");
    expect(readFlag(["--out", "receipt.json"], "out")).toBe("receipt.json");
    expect(readFlag(["--falsifier", "browser-role-grant"], "falsifier")).toBe("browser-role-grant");
    expect(readFlag(["--out=receipt.json"], "falsifier")).toBeUndefined();
  });
});

// The Wave 5 rework: this proof is RETAINED by the publication delta, so its closure may not reach a
// withheld module and it may not ship a Git executable. All three were violations once — the
// scheduler-handler module, the edge-canary fingerprint, and a `.sh` wrapper carrying a shebang.
//
// ⛔ The withheld names below are literals on purpose. `assertRetainedSourceWithholdClosure` treats a
// retained source that READS a withheld path as a violation in its own right, and
// `config/oss-core-readiness-blockers.json` is itself withheld — so loading the catalogue here to
// derive them would reintroduce exactly the defect this block exists to catch. The catalogue-wide
// check is the generator's job; this is the local regression pin.
const WITHHELD_MODULES = ["server/runtime/scheduledJobHandlers.ts"];
const WITHHELD_PREFIXES = ["scripts/edge-canary/", "scripts/secrets/", "scripts/openlup/"];

// ⛔ Both reads are LITERAL. A retained source whose filesystem path the closure checker cannot
// resolve statically becomes an `opaqueSourceDependencyEdges` entry in the frozen publication
// catalogue, and this file iterating a path array produced exactly that drift once.
describe("OSS publication closure", () => {
  const PROOF = readFileSync("scripts/customer-diagnostic-neutrality-proof.ts", "utf8");
  const LEGS = readFileSync("scripts/customer-diagnostic-neutrality-legs.ts", "utf8");
  const SOURCES: Array<[string, string]> = [
    ["scripts/customer-diagnostic-neutrality-proof.ts", PROOF],
    ["scripts/customer-diagnostic-neutrality-legs.ts", LEGS],
  ];

  const repoImports = (source: string): string[] => source
    .split("\n")
    .flatMap((line) => /from "(\.[^"]+)"/.exec(line)?.[1] ?? [])
    .map((specifier) => {
      const base = specifier.startsWith("./") ? "scripts/" : "";
      return `${base}${specifier.replace(/^\.\.\//, "").replace(/^\.\//, "")}`.replace(/\.js$/, ".ts");
    });

  it("resolves both sources to the ports they are supposed to drive", () => {
    const all = SOURCES.flatMap(([, contents]) => repoImports(contents));
    expect(all).toContain("server/bff/platform/customer-diagnostic-events.ts");
    expect(all).toContain("server/runtime/observability/customerDiagnosticPruneRuntime.ts");
    expect(all).toContain("server/adapters/postgres/migrationRunner.ts");
  });

  it("imports no module the publication withholds", () => {
    for (const [name, contents] of SOURCES) {
      const reached = repoImports(contents).filter((target) =>
        WITHHELD_MODULES.includes(target) || WITHHELD_PREFIXES.some((prefix) => target.startsWith(prefix)));
      expect(reached, name).toEqual([]);
    }
  });

  it("drives the drain through the retained runtime, not the withheld scheduler module", () => {
    expect(LEGS).toContain("runCustomerDiagnosticPrune");
    expect(LEGS).toContain('invocationSource: "node_cron"');
    expect(repoImports(LEGS)).not.toContain("server/runtime/scheduledJobHandlers.ts");
  });

  it("ships no shell executable beside the proof", () => {
    expect(existsSync("scripts/customer-diagnostic-neutrality-proof.sh")).toBe(false);
  });

  // ⛔ The needles are ASSEMBLED, never written out. `isDirectExecutionEntrypoint` regexes the whole
  // file, so spelling any of them literally here would make THIS retained test an entrypoint too.
  it("keeps both retained files out of the direct-execution-entrypoint class", () => {
    const argv = ["process", "argv"].join(".");
    const meta = ["import", "meta"].join(".");
    const requireMain = ["require", "main"].join(".");
    for (const [name, contents] of SOURCES) {
      expect(contents.startsWith(`#${"!"}`), `${name} shebang`).toBe(false);
      expect(contents.includes(argv), `${name} argument vector`).toBe(false);
      expect(contents.includes(meta), `${name} import meta`).toBe(false);
      expect(contents.includes(requireMain), `${name} require main`).toBe(false);
    }
  });
});
