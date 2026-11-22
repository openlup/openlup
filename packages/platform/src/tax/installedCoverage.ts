import { taxCoverageV1Schema } from "./contracts/index.js";
import type { TaxCoverageV1 } from "./contracts/index.js";
import { ref } from "./contracts/schemas.js";

interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

type Scope = Readonly<{ installationRef: string; accountRef: string }>;

/** @experimental Stored coverage revision. The timestamp is UTC with microsecond precision. */
export interface TaxCoverageRevision {
  readonly installation_ref: string;
  readonly account_ref: string;
  readonly revision: string;
  readonly sequence_no: number;
  readonly previous_revision: string | null;
  readonly coverage: TaxCoverageV1;
  readonly coverage_digest: string;
  readonly actor_ref: string;
  readonly recorded_at: string;
}

type ApplyInput = Readonly<{
  expectedHead: string | null;
  document: Scope & Readonly<{ actorRef: string; coverage: TaxCoverageV1 }>;
}>;
type ApplyRefusal = Readonly<{
  kind: "refused";
  code: "tax_invalid_input" | "tax_coverage_revision_conflict";
  field: string;
  remedy: string;
}>;

const invalidRemedy = "Supply the documented declaration or request shape.";
const conflictRemedy = "Replay the original document or read the current head and submit a new revision.";

/** @experimental Append or replay one revision using a migration-owner executor in READ COMMITTED. */
export async function applyTaxCoverageRevision(ownerExecutor: Executor, input: ApplyInput): Promise<TaxCoverageRevision | ApplyRefusal> {
  const request = { ...input.document, expectedRevision: input.expectedHead };
  try {
    const { rows } = await ownerExecutor.query(`SELECT installation_ref, account_ref, revision, sequence_no,
      previous_revision, coverage, coverage_digest, actor_ref,
      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
      FROM public.tax_coverage_append_v1($1::jsonb)`, [JSON.stringify(request)]);
    if (!rows[0]) throw new Error("Coverage append returned no revision.");
    return rows[0] as unknown as TaxCoverageRevision;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "22P05")
      return { kind: "refused", code: "tax_invalid_input", field: "", remedy: invalidRemedy };
    if (!(error instanceof Error && "code" in error && error.code === "22023"
      && "detail" in error && typeof error.detail === "string")) throw error;
    if (error.message === "tax_coverage_revision_conflict")
      return { kind: "refused", code: error.message, field: error.detail, remedy: conflictRemedy };
    if (error.message !== "tax_invalid_input") throw error;
    return { kind: "refused", code: error.message, field: error.detail, remedy: invalidRemedy };
  }
}

/** @experimental Bind the connected settings reader to a host-selected native installation and account. */
export function bindTaxCoverageReader(db: Executor, scope: Scope) {
  const installationRef = ref(scope.installationRef, "/installationRef");
  const accountRef = ref(scope.accountRef, "/accountRef");
  return async () => {
    const { rows } = await db.query(`SELECT * FROM public.tax_coverage_read_v1($1::text,$2::text)
      ORDER BY sequence_no DESC LIMIT 1`, [installationRef, accountRef]);
    const row = rows[0];
    if (!row) return { present: false } as const;
    const coverage = taxCoverageV1Schema.parse(row.coverage);
    if (coverage.accountRef !== accountRef || coverage.revision !== row.revision) throw new Error("Coverage scope or revision changed.");
    const value = { ...coverage, declarations: [...coverage.declarations] };
    return { present: true, value, revision: coverage.revision } as const;
  };
}

const reference = { type: "string", minLength: 1, maxLength: 256 } as const;
const instant = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" } as const;
const declaration = { jurisdiction: reference, taxKind: reference, actorRef: reference, recordedAt: instant,
  effective: { type: "object", additionalProperties: false, required: ["from"], properties: { from: instant, until: instant } } };

function record(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

const example = { schemaVersion: 1, accountRef: "account-a", revision: "coverage-1", declarations: [] } as const;

/** @experimental Discovery and validation for merchant tax coverage declarations. */
export function describeTaxCoverageSetting() {
  return {
    key: "tax.coverage",
    domain: "tax",
    kind: "installed",
    goal: "Record and inspect merchant tax coverage declarations by jurisdiction, tax kind and effective dates.",
    schemaVersion: 1,
    schema: record({
      schemaVersion: { const: 1 }, accountRef: reference, revision: reference,
      declarations: { type: "array", items: { oneOf: [
        record({ ...declaration, status: { const: "registered" } }),
        record({ ...declaration, status: { const: "not_registered_acknowledged" }, acknowledgementRef: reference }),
      ] } },
    }),
    rules: [{
      code: "tax_invalid_input",
      path: [],
      description: "Supply the documented declaration or request shape. Use nonoverlapping intervals for each jurisdiction and tax kind, and include an acknowledgement reference for declarations of non-registration.",
      check: (value: unknown) => taxCoverageV1Schema.safeParse(value).success,
    }],
    examples: [{ value: example }, { value: { ...example, revision: "" }, code: "tax_invalid_input" }],
    fallback: null,
    absentMeans: { description: "No coverage revisions have been installed for the selected account.", source: "Native tax coverage history", value: null },
    defaultBasis: { kind: "neutral" },
    whyThisDefault: "The merchant declares its coverage explicitly.",
    effect: {
      appliesTo: "The installed history records the merchant's coverage for the selected account.",
      frozenOn: ["Previous declarations retain their original revisions and operator references."],
      impact: "operations",
    },
    runtime: {
      level: "read-only",
      reason: "Tax coverage history is available on qualified native PostgreSQL installations through a host-bound reader. Managed installations do not supply this capability. Applying the native forward makes history available for installation and inspection. Tax checkout consumption is qualified separately.",
    },
    change: { reference: "@openlup/platform README, Install and inspect tax coverage" },
  } as const;
}
