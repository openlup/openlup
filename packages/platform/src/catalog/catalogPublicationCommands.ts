import type { PgQueryExecutor, PostgresRoleFreeTransactionLane } from "../data/index.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogCandidatePreview, CatalogCandidateQuery } from "./contracts/candidate.js";
import type { CatalogPublishCommand } from "./contracts/lifecycle.js";
import type { CatalogPublicationPort, VerifiedCatalogPublisher } from "./publicationPorts.js";
import type { CatalogPublicationFailure, CatalogPublicationReceiptV2 } from "./publicationContracts.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { matchesPublicationHead, publicationHeadSchema } from "./publicationEvidence.js";
import { createCatalogCandidateServiceWithPublication, parseCatalogCandidateReference } from "./candidateService.js";
import { CatalogCandidateError } from "./candidate.js";
import { createPostgresCatalogDraftStoreV3 } from "./catalogDraftStore.js";
import { readPublicationDraftRecord } from "./publicationIntent.js";
import { catalogPublicationClaim, evaluateCatalogPublication } from "./publicationValidation.js";
import { decodeStoredPublicationReceipt, publicationApprovalState, publicationDigest, publicationJson } from "./publicationCodec.js";
import { CatalogPublicationError, catalogPublicationAdmissionRefusal, publicationReadFailure, refusePublicationCommand, publicationRemedy,
  type AdmissionDiagnostic } from "./publicationError.js";
import { assertCurrentPublicationRoster, readNativeDraftEvidence, readPreviousPublication, stagePublication, publicationRelationFence } from "./catalogPublicationProjection.js";
import { z } from "./validation.js";

const id = z.string().regex(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);
const safeText = (bytes: number) => z.string().min(1).refine(value => Buffer.byteLength(value) <= bytes && !/\0|[\uD800-\uDFFF]/u.test(value));
const common = {
  productId: id, commandKey: safeText(200), candidateRef: z.string().max(200),
  candidateDigest: digest,
};
const decision = { ...common, reason: safeText(1000).refine(value => /[^ ]/u.test(value)).nullable() };
const decisionInput = { ...decision, reason: decision.reason.default(null) };
const commandSchema = z.discriminatedUnion("action", [
  z.object({ ...decisionInput, action: z.literal("approve"), postStateDigest: digest }).strict(),
  z.object({ ...decisionInput, action: z.literal("revoke") }).strict(),
  z.object({ ...common, action: z.literal("publish"), expectedHead: publicationHeadSchema.nullable(),
    changes: z.array(z.object({ variantId: id, expectedRevision: revision, state: z.enum(["active", "withdrawn"]) }).strict()).max(10_000),
  }).strict(),
]);
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const decisionReceiptSchema = z.discriminatedUnion("action", [
  z.object({ ...decision, schemaVersion: z.literal(2), action: z.literal("approve"), postStateDigest: digest,
    actorId: id, fingerprint: digest, decidedAt: stamp }).strict(),
  z.object({ ...decision, schemaVersion: z.literal(2), action: z.literal("revoke"),
    actorId: id, fingerprint: digest, decidedAt: stamp }).strict(),
]);

/** @experimental */
export type CatalogPublicationCommand = Exclude<z.input<typeof commandSchema>, { action: "publish" }>
  | (CatalogPublishCommand & { action: "publish" });
/** @experimental */
export type CatalogPublicationDecisionReceipt = z.output<typeof decisionReceiptSchema>;
/** @experimental */
export type CatalogPublicationCommandResult =
  | { outcome: "committed" | "replayed"; receipt: CatalogPublicationReceiptV2 | CatalogPublicationDecisionReceipt }
  | (CatalogPublicationFailure & { path?: string });

/** Host-selected owner authority for an explicit server capability.
 * @experimental
 */
export interface PostgresCatalogPublicationCommandsDeps<Context> {
  catalogPublicationOwner: Pick<PostgresRoleFreeTransactionLane<PgQueryExecutor>, "run">;
  authorizeHuman(context: Context): Promise<{ ok: true; userId: string; role: string; isMachineActor: boolean } | { ok: false }>;
  registry: CatalogProductTypeRegistry;
  evaluation?: CatalogCandidatePublicationDeps["evaluation"];
  attributeReferences?: (db: PgQueryExecutor) => CatalogAttributeReferencePort;
  verifyMedia?: (db: PgQueryExecutor, ...input: Parameters<NonNullable<CatalogCandidatePublicationDeps["verifyMedia"]>>) => Promise<boolean | null>;
}

function requireCommand(condition: unknown, code: AdmissionDiagnostic,
  outcome: CatalogPublicationFailure["outcome"] = "conflict"): asserts condition {
  if (!condition) refusePublicationCommand(code, outcome);
}
const same = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b);
function decisionBody(command: Exclude<z.output<typeof commandSchema>, { action: "publish" }>) {
  return { schemaVersion: 2, ...command };
}
async function routeReadiness(db: PgQueryExecutor, productId: string, presentation: Record<string, unknown>) {
  const collision = (await db.query(`SELECT 1 FROM public.catalog_products p
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(p.publication_facts #> '{presentation,routePath}','{}'::jsonb)) r
    WHERE p.id<>$1 AND r.value=($2::jsonb)->>r.key LIMIT 1`,
  [productId, JSON.stringify(presentation.routePath ?? {})])).rows[0];
  return collision ? { ready: false, reasons: ["catalog_publication_route_conflict"] } : { ready: true, reasons: [] };
}
async function claimHuman(db: PgQueryExecutor, actor: string) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
  await db.query("SELECT public.catalog_price_setup_require_human_admin()");
}
function commandFailure(error: unknown): Extract<CatalogPublicationCommandResult, { reason: string }> {
  if (error instanceof CatalogPublicationError) {
    const mapped = catalogPublicationAdmissionRefusal(error);
    return { outcome: error.outcome, reason: mapped?.reason ?? "publication_evaluation_refused",
      message: error.diagnostic?.message ?? mapped?.message ?? publicationRemedy("publication_evaluation_refused"),
      ...(error.diagnostic?.path ? { path: error.diagnostic.path } : {}) };
  }
  const sql = error as { code?: string; message?: string; constraint?: string } | null;
  const refuse = (code: AdmissionDiagnostic, outcome: CatalogPublicationError["outcome"]) =>
    commandFailure(new CatalogPublicationError(code, outcome));
  if (sql?.code === "55P03") return refuse("catalog_publication_busy", "conflict");
  if (sql?.code === "42501" && sql.message === "catalog_price_setup_operator_required")
    return refuse("publisher_not_authorized", "unauthorized");
  if (sql?.code === "23505" && sql.constraint === "catalog_publication_gtin_key")
    return refuse("catalog_publication_gtin_conflict", "conflict");
  if (sql?.code === "23505" && sql.constraint === "catalog_publication_sku_combination_key")
    return refuse("duplicate_combination", "conflict");
  if (sql?.code === "23505" && (sql.constraint === "idx_catalog_skus_sku" || sql.constraint === "idx_catalog_products_slug"))
    return refuse("catalog_publication_identity_conflict", "conflict");
  const mapped = catalogPublicationAdmissionRefusal(error);
  return mapped ?? publicationReadFailure(error);
}

/** Bind native v3 commands to the host's catalogue publication owner transaction.
 * @experimental
 */
export function createPostgresCatalogPublicationCommands<Context>(deps: PostgresCatalogPublicationCommandsDeps<Context>) {
  const operators = new WeakMap<VerifiedCatalogPublisher, string>();
  async function authorize(context: Context): Promise<VerifiedCatalogPublisher | null> {
    const actor = await deps.authorizeHuman(context);
    if (!actor?.ok || actor.isMachineActor || actor.role !== "admin" || !id.safeParse(actor.userId).success) return null;
    const capability = Object.freeze({}) as VerifiedCatalogPublisher;
    operators.set(capability, actor.userId);
    return capability;
  }

  async function execute(input: CatalogPublicationCommand, capability: VerifiedCatalogPublisher): Promise<CatalogPublicationCommandResult> {
    try {
      const parsed = commandSchema.safeParse(input);
      requireCommand(parsed.success, "catalog_publication_query_invalid", "validation_issue");
      const command = parsed.data;
      const reference = parseCatalogCandidateReference(command.candidateRef);
      requireCommand(reference, "catalog_publication_query_invalid", "validation_issue");
      if (command.action === "publish") {
        command.changes.sort((a, b) => a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0);
        requireCommand(new Set(command.changes.map(change => change.variantId)).size === command.changes.length
          && matchesPublicationHead(reference.head, command.expectedHead), "catalog_publication_query_invalid", "validation_issue");
      }
      const actor = operators.get(capability);
      requireCommand(actor, "publisher_not_authorized", "unauthorized");
      return await deps.catalogPublicationOwner.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE");
        await claimHuman(db, actor);
        const candidateKey = publicationDigest([command.candidateRef, command.candidateDigest]);
        const guard = (lane: string, identity: unknown) => db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lane + publicationJson(identity)]);
        await guard("catalog-publication-candidate:", command.candidateRef);
        await guard("catalog-publication-command:", [command.productId, command.commandKey]);

        const { productId, commandKey, action, candidateRef, candidateDigest } = command;
        const fingerprint = publicationDigest([action === "publish" ? { schemaVersion: 2, ...command } : decisionBody(command), actor]);
        const saved = (await db.query(`SELECT r.kind,r.actor_id,r.fingerprint,r.publication_id FROM public.catalog_operator_receipts r
          WHERE (r.scope_id,r.command_key)=($1,$2)`, [productId, commandKey])).rows[0];
        const decode = (text: unknown) => action === "publish" ? decodeStoredPublicationReceipt(text)
          : decisionReceiptSchema.parse(JSON.parse(String(text)));
        if (saved) {
          requireCommand(saved.actor_id === actor, "publisher_not_authorized", "unauthorized");
          requireCommand(saved.kind === action && saved.fingerprint === fingerprint, "catalog_publication_command_key_reused");
          const checked = (await db.query("SELECT public.catalog_publication_assert_receipt($1,$2) AS result", [productId, commandKey])).rows[0]?.result;
          const receipt = decode(checked);
          requireCommand(receipt.fingerprint === fingerprint && receipt.actorId === actor && receipt.productId === productId
            && receipt.commandKey === commandKey && (action === "publish" || "action" in receipt && receipt.action === action
              && same(decisionBody(command), { schemaVersion: 2, action: receipt.action, productId: receipt.productId,
                commandKey: receipt.commandKey, candidateRef: receipt.candidateRef, candidateDigest: receipt.candidateDigest,
                reason: receipt.reason, ...(receipt.action === "approve" ? { postStateDigest: receipt.postStateDigest } : {}) })),
            "catalog_publication_receipt_invalid", "validation_issue");
          if ("head" in receipt) {
            const { rows } = await db.query(`SELECT public.catalog_publication_head_ref(p.product_id,p.id) AS head,
              public.catalog_publication_head_ref(p.product_id,p.previous_id) AS previous,p.digest
              FROM public.catalog_publications p WHERE (p.product_id,p.id)=($1,$2)`, [productId, saved.publication_id]);
            requireCommand(rows[0]?.digest === receipt.publicationDigest && same(rows[0].head, receipt.head)
              && same(rows[0].previous, receipt.previousHead), "catalog_publication_receipt_invalid", "validation_issue");
          }
          return { outcome: "replayed", receipt };
        }

        const store = await readNativeDraftEvidence(db, reference);
        // These locks conflict with draft edits and no-op updates to sealed history.
        await db.query(`SELECT draft_id FROM public.catalog_draft_heads WHERE draft_id=ANY($1::uuid[])
          ORDER BY draft_id FOR NO KEY UPDATE`, [store.draftIds]);
        const issued = (await db.query("SELECT id FROM public.catalog_publications WHERE candidate_ref=$1 AND product_id=$2 AND candidate_digest=$3",
          [candidateRef, productId, candidateDigest])).rows[0];
        requireCommand(!issued, "catalog_publication_candidate_already_issued");
        const drafts = await store.read();
        const candidate = drafts.find(entry => entry.record.draftId === reference.draftId && entry.record.revision === reference.draftRevision);
        requireCommand(candidate?.head?.revision === reference.draftRevision && candidate.head.status === "open"
          && candidate.head.productId === productId, "catalog_publication_draft_advanced");
        const record = readPublicationDraftRecord(candidate.record);
        requireCommand(record?.payload.schemaVersion === 3 && record.status === "open" && record.productId === productId
          && same(catalogPublicationClaim(record), candidate.receipt), "catalog_publication_candidate_invalid", "validation_issue");
        const active = (await db.query(`SELECT id,action,post_state_canonical_text,post_state_digest
          FROM public.catalog_publication_decisions
          WHERE candidate_reference_digest=$1 AND product_id=$2 AND candidate_ref=$3 AND candidate_digest=$4
          ORDER BY decided_at DESC,id DESC LIMIT 1`, [candidateKey, productId, candidateRef, candidateDigest])).rows[0];
        requireCommand(action === "approve" ? active?.action !== "approve" : active?.action === "approve",
          action === "approve" ? "catalog_publication_approval_wrong" : "catalog_publication_approval_missing");
        const verifyIdentity = () => db.query("SELECT public.catalog_publication_candidate_source($1,$2,$3)",
          [productId, candidateRef, candidateDigest]);
        async function commit(body: Record<string, unknown>) {
          const { rows } = await db.query("SELECT public.catalog_publication_record_command($1::jsonb) AS result",
            [JSON.stringify(body)]);
          return { outcome: "committed" as const, receipt: decode(rows[0]?.result) };
        }
        if (action === "revoke") {
          await assertCurrentPublicationRoster(db, productId);
          await verifyIdentity();
          return commit(command);
        }

        const type = record.payload.product.type;
        const definition = deps.registry.resolve(type);
        const installed = (await db.query(`SELECT t.definition_digest FROM public.catalog_type_versions t
          WHERE t.type_key=$1 AND t.version=$2`, [type.key, type.version])).rows[0]?.definition_digest;
        requireCommand(definition && typeof installed === "string", "catalog_definition_drift", "validation_issue");
        let previous: Awaited<ReturnType<typeof readPreviousPublication>> | undefined;
        const compensation = record.payload.publication.kind === "compensation";
        const attributeReferences = deps.attributeReferences?.(db);
        const result = await evaluateCatalogPublication({
          record, definition, installedDefinitionDigest: installed, attributeReferences,
          expectedHead: action === "publish" ? command.expectedHead : reference.head,
          ...(deps.evaluation === undefined ? {} : { evaluation: deps.evaluation }),
          async readCurrentHead() {
            if (action === "publish") {
              try { await publicationRelationFence(db, productId); }
              catch (error) {
                if ((error as { code?: string } | null)?.code === "55P03") refusePublicationCommand("catalog_publication_busy", "conflict");
                throw error;
              }
            }
            previous = await readPreviousPublication(db, productId, action === "publish" ? command.expectedHead : reference.head,
              action === "publish" && !compensation);
            try { await verifyIdentity(); }
            catch (error) {
              if (catalogPublicationAdmissionRefusal(error)) refusePublicationCommand("catalog_publication_candidate_invalid", "validation_issue");
              throw error;
            }
            if (definition.taxClass) {
              const tax = (await db.query("SELECT status FROM public.catalog_tax_classes WHERE key=$1 FOR SHARE", [definition.taxClass])).rows[0];
              requireCommand(tax?.status === "active", "catalog_publication_tax_class_unavailable", "validation_issue");
            }
            return { head: previous.head, unavailable: false, expectedHead: previous.head ?? undefined };
          },
          observations: {
            async readEvidence() { return previous ? { ...previous.evidence, drafts } : null; },
            presentationReadiness: (productId, presentation) => routeReadiness(db, productId, presentation),
            ...(deps.verifyMedia ? { verifyMedia: (claim, head) => deps.verifyMedia!(db, claim, head) } : {}),
            // The price writer and the live readiness check own the tentative transaction rows.
            async assessActivation() { return { ready: true, reasons: [] }; },
          },
          // The price writer uses the same canonical command and evaluates the actual prior entry under lock.
          async validatePrices() { return []; },
        }, action === "approve" ? "first-decision" : "compile");
        if (result.failure) throw result.failure;
        const issue = [...result.structural, ...result.activationIssues][0];
        if (issue) throw new CatalogPublicationError(issue.diagnostic.code, issue.outcome, issue.diagnostic);
        const plan = result.compiled;
        requireCommand(plan && previous, "publication_preparation_unavailable", "dependency_unavailable");
        const seal = publicationApprovalState(plan.product, plan.skus);
        if (action === "approve") {
          requireCommand(seal.digest === command.postStateDigest, "catalog_publication_post_state_changed");
          return commit({ ...command, postStateText: seal.canonicalText });
        }
        requireCommand(seal.digest === active?.post_state_digest && seal.canonicalText === active.post_state_canonical_text,
          "catalog_publication_post_state_changed");
        await stagePublication(db, previous, definition, plan, command, actor, fingerprint, compensation, attributeReferences);
        return commit({ ...command, fingerprint, approvalId: active.id, product: plan.product, skus: plan.skus });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async function prepareCandidate(query: CatalogCandidateQuery, capability: VerifiedCatalogPublisher):
    Promise<CatalogCandidatePreview | CatalogPublicationFailure> {
    try {
      const actor = operators.get(capability);
      requireCommand(actor, "publisher_not_authorized", "unauthorized");
      return await deps.catalogPublicationOwner.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await claimHuman(db, actor);
        const drafts = createPostgresCatalogDraftStoreV3(db);
        const service = createCatalogCandidateServiceWithPublication({
          registry: deps.registry,
          readDraft: (draftId, revision) => drafts.get({ draftId, ...(revision === undefined ? {} : { revision }) }, actor),
          async installedDefinitionDigest(type) {
            const { rows } = await db.query("SELECT definition_digest FROM public.catalog_type_versions WHERE type_key=$1 AND version=$2",
              [type.key, type.version]);
            return typeof rows[0]?.definition_digest === "string" ? rows[0].definition_digest : null;
          },
          async currentHead(productId) {
            const { rows } = await db.query(`SELECT public.catalog_publication_head_ref(h.product_id,h.publication_id) AS head,d.document_ref
              FROM public.catalog_publication_heads h
              JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
              JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(p.product_id,p.document_revision_id)
              WHERE h.product_id=$1`, [productId]);
            if (!rows.length) return { outcome: "unpublished" };
            const head = publicationHeadSchema.parse(rows[0]?.head);
            return { outcome: "found", head, documentRef: z.string().parse(rows[0]?.document_ref), observations: [] };
          },
          async resolveHead(head) {
            const { rows } = await db.query(`SELECT public.catalog_publication_head_ref(product_id,id) AS head
              FROM public.catalog_publications WHERE id=$1`, [head.publicationId]);
            return publicationHeadSchema.safeParse(rows[0]?.head).data ?? null;
          },
          ...(deps.attributeReferences ? { attributeReferences: deps.attributeReferences(db) } : {}),
        }, {
          includeApprovalSeal: true,
          ...(deps.evaluation === undefined ? {} : { evaluation: deps.evaluation }),
          presentationReadiness: (productId, presentation) => routeReadiness(db, productId, presentation),
          async readEvidence({ candidate, productId, expectedHead }) {
            const [source, previous] = await Promise.all([
              readNativeDraftEvidence(db, { draftId: candidate.draftId, draftRevision: candidate.revision, head: expectedHead }),
              readPreviousPublication(db, productId, expectedHead, false),
            ]);
            return { ...previous.evidence, drafts: await source.read() };
          },
        });
        return service.prepareCandidate(query);
      });
    } catch (error) {
      if (error instanceof CatalogCandidateError)
        return { outcome: error.code === "head_conflict" ? "conflict" : "validation_issue", reason: error.code, message: error.message };
      return commandFailure(error);
    }
  }

  const publication: CatalogPublicationPort = {
    async publish(command: CatalogPublishCommand, actor) {
      const result = await execute({ ...command, action: "publish" }, actor);
      if ("receipt" in result && "head" in result.receipt) {
        const { commandKey, fingerprint, actorId, previousHead, head, changes } = result.receipt;
        return { outcome: result.outcome, receipt: { commandKey, fingerprint, actorId, previousHead, head, changes } };
      }
      const reasons = { unauthorized: "publisher_not_authorized", conflict: "head_conflict",
        validation_issue: "candidate_invalid", unsupported: "publication_not_supported",
        dependency_unavailable: "publication_authority_unavailable" } as const;
      if ("reason" in result) return { outcome: result.outcome, reason: reasons[result.outcome],
        ...(result.message ? { message: result.message } : {}) };
      return { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" };
    },
  };
  return { authorize, prepareCandidate, execute, publication };
}
