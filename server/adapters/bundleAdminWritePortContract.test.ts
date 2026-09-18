import { describe, expect, it } from "vitest";

import {
  createScriptedClient,
  describeBundleWritePortContract,
  BUNDLE_REFUSALS,
  type RoutineCall,
  type ScriptedClientOptions,
} from "./bundleAdminWritePortContract.testFixtures.js";
import { createManagedBundleAdminWriteStore } from "./supabase/bundleAdminWriteStore.js";
import { createPostgresBundleAdminWriteStore } from "./postgres/bundleAdminWriteStore.js";
import { BUNDLE_RULE_CODES } from "../../src/domains/bundle/bundleRuleCodes.js";
import { bundleSpec } from "../../src/domains/bundle/bundleSpec.js";

/**
 * The two shipped adapters, driven through ONE scenario table.
 *
 * The managed adapter takes its routine client directly. The direct-Postgres one
 * owns a pooled transaction lane, so it is given a stub pool whose client reads the
 * SQL the lane actually renders and answers from the same script: the lane, the
 * BEGIN/COMMIT, the named-argument rendering and the release are all exercised, and
 * only the server itself is absent. That is what makes the two rows of the table
 * comparable rather than two different tests wearing one name.
 */

const RPC_PATTERN = /^SELECT \* FROM "([a-z_]+)"\((.*)\)$/s;
const ARG_PATTERN = /"([a-z_]+)" => \$(\d+)/g;
const SELECT_PATTERN = /^SELECT (.+) FROM "([a-z_]+)" WHERE "([a-z_]+)" = \$1$/s;

/** Read back the call the lane rendered, so the assertion is on real SQL. */
function parseRoutineCall(text: string, values: unknown[]): RoutineCall | null {
  const match = RPC_PATTERN.exec(text.trim());
  if (!match) return null;
  const args: Record<string, unknown> = {};
  for (const arg of match[2].matchAll(ARG_PATTERN)) {
    args[arg[1]] = values[Number(arg[2]) - 1];
  }
  return { name: match[1], args };
}

function createPostgresSubjectPort(options: ScriptedClientOptions) {
  const calls: RoutineCall[] = [];
  const reads: Array<{ table: string; columns: string; column: string; value: unknown }> = [];
  const poolClient = {
    query(text: string, values: unknown[] = []) {
      const call = parseRoutineCall(text, values);
      if (call) {
        calls.push(call);
        const scripted = options.answers?.[call.name];
        if (scripted?.error) {
          const failure = Object.assign(new Error(scripted.error.message ?? "failed"), {
            code: scripted.error.code,
          });
          return Promise.reject(failure);
        }
        const data = scripted?.data ?? { code: "starter-set", idempotent: false, dryRun: false };
        return Promise.resolve({ rows: [{ [call.name]: data }] });
      }
      const select = SELECT_PATTERN.exec(text.trim());
      if (select) {
        reads.push({
          table: select[2],
          // The lane quotes every identifier it renders; the managed client forwards
          // the column list as written. Unquoting compares WHICH columns were asked
          // for — the contract — rather than how one chain spells an identifier.
          columns: select[1].replace(/"/g, ""),
          column: select[3],
          value: values[0],
        });
        if (options.readError) {
          return Promise.reject(
            Object.assign(new Error(options.readError.message ?? "failed"), {
              code: options.readError.code,
            }),
          );
        }
        return Promise.resolve({ rows: options.rows ?? [] });
      }
      // BEGIN / COMMIT / ROLLBACK.
      return Promise.resolve({ rows: [] });
    },
    release() {},
  };
  const pool = { connect: () => Promise.resolve(poolClient), end: () => Promise.resolve() };
  const port = createPostgresBundleAdminWriteStore(
    { connectionString: "postgres://bundle-write-contract" },
    { poolFactory: () => pool as never },
  );
  return { port, calls, reads };
}

describeBundleWritePortContract({
  name: "managed adapter",
  createPort: (options) => {
    const { client, calls, reads } = createScriptedClient(options);
    return { port: createManagedBundleAdminWriteStore(client), calls, reads };
  },
});

describeBundleWritePortContract({
  name: "direct-Postgres adapter",
  createPort: createPostgresSubjectPort,
});

describe("bundle write port — the domain's vocabulary is complete", () => {
  it("every refusal the scenario table asserts is a declared rule or a boundary refusal", () => {
    const declared = new Set(BUNDLE_RULE_CODES.map((code) => code.toLowerCase()));
    // These four are not rule codes: they are the boundary declining to act at all.
    const boundaryReasons = new Set([
      "actor_required",
      "actor_unknown",
      "publish_requires_human",
      "bundle_not_found",
    ]);
    for (const refusal of BUNDLE_REFUSALS) {
      const known = declared.has(refusal.reason) || boundaryReasons.has(refusal.reason);
      expect(known, `${refusal.reason} is neither a declared rule nor a boundary refusal`).toBe(true);
    }
  });

  it("the two publish-state mutations are human-only and activation-gated", () => {
    const humanOnly = Object.values(bundleSpec.mutations)
      .filter((mutation) => mutation.lifecycleMarkers.length > 0)
      .map((mutation) => mutation.key)
      .sort();
    expect(humanOnly).toEqual(["activate", "deactivate"]);
    for (const key of humanOnly) {
      const mutation = Object.values(bundleSpec.mutations).find((entry) => entry.key === key);
      expect(mutation?.allowedActorKinds).toEqual(["human"]);
      expect(mutation?.gate).toBe("activation");
    }
  });
});
