import { describe, expect, it } from "vitest";

import { DomainRpcError } from "../_lib/admin-domain/rpcErrors.js";
import type { AdminBundleWritePort } from "../domains/bundle/adminBundleWritePort.js";
import { BUNDLE_WRITE_SCENARIOS } from "./bundleAdminWriteScenarios.testFixtures.js";

export { BUNDLE_WRITE_SCENARIOS };

/**
 * ONE scenario table for the bundle write port, run against BOTH shipped adapters.
 *
 * The table is the contract. A scenario names the call, the arguments the boundary
 * must receive under exactly those names, and the outcome — a success shape, or a
 * refusal with a SQLSTATE and a reason. Every rule violation the domain declares,
 * the idempotent replay, the dry run and the publish refusal appear here once, so
 * the two chains cannot quietly disagree about any of them: an adapter that renames
 * an argument, drops the mode, swallows a SQLSTATE or invents a default fails on
 * the same line for both.
 *
 * The routine behaviour itself is proved on a real database; what THIS table
 * proves is that a caller cannot tell the two adapters apart.
 */

/** What a scenario expects the boundary to have been called with. */
export interface RoutineCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** A recording client with a scripted answer per routine name. */
export interface ScriptedClient {
  readonly calls: RoutineCall[];
  readonly reads: Array<{ table: string; columns: string; column: string; value: unknown }>;
}

type ClientResult = { data: unknown; error: { code?: string; message?: string } | null };

export interface ScriptedClientOptions {
  /** Answer for the next routine call, by routine name. */
  readonly answers?: Record<string, ClientResult>;
  /** Rows the constraint read returns. */
  readonly rows?: unknown[];
  /** Error the constraint read returns. */
  readonly readError?: { code?: string; message?: string };
}

const OK: ClientResult = { data: { code: "starter-set", idempotent: false, dryRun: false }, error: null };

/** Build a client that records every call and answers from the script. */
export function createScriptedClient(options: ScriptedClientOptions = {}) {
  const calls: RoutineCall[] = [];
  const reads: ScriptedClient["reads"] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(options.answers?.[name] ?? OK);
    },
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: unknown) {
              reads.push({ table, columns, column, value });
              return Promise.resolve({
                data: options.rows ?? [],
                error: options.readError ?? null,
              } as ClientResult);
            },
          };
        },
      };
    },
  };
  return { client, calls, reads };
}

/** Refusals the boundary raises, and the SQLSTATE each one carries. */
export const BUNDLE_REFUSALS = [
  { reason: "actor_required", sqlstate: "42501" },
  { reason: "actor_unknown", sqlstate: "42501" },
  { reason: "publish_requires_human", sqlstate: "42501" },
  { reason: "code_taken", sqlstate: "P0001" },
  { reason: "min_components", sqlstate: "P0001" },
  { reason: "addon_only_composition", sqlstate: "P0001" },
  { reason: "duplicate_component", sqlstate: "P0001" },
  { reason: "component_not_found", sqlstate: "P0002" },
  { reason: "component_not_sellable", sqlstate: "P0001" },
  { reason: "component_currency_mismatch", sqlstate: "P0001" },
  { reason: "target_above_component_sum", sqlstate: "P0001" },
  { reason: "target_below_floor", sqlstate: "P0001" },
  { reason: "price_required_to_sell", sqlstate: "P0001" },
  { reason: "composition_required_to_sell", sqlstate: "P0001" },
  { reason: "fulfillment_mode_unsupported", sqlstate: "P0001" },
  { reason: "restore_requires_archived", sqlstate: "P0001" },
  { reason: "deactivate_requires_active", sqlstate: "P0001" },
  { reason: "clone_source_not_found", sqlstate: "P0002" },
  { reason: "bundle_not_found", sqlstate: "P0002" },
] as const;

export interface BundleWritePortSubject {
  readonly name: string;
  /** Build the port over a scripted client; the adapter supplies its own binding. */
  readonly createPort: (options: ScriptedClientOptions) => {
    port: AdminBundleWritePort;
    calls: RoutineCall[];
    reads: ScriptedClient["reads"];
  };
}

export function describeBundleWritePortContract(subject: BundleWritePortSubject): void {
  describe(`bundle write port contract — ${subject.name}`, () => {
    for (const scenario of BUNDLE_WRITE_SCENARIOS) {
      it(`calls ${scenario.routine} with the contracted arguments: ${scenario.name}`, async () => {
        const { port, calls } = subject.createPort({});
        await scenario.invoke(port);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe(scenario.routine);
        expect(calls[0].args).toEqual(scenario.args);
      });
    }

    it("surfaces a replayed write as idempotent without inventing a result", async () => {
      const { port } = subject.createPort({
        answers: {
          admin_archive_bundle: {
            data: { code: "starter-set", idempotent: true, dryRun: false },
            error: null,
          },
        },
      });
      await expect(port.archive("actor", { mode: "commit", code: "starter-set" } as never)).resolves.toEqual({
        idempotent: true,
        dryRun: false,
        code: "starter-set",
      });
    });

    it("carries the dry-run flag back untouched", async () => {
      const { port } = subject.createPort({
        answers: {
          admin_activate_bundle: {
            data: { code: "starter-set", idempotent: false, dryRun: true },
            error: null,
          },
        },
      });
      await expect(
        port.activate("actor", { mode: "dry_run", code: "starter-set" } as never),
      ).resolves.toEqual({ idempotent: false, dryRun: true, code: "starter-set" });
    });

    it("reports the component count the composition routine returned", async () => {
      const { port } = subject.createPort({
        answers: {
          admin_set_bundle_composition: {
            data: { code: "starter-set", componentCount: 2, idempotent: false, dryRun: false },
            error: null,
          },
        },
      });
      await expect(
        port.setComposition("actor", { mode: "commit", code: "starter-set", components: [] } as never),
      ).resolves.toEqual({
        idempotent: false,
        dryRun: false,
        code: "starter-set",
        componentCount: 2,
      });
    });

    for (const refusal of BUNDLE_REFUSALS) {
      it(`surfaces ${refusal.reason} with SQLSTATE ${refusal.sqlstate}`, async () => {
        const { port } = subject.createPort({
          answers: {
            admin_activate_bundle: {
              data: null,
              error: { code: refusal.sqlstate, message: refusal.reason },
            },
          },
        });
        const failure = await port
          .activate("actor", { mode: "commit", code: "starter-set" } as never)
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(failure).toBeInstanceOf(DomainRpcError);
        expect((failure as DomainRpcError).sqlstate).toBe(refusal.sqlstate);
        expect((failure as Error).message).toContain(refusal.reason);
      });
    }

    it("refuses a machine actor's publish exactly as the boundary raised it", async () => {
      // The port never decides this. The handler refused it once from the spec's
      // allowedActorKinds; the boundary refuses it again and independently, and the
      // port's only job is to carry that refusal through unchanged.
      const { port } = subject.createPort({
        answers: {
          admin_activate_bundle: {
            data: null,
            error: { code: "42501", message: "publish_requires_human" },
          },
        },
      });
      await expect(
        port.activate("machine-actor", { mode: "commit", code: "starter-set" } as never),
      ).rejects.toThrow(/publish_requires_human/);
    });

    it("reads the stored constraint envelope before a composition is validated", async () => {
      const { port, reads } = subject.createPort({
        rows: [
          {
            code: "starter-set",
            composition_constraint: { kind: "fixed.catalog", version: 2, data: { slots: 3 } },
          },
        ],
      });
      await expect(port.loadCompositionConstraint("starter-set")).resolves.toEqual({
        kind: "fixed.catalog",
        version: 2,
        data: { slots: 3 },
      });
      expect(reads).toEqual([
        {
          table: "catalog_bundles",
          columns: "code, composition_constraint",
          column: "code",
          value: "starter-set",
        },
      ]);
    });

    it("treats an empty envelope as unconstrained rather than as a missing bundle", async () => {
      const { port } = subject.createPort({
        rows: [{ code: "starter-set", composition_constraint: {} }],
      });
      await expect(port.loadCompositionConstraint("starter-set")).resolves.toBeNull();
    });

    it("refuses a constraint read for a bundle that does not exist", async () => {
      const { port } = subject.createPort({ rows: [] });
      await expect(port.loadCompositionConstraint("missing")).rejects.toThrow(/bundle_not_found/);
    });
  });
}
