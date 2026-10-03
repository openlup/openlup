// Pure builder and reader for the schema probe: one catalogue query that says,
// for each required object, whether the connected PostgreSQL schema has it.
// The query reads only `pg_catalog`, so a missing object is `false`, never an
// error. The application runs it through its own `SqlExecutor`.

import type { RequiredSchemaObject } from "./index.js";

/**
 * Asks whether each required object exists, in order. Readiness calls it once
 * with every object of every contribution. A rejected promise means the probe
 * could not answer; readiness then rejects too.
 * @beta
 */
export interface SchemaProbePort {
  probe(objects: ReadonlyArray<RequiredSchemaObject>): Promise<ReadonlyArray<boolean>>;
}

/** @beta */
export interface SchemaProbeQuery {
  readonly text: string;
  readonly values: [
    kinds: string[],
    schemas: Array<string | null>,
    names: string[],
    columns: Array<string | null>,
    signatures: Array<string | null>,
  ];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const SCHEMA_MATCH = `CASE WHEN probe.schema_name IS NULL
              THEN n.nspname = ANY (pg_catalog.current_schemas(false))
              ELSE n.nspname = probe.schema_name END`;

const PROBE_TEXT = `SELECT probe.ordinality::integer AS "index",
       CASE probe.kind
         WHEN 'table' THEN EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = probe.object_name
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND ${SCHEMA_MATCH})
         WHEN 'column' THEN EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = probe.object_name
              AND a.attname = probe.column_name
              AND a.attnum > 0
              AND NOT a.attisdropped
              AND ${SCHEMA_MATCH})
         WHEN 'function' THEN EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = probe.object_name
              AND (probe.signature IS NULL
                   OR pg_catalog.oidvectortypes(p.proargtypes) = probe.signature)
              AND ${SCHEMA_MATCH})
         ELSE false
       END AS present
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
       WITH ORDINALITY AS probe(kind, schema_name, object_name, column_name, signature, ordinality)
 ORDER BY probe.ordinality`;

/**
 * The argument types of a function signature in the form PostgreSQL prints
 * them: lower case, single spaces, separated by `", "`.
 */
function normalizeSignature(signature: string): string {
  return signature
    .split(",")
    .map((type) => type.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((type) => type.length > 0)
    .join(", ");
}

function splitName(object: RequiredSchemaObject): {
  schema: string | null;
  name: string;
  column: string | null;
} {
  const parts = object.name.split(".");
  const columnPart = object.kind === "column" ? 1 : 0;
  const valid =
    parts.length >= 1 + columnPart &&
    parts.length <= 2 + columnPart &&
    parts.every((part) => IDENTIFIER.test(part));
  if (!valid) {
    throw new TypeError(
      `requiredSchema ${object.kind} name must be ${
        object.kind === "column" ? "[schema.]table.column" : "[schema.]name"
      } in lower-case identifiers, not ${JSON.stringify(object.name)}`,
    );
  }
  const column = columnPart ? (parts.pop() ?? null) : null;
  const name = parts.pop() as string;
  return { schema: parts.pop() ?? null, name, column };
}

/**
 * Builds the probe query for `objects`. A table or function name may be
 * schema-qualified; an unqualified name matches any schema on the search path.
 * A column is named `[schema.]table.column`. A function `signature` lists its
 * argument types as `pg_catalog.oidvectortypes` prints them, and `""` means no
 * arguments; without a signature any overload satisfies the entry.
 * @beta
 */
export function buildSchemaProbe(objects: ReadonlyArray<RequiredSchemaObject>): SchemaProbeQuery {
  const values: SchemaProbeQuery["values"] = [[], [], [], [], []];
  for (const object of objects) {
    if (!["table", "column", "function"].includes(object.kind)) {
      throw new TypeError(`requiredSchema object kind is not table, column or function: ${String(object.kind)}`);
    }
    if (object.signature !== undefined && object.kind !== "function") {
      throw new TypeError(`requiredSchema ${object.kind} ${object.name} cannot carry a signature`);
    }
    const { schema, name, column } = splitName(object);
    values[0].push(object.kind);
    values[1].push(schema);
    values[2].push(name);
    values[3].push(column);
    values[4].push(object.signature === undefined ? null : normalizeSignature(object.signature));
  }
  return { text: PROBE_TEXT, values };
}

/**
 * Reads the probe's rows into one presence flag per object, in the order
 * `buildSchemaProbe` received them. It throws when the rows are not the
 * probe's answer for exactly `count` objects.
 * @beta
 */
export function readSchemaProbe(
  result: { readonly rows: ReadonlyArray<Record<string, unknown>> },
  count: number,
): boolean[] {
  const present = new Array<boolean | undefined>(count).fill(undefined);
  for (const row of result.rows) {
    const index = typeof row.index === "string" ? Number(row.index) : row.index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > count ||
      present[index - 1] !== undefined ||
      typeof row.present !== "boolean"
    ) {
      throw new TypeError(`schema probe returned an unexpected row: ${JSON.stringify(row)}`);
    }
    present[index - 1] = row.present;
  }
  if (present.some((flag) => flag === undefined)) {
    throw new TypeError(`schema probe answered ${result.rows.length} of ${count} objects`);
  }
  return present as boolean[];
}
