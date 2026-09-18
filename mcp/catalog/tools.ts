import { catalogSpec } from "../../src/domains/commerce/catalogSpec.js";
import { toolInputSchema, type McpToolDefinition } from "../_core/toolFromContract.js";

/**
 * The local stdio catalog surface: the admin reads, plus validate/diff and
 * propose over the revisioned document-proposal authority (W3f-c).
 *
 * It is no longer read-only — `catalog__propose_document` writes one row — but it
 * still cannot publish anything. The submitted row's `publication_ready` is
 * false by CHECK constraint, so it makes nothing sellable and moves no document
 * pointer; publish, decision and rollback are `auth.uid()`-gated human acts that
 * no BFF route exposes at all, so there is nothing here for a tool to point at.
 *
 * The W3c fence is unchanged: every legacy catalog mutation (create_draft,
 * update_draft, set_price, archive, activate, archive_product, restore,
 * clone_draft, deactivate) still gets no tool. Do not turn one of them into a
 * dry-run validator here — its implementation reaches the legacy write boundary,
 * whose routes answer `legacy_catalog_mutation_fenced` and whose RPCs raise
 * `42501`. The document-proposal route is the only write this file may name.
 */
const CATALOG_BFF_BASE = "/api/bff/admin/commerce/catalog";

/** `POST` — one operation, two modes (`dry_run` validates/diffs, `commit` submits). */
const DOCUMENT_PROPOSAL_PATH = `${CATALOG_BFF_BASE}/document-proposal`;

interface ProposalToolSpec {
  /** Tool name suffix; the full name keeps the `${domainKey}__<key>` convention. */
  readonly key: string;
  readonly mode: "commit" | "dry_run";
  readonly description: string;
}

/**
 * The WRITE ALLOW-LIST — one mutation key, spelled out as a literal, in the same
 * shape as the read maps below.
 *
 * ⛔ Do NOT iterate `catalogSpec.mutations` to build this list. That record is
 * the domain's whole write surface: `propose_document` plus the nine legacy
 * catalog mutations W3c fenced. A loop over it would advertise the entire fenced
 * surface on the agent head, which makes the fence the author of a scope
 * decision instead of a backstop — and the next wave that adds a catalog
 * mutation would publish it to agents by accident. W3f-a already shipped a
 * broken tool exactly this way, by adding one entry to `catalogSpec.queries`
 * while the read builder iterated the whole record.
 *
 * So the iteration below runs over THIS list and resolves the one mutation it
 * names out of the spec. The direction is the safety property: a mutation the
 * spec gains cannot add a tool, only a line written here can.
 */
const PROPOSAL_MUTATION_KEY = "propose_document";

const PROPOSAL_TOOLS: readonly ProposalToolSpec[] = [
  {
    key: "validate_document",
    mode: "dry_run",
    description:
      "Validate a catalog document candidate AND get its full semantic diff, writing nothing. Parses the candidate against this deployment's document schema and refuses by name (catalog_document_candidate_invalid, catalog_document_candidate_digest_mismatch, catalog_document_stale_base_digest, catalog_document_scope_unknown), then returns the recomputed candidateDigest and every changed path in deltas (currentValue vs targetValue per product). `submitted` is null: no proposal row is inserted and no document pointer moves. This is both the validator and the differ; there is no separate diff tool. Read catalog__read_document first for the baseDocumentDigests this call must declare.",
  },
  {
    key: "propose_document",
    mode: "commit",
    description:
      "Submit an immutable catalog document change proposal into the append-only evidence inbox. The row's publication_ready is false by CHECK constraint: submitting makes nothing sellable and moves no document pointer; it only records a reviewable candidate. Declares the same baseDocumentDigests as the dry run; a base digest that is not the product's current one is refused by name, never rebased onto the newer revision. Replaying identical candidate bytes returns inserted: false. Publishing a candidate, recording a publication decision and rolling one back are human-only acts no MCP tool can reach. Run catalog__validate_document first and read its deltas.",
  },
];

export function buildCatalogTools(): McpToolDefinition[] {
  const mutation = Object.values(catalogSpec.mutations).find(
    (candidate) => candidate.key === PROPOSAL_MUTATION_KEY,
  );
  if (!mutation) return [];

  return PROPOSAL_TOOLS.map((tool) => ({
    name: `${catalogSpec.domainKey}__${tool.key}`,
    description: tool.description,
    path: DOCUMENT_PROPOSAL_PATH,
    requestSchema: mutation.requestSchema,
    inputSchema: toolInputSchema(mutation.requestSchema),
    // Caller input is spread FIRST so this `mode` overrides whatever the caller
    // sent. The order is a safety property, not a style choice: reversed, an
    // agent could pass `mode: "commit"` to the validator and write a proposal
    // from a tool whose description promises it writes nothing.
    transform: (input) => ({ ...input, mode: tool.mode }),
  }));
}

/**
 * READ tools — projections of `catalogSpec.queries`. Reads carry no lifecycle
 * marker (they never mutate), so unlike the write surface nothing is dropped:
 * agents get the full draft/active/archived admin view. Each tool GETs its read
 * route with the query serialized to a querystring.
 */
const READ_BFF_PATH_BY_KEY: Record<string, string> = {
  list: `${CATALOG_BFF_BASE}/list`,
  get: `${CATALOG_BFF_BASE}/get`,
  history: `${CATALOG_BFF_BASE}/history`,
  read_document: `${CATALOG_BFF_BASE}/document`,
};

const READ_DESCRIPTION_BY_KEY: Record<string, string> = {
  list: "List catalog products (draft/active/archived) with optional status/species/petType/text filters and pagination.",
  get: "Fetch a catalog product's full admin detail by slug: all SKUs (incl. archived), price history, allergens, marketing content, and computed readyToPublish + publishBlockers.",
  history: "Fetch the audit trail for a catalog product by slug (newest first), with pagination.",
  read_document:
    "Read the current published document authority: for every product carrying a document pointer, its slug, ids, product/SKU status, net content and its current revision: documentRevisionId, revisionNo, documentSchemaId and documentDigest. documentDigest is the per-product revision digest you MUST declare as baseDocumentDigests[].documentDigest when calling catalog__validate_document or catalog__propose_document; a stale base is refused by name. This is the same digest the storefront reads, so the two cannot disagree about what current means. Returns revision pointers, not the document payload. Optional slug narrows to one product.",
};

/**
 * The two maps above are the ALLOW-LIST, not decoration. `catalogSpec.queries`
 * is the domain's full read surface and grows whenever a wave adds a read; what
 * this MCP head exposes is a deliberate subset, chosen per wave. A query with no
 * entry here is therefore skipped rather than emitted with `path: undefined` -
 * which is a broken tool, and a scope decision made by omission.
 *
 * W3f-c published the `document` query (spec key `read_document`) that W3f-a
 * deliberately left unmapped, so today the allow-list is saturated: every spec
 * query has an entry. Give the NEXT query a path and a description in the same
 * wave that means to publish it, and change the exact-set pin in `tools.test.ts`
 * in that wave rather than letting a tool appear silently.
 */
export function buildCatalogReadTools(): McpToolDefinition[] {
  if (!catalogSpec.queries) return [];
  const tools: McpToolDefinition[] = [];
  for (const query of Object.values(catalogSpec.queries)) {
    const path = READ_BFF_PATH_BY_KEY[query.key];
    const description = READ_DESCRIPTION_BY_KEY[query.key];
    if (!path || !description) continue;
    tools.push({
      name: `${catalogSpec.domainKey}__${query.key}`,
      description,
      path,
      httpMethod: "GET",
      requestSchema: query.requestSchema,
      inputSchema: toolInputSchema(query.requestSchema),
    });
  }
  return tools;
}
