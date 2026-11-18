import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogCapabilityDescriptor } from "./publicationPorts.js";

type Observed = "ready" | "unadopted" | "unsupported" | "dependency_unavailable";
/** Live evidence for the selected executor and catalogue scope. @experimental */
export interface CatalogRuntimeObservation {
  schemaCompatible: boolean;
  privilegeGranted: boolean;
  state: Observed;
}
type Refusal = { outcome: Exclude<Observed, "ready">; reason: string };
type PortLane<Port> = {
  port: Port;
  enabled: () => boolean;
  observe: () => Promise<CatalogRuntimeObservation>;
};
type LaneName = "publicationRead" | "publish" | "lifecycleWrite" | "shopper" | "settlement" | "account" | "editor" | "renewal" | "successor";
const availability = {
  unadopted: "catalog_scope_unadopted",
  unsupported: "catalog_capability_unsupported",
  dependency_unavailable: "dependency_unavailable",
} as const;
const refuse = (outcome: Refusal["outcome"]): Refusal => ({ outcome, reason: availability[outcome] });

/**
 * Check grants and visibility as the actual executor login. A relation whose
 * reads are filtered by row-level security cannot establish a complete scope.
 * @experimental
 */
export async function observePostgresCatalogPrivileges(executor: PgQueryExecutor, requirements: {
  relations?: readonly string[];
  functions?: readonly string[];
  columns?: readonly { relation: string; column: string }[];
}) {
  const { relations = [], functions = [], columns = [] } = requirements;
  if (relations.length + functions.length + columns.length === 0) return false;
  const { rows } = await executor.query(`WITH
    relations AS (SELECT to_regclass(name) AS id FROM unnest($1::text[]) name),
    routines AS (SELECT to_regprocedure(name) AS id FROM unnest($2::text[]) name),
    columns AS (SELECT to_regclass(relation) AS relation_id,value.column FROM jsonb_to_recordset($3::jsonb) AS value(relation text,"column" text))
    SELECT NOT EXISTS (SELECT 1 FROM relations r LEFT JOIN pg_class c ON c.oid=r.id
        WHERE r.id IS NULL OR NOT has_schema_privilege(c.relnamespace,'USAGE') OR NOT has_table_privilege(r.id,'SELECT') OR row_security_active(r.id)) AS readable,
      NOT EXISTS (SELECT 1 FROM routines r LEFT JOIN pg_proc p ON p.oid=r.id
        WHERE r.id IS NULL OR NOT has_schema_privilege(p.pronamespace,'USAGE') OR NOT has_function_privilege(r.id,'EXECUTE')) AS callable,
      NOT EXISTS (SELECT 1 FROM columns c WHERE c.relation_id IS NULL OR NOT EXISTS(
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.relation_id AND a.attname=c.column AND a.attnum>0 AND NOT a.attisdropped)) AS compatible`,
  [relations, functions, JSON.stringify(columns)]);
  return rows.length === 1 && rows[0]?.readable === true && rows[0].callable === true && rows[0].compatible === true;
}

/**
 * Compose selected installed ports and their live observations. An omitted
 * lane is unsupported. Disabling authoring leaves independently bound lanes
 * available, including retained reads and renewal.
 * @experimental
 */
export function createCatalogRuntimeBinding<Ports extends Partial<Record<LaneName, unknown>>>(input: {
  ports?: { [Lane in keyof Ports]?: PortLane<Ports[Lane]> };
  writerEnabled?: () => boolean;
  existing?: Pick<CatalogCapabilityDescriptor, "read" | "draft">;
} = {}) {
  const lanes = input.ports;
  function lane<Key extends keyof Ports & LaneName>(name: Key): PortLane<Ports[Key]> | undefined {
    return lanes?.[name];
  }
  async function observe(name: LaneName): Promise<Observed> {
    const selected = lane(name as keyof Ports & LaneName);
    if (!selected || selected.port === undefined || selected.port === null) return "unsupported";
    try {
      if (selected.enabled() !== true) return "unsupported";
      if ((name === "publish" || name === "lifecycleWrite") && input.writerEnabled?.() !== true) return "unsupported";
      const observed = await selected.observe();
      if (observed.state === "dependency_unavailable") return observed.state;
      if (observed.schemaCompatible !== true || observed.privilegeGranted !== true) return "unsupported";
      return observed.state === "ready" || observed.state === "unadopted" || observed.state === "unsupported" ? observed.state : "dependency_unavailable";
    } catch {
      return "dependency_unavailable";
    }
  }
  async function use<Key extends keyof Ports & LaneName, Value>(name: Key, run: (port: Ports[Key]) => Promise<Value>) {
    const outcome = await observe(name);
    if (outcome !== "ready") return refuse(outcome);
    try { return { outcome: "ready" as const, value: await run(lane(name)!.port) }; }
    catch { return refuse("dependency_unavailable"); }
  }
  return {
    observe,
    use,
    /** One scope-bound, sticky observation per quote evaluation batch. */
    quoteBatch<Value>(read: (port: Ports["shopper"]) => Promise<Value>) {
      let pending: Promise<{ outcome: "ready"; value: Value } | Refusal> | undefined;
      return () => pending ??= use("shopper" as keyof Ports & LaneName, port => read(port as Ports["shopper"]));
    },
    async capabilities(): Promise<CatalogCapabilityDescriptor> {
      const [read, publish, lifecycle] = await Promise.all([observe("publicationRead"), observe("publish"), observe("lifecycleWrite")]);
      return { read: input.existing?.read === true, draft: input.existing?.draft === true,
        publicationRead: read === "ready", publish: publish === "ready", lifecycleWrite: lifecycle === "ready" };
    },
  };
}
