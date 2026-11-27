import type { CatalogPublishedSku } from "./publicationContracts.js";
import { publicationRefuse } from "./publicationError.js";
import type { CatalogPublicationDocument } from "./publicationEvidence.js";
import { isLifecycleOperation, lifecycleTransition,
  type PublicationLifecycleOperation, type PublicationOperation } from "./publicationIntent.js";
import {
  applySkuPrefix, assertDerivedSource, assertSkuCreationDocument,
  documentSkuFacts, equal, need, normalizeIdentifierValue, skuCreationFacts,
} from "./publicationOperationHelpers.js";
import {
  addDocumentReference, atOperation, bindDocumentValue, combination,
  knownProduct, knownSku, readRoute, snapshot,
  type BoundPublicationContext,
} from "./publicationAdmission.js";

type SavedSkuSource = NonNullable<ReturnType<BoundPublicationContext["authorship"]["skuOperation"]>>;
type NonLifecycleOperation = Exclude<PublicationOperation, PublicationLifecycleOperation>;

export function bindPublicationSources(ctx: BoundPublicationContext): void {
  const { payload, rules } = ctx.admitted;
  // The registered bytes have passed their checksum in admission. Use the
  // selected bytes for derivation without running a later operation early.
  const selected = ctx.selectedRegistration && ctx.authorship.documentSource(ctx.selectedRegistration).source
    ? ctx.selectedRegistration : ctx.documentsById.get(ctx.authoredDocument.id);
  for (const [index, operation] of ctx.operations.entries()) {
    atOperation(ctx, index, operation);
    if ("productSlug" in operation) ctx.authorship.productOperation(operation);
    if (isLifecycleOperation(operation)) continue;
    if (operation.op === "set_derived_sku_facts") {
      const sku = ctx.skus.get(operation.skuCode);
      if (sku || !ctx.missingProduct) assertDerivedSource(operation, sku, ctx.authoredDocument.revisionNo);
      if (rules && selected && sku)
        need(equal(documentSkuFacts(selected, sku, rules), operation.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
    } else if ("skuCode" in operation) {
      const source = ctx.authorship.skuOperation(operation);
      if (!source) continue;
      ctx.savedSources.set(index, source);
      if (operation.op === "create_sku") {
        assertSkuCreationDocument(operation, source.payload.product.documentRevision);
        if (rules && selected)
          need(equal(documentSkuFacts(selected, skuCreationFacts(operation, source, payload.product.id), rules), operation.facts),
            "catalog_publication_v3_compile_derived_facts_mismatch");
      }
    } else if (operation.op === "register_document_revision") {
      const sealed = ctx.authorship.document(operation);
      if (sealed) {
        bindDocumentValue(ctx, sealed.document, sealed.authored, "catalog_publication_v3_document_invalid");
        ctx.savedDocuments.set(index, sealed.document);
      }
    }
  }
}

function applyPendingEligibility(ctx: BoundPublicationContext): void {
  if (ctx.productState !== "active") return;
  for (const [code, pending] of ctx.pendingEligibility) {
    if (ctx.skuStates.get(code)?.state !== "active") continue;
    applySkuPrefix(knownSku(ctx, code), pending, ctx.admitted.rules);
    ctx.pendingEligibility.delete(code);
  }
}

function applyLifecycle(ctx: BoundPublicationContext, operation: PublicationLifecycleOperation): void {
  const restored = operation.op === "restore_product" || operation.op === "restore_sku";
  const after = restored ? "active" : operation.state;
  const row = "skuCode" in operation ? knownSku(ctx, operation.skuCode) : knownProduct(ctx);
  const before = "skuCode" in operation ? ctx.skuStates.get(operation.skuCode)?.state : ctx.productState;
  if (!before) {
    ctx.runtime.structural.push(ctx.missingLifecycle("publication.operations"));
    return;
  }
  need(before === operation.expectedState, "catalog_lifecycle_state_conflict");
  need(lifecycleTransition(before, after, restored), "catalog_lifecycle_transition_refused");
  if ("skuCode" in operation) {
    const sku = row as CatalogPublishedSku;
    if (after === "archived")
      need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct(ctx).primarySkuId !== sku.id,
        "catalog_publication_v3_compile_archive_refused");
    if (after === "withdrawn") {
      ctx.pendingEligibility.delete(sku.code);
      sku.sellableStandalone = false;
      sku.sellableInSubscription = false;
      ctx.lastChildWithdrawn ||= ![...ctx.skuStates].some(([code, entry]) => code !== operation.skuCode && entry.state === "active");
    }
    ctx.skuStates.set(operation.skuCode, { ...ctx.skuStates.get(operation.skuCode), state: after });
  } else {
    if (after === "active") {
      const owner = knownProduct(ctx);
      const primary = [...ctx.skus.values()].find(sku => sku.id === owner.primarySkuId);
      need(owner.document && primary?.productId === owner.id && primary.status !== "archived",
        "catalog_publication_v3_compile_product_incomplete");
    }
    if (operation.op === "set_product_lifecycle") {
      const children = after === "withdrawn" ? [...ctx.skus.keys()].sort().map(skuCode => ({
        skuCode, expectedState: ctx.skuStates.get(skuCode)?.state,
      })) : [];
      need(children.every(child => child.expectedState !== undefined) && equal(operation.children, children), "catalog_lifecycle_child_effects_mismatch");
      for (const { skuCode } of children) {
        const sku = knownSku(ctx, skuCode);
        ctx.pendingEligibility.delete(skuCode);
        sku.sellableStandalone = false;
        sku.sellableInSubscription = false;
        if (ctx.skuStates.get(skuCode)?.state === "active") ctx.skuStates.set(skuCode, { ...ctx.skuStates.get(skuCode), state: "withdrawn" });
      }
    }
    ctx.productState = after;
  }
  row.status = after === "withdrawn" ? "active" : after;
  if (after === "active") applyPendingEligibility(ctx);
}

function applyCreateProduct(
  ctx: BoundPublicationContext,
  operation: Extract<NonLifecycleOperation, { op: "create_product" }>,
): boolean {
  const { payload, content } = ctx.admitted;
  need(ctx.product === null && operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
  ctx.product = {
    id: operation.productId, slug: ctx.slug, name: operation.name, status: "draft", type: payload.product.type,
    axes: [...payload.product.dimensions], attributes: payload.product.attributes ?? {}, primarySkuId: null, document: null,
    presentation: null, source: ctx.claim, content,
  };
  if (ctx.governed) ctx.productState = "draft";
  return true;
}

function applyRegisterDocumentRevision(
  ctx: BoundPublicationContext,
  operation: Extract<NonLifecycleOperation, { op: "register_document_revision" }>,
  entry: CatalogPublicationDocument | undefined,
): boolean {
  if (!entry) { ctx.unavailableRegistrations.add(operation.revisionNo); return false; }
  knownProduct(ctx);
  const byId = ctx.referencesById.get(operation.revisionId), byRevision = ctx.referencesByRevision.get(operation.revisionNo);
  if (byId || byRevision) {
    const previous = ctx.documentsById.get(operation.revisionId);
    need(byId === byRevision && equal(byId, entry.reference) && (!previous || equal(previous, entry)), "catalog_publication_v3_compile_document_conflict");
  } else {
    if (ctx.highWaterAvailable || ctx.requestedHead === null)
      need(operation.revisionNo === ctx.highWater + 1, "catalog_publication_document_revision_sequence");
    addDocumentReference(ctx, entry.reference);
    ctx.highWater++;
  }
  if (!ctx.documentsById.has(entry.reference.id)) ctx.documents.push(entry);
  ctx.documentsById.set(entry.reference.id, entry);
  return true;
}

function applyMoveDocumentPointer(
  ctx: BoundPublicationContext,
  operation: Extract<NonLifecycleOperation, { op: "move_document_pointer" }>,
): boolean {
  const reference = ctx.referencesByRevision.get(operation.documentRevisionNo);
  if (!reference && (ctx.documentReferencesIncomplete || ctx.unavailableRegistrations.has(operation.documentRevisionNo))) {
    if (operation.documentRevisionNo === ctx.authoredDocument.revisionNo) knownProduct(ctx).document = ctx.authoredDocument;
    return false;
  }
  if (!reference) return publicationRefuse("catalog_publication_v3_compile_document_absent");
  need(reference.productId === knownProduct(ctx).id && equal(ctx.admitted.payload.product.documentRevision, reference), "catalog_publication_document_source_mismatch");
  knownProduct(ctx).document = reference;
  return true;
}

function applyCreateSku(
  ctx: BoundPublicationContext,
  index: number,
  operation: Extract<NonLifecycleOperation, { op: "create_sku" }>,
  source: SavedSkuSource,
): boolean {
  need(!ctx.skus.has(operation.skuCode) && ![...ctx.skus.values()].some(sku => sku.id === operation.skuId), "catalog_publication_v3_compile_sku_conflict");
  const sku = skuCreationFacts(operation, source, knownProduct(ctx).id);
  ctx.existingCombinations ??= new Set([...ctx.skus.values()].map(existing => combination(ctx, existing)));
  const identity = combination(ctx, sku);
  need(!ctx.existingCombinations.has(identity), "duplicate_combination");
  assertSkuCreationDocument(operation, source.payload.product.documentRevision, knownProduct(ctx).document);
  ctx.existingCombinations.add(identity);
  ctx.skus.set(sku.code, sku);
  ctx.created.add(sku.code);
  ctx.creations.set(index, structuredClone(sku));
  if (ctx.governed) ctx.skuStates.set(sku.code, { state: "draft" });
  return true;
}

function applyCreateIdentifier(
  ctx: BoundPublicationContext,
  operation: Extract<NonLifecycleOperation, { op: "create_identifier" }>,
): boolean {
  const sku = knownSku(ctx, operation.skuCode);
  need(ctx.created.has(sku.code), "catalog_publication_identifier_requires_created_sku");
  const gtin = operation.scheme === "gs1:gtin";
  const normalized = normalizeIdentifierValue(operation.scheme, operation.value);
  if (gtin) {
    need(!ctx.gtins.has(normalized), "catalog_publication_v3_compile_identifier_conflict");
    ctx.gtins.add(normalized);
  }
  need(operation.value.trim().length, "catalog_publication_identifier_blank");
  need(!sku.identifiers.some(value => value.issuer === operation.issuer
    && normalizeIdentifierValue(value.scheme, value.value) === normalized),
  "catalog_publication_identifier_key_reused");
  need(!operation.isPrimary || !sku.identifiers.some(value => value.isPrimary), "catalog_publication_identifier_primary_invalid");
  applySkuPrefix(sku, operation, ctx.admitted.rules);
  return true;
}

function applySetPrimarySku(
  ctx: BoundPublicationContext,
  operation: Extract<NonLifecycleOperation, { op: "set_primary_sku" }>,
  source: SavedSkuSource,
): boolean {
  const sku = knownSku(ctx, operation.skuCode);
  need(sku.productId === knownProduct(ctx).id && source.sku.id === sku.id, "catalog_publication_v3_compile_primary_foreign");
  need(knownProduct(ctx).primarySkuId === null || knownProduct(ctx).primarySkuId === sku.id, "catalog_publication_v3_compile_primary_immutable");
  need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
  knownProduct(ctx).primarySkuId = sku.id;
  return true;
}

function applySetEligibility(
  ctx: BoundPublicationContext,
  index: number,
  operation: Extract<NonLifecycleOperation, { op: "set_eligibility" }>,
): boolean {
  const sku = knownSku(ctx, operation.skuCode);
  const on = operation.sellableStandalone || operation.sellableInSubscription;
  const materialized = ctx.originalById.get(sku.id);
  ctx.pendingEligibility.delete(sku.code);
  need(!on || sku.status !== "archived" && materialized?.status !== "archived", "catalog_publication_v3_compile_sku_archived");
  if (on && ctx.governed) {
    const state = ctx.skuStates.get(sku.code)?.state;
    if (ctx.productState === undefined || state === undefined) {
      ctx.runtime.structural.push(ctx.missingLifecycle(ctx.runtime.position.path));
      return false;
    }
    if (ctx.productState !== "active" || state !== "active") {
      const rest = ctx.operations.slice(index + 1);
      need((state === "active" || rest.some(op => (op.op === "restore_sku" || op.op === "set_sku_lifecycle" && op.state === "active")
        && op.skuCode === sku.code && op.expectedState === state))
        && (ctx.productState === "active" || rest.some(op => (op.op === "restore_product" || op.op === "set_product_lifecycle" && op.state === "active")
          && op.expectedState === ctx.productState)), "catalog_lifecycle_fresh_sale_refused");
      ctx.pendingEligibility.set(sku.code, operation);
      return false;
    }
  }
  applySkuPrefix(sku, operation, ctx.admitted.rules);
  return true;
}

function applyNonLifecycleOperation(
  ctx: BoundPublicationContext,
  index: number,
  operation: NonLifecycleOperation,
  source: SavedSkuSource | undefined,
  entry: CatalogPublicationDocument | undefined,
): boolean {
  switch (operation.op) {
    case "create_product":
      return applyCreateProduct(ctx, operation);
    case "register_document_revision":
      return applyRegisterDocumentRevision(ctx, operation, entry);
    case "move_document_pointer":
      return applyMoveDocumentPointer(ctx, operation);
    case "create_sku":
      return applyCreateSku(ctx, index, operation, source!);
    case "create_identifier":
      return applyCreateIdentifier(ctx, operation);
    case "set_primary_sku":
      return applySetPrimarySku(ctx, operation, source!);
    case "set_product_status":
      if (operation.status === "active")
        need(knownProduct(ctx).document !== null && knownProduct(ctx).primarySkuId !== null, "catalog_publication_v3_compile_product_incomplete");
      knownProduct(ctx).status = operation.status;
      return true;
    case "set_eligibility":
      return applySetEligibility(ctx, index, operation);
    case "set_sku_status": {
      const sku = knownSku(ctx, operation.skuCode);
      if (operation.status === "archived")
        need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct(ctx).primarySkuId !== sku.id, "catalog_publication_v3_compile_archive_refused");
      applySkuPrefix(sku, operation, ctx.admitted.rules);
      return true;
    }
    case "set_offer_membership":
    case "set_sku_metadata":
      applySkuPrefix(knownSku(ctx, operation.skuCode), operation, ctx.admitted.rules);
      return true;
    case "set_product_presentation":
      knownProduct(ctx).presentation = operation.presentation;
      return true;
    case "set_derived_sku_facts": {
      const sku = knownSku(ctx, operation.skuCode);
      need(knownProduct(ctx).document?.revisionNo === operation.documentRevisionNo, "catalog_publication_derived_source_mismatch");
      applySkuPrefix(sku, operation, ctx.admitted.rules);
      return true;
    }
    default: {
      const _exhaustive: never = operation;
      return publicationRefuse("catalog_publication_operation_invalid");
    }
  }
}

export async function applyPublicationPrefixes(ctx: BoundPublicationContext): Promise<void> {
  const { position, input: { definition } } = ctx.runtime;
  const { payload, withdrawalOnly } = ctx.admitted;
  const [authoredView, retainedView, proposedViews] = snapshot(
    ctx.authoredPresentation,
    ctx.product?.presentation,
    ctx.operations.map(operation => operation.op === "set_product_presentation" ? operation.presentation : null),
  );
  const writesPresentation = ctx.operations.some(operation => operation.op === "set_product_presentation");
  position.path = "product.sharedContent.presentation";
  position.subject = definition.key;
  if (!writesPresentation) {
    const authoredRoute = !withdrawalOnly && Object.keys(ctx.authoredPresentation).length > 0;
    if (authoredRoute) await readRoute(ctx, authoredView);
    if (!withdrawalOnly && retainedView && (!authoredRoute || !equal(ctx.product?.presentation, ctx.authoredPresentation)))
      await readRoute(ctx, retainedView);
  }
  for (const [index, operation] of payload.publication.operations.entries()) {
    atOperation(ctx, index, operation);
    if (isLifecycleOperation(operation)) {
      if (!ctx.missingProduct) applyLifecycle(ctx, operation);
      continue;
    }
    const source = ctx.savedSources.get(index);
    const entry = ctx.savedDocuments.get(index);
    if (operation.op === "set_product_presentation" && operation.presentation !== null) {
      if (!ctx.missingProduct) knownProduct(ctx);
      await readRoute(ctx, proposedViews[index]!);
    }
    if (ctx.missingProduct) continue;
    if ("skuCode" in operation && !source && operation.op !== "set_derived_sku_facts") continue;
    if (applyNonLifecycleOperation(ctx, index, operation, source, entry)) knownProduct(ctx);
  }
}
