import { z } from "./validation.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./publicationContracts.js";
import { GOVERNED_PUBLICATION_VERSION } from "./publicationContracts.js";
import { adopterIssue, CatalogPublicationError, publicationIssue, publicationRefuse,
  type Issue } from "./publicationError.js";
import {
  assertNativeProductDocument, assertNativeProductReferences, assertNativeSkuNetWeight,
  assertPublishedSkuDocumentExclusion, decodePublishedProduct, decodePublishedSku,
  publicationJson, publicationReadinessVerdict,
} from "./publicationCodec.js";
import { ruleProduct, ruleSku } from "./publicationRules.js";
import { validateCatalogAttributes } from "./attributeValidation.js";
import type { CatalogPublicationDocument } from "./publicationEvidence.js";
import { isLifecycleOperation } from "./publicationIntent.js";
import { enablesSku, requiredPromotions, sealedPresentation } from "./publicationDraft.js";
import { documentSkuFacts, equal, matchesAuthoredIdentifier, need } from "./publicationOperationHelpers.js";
import { assertCatalogPublicationGrossMass, catalogPublicationIntegralGrams, catalogPublicationMediaIssue } from "./publicationPreparation.js";
import {
  atOperation, bindDocumentValue, bindPhysicalSource, combination, isUnavailable,
  knownProduct, materialState, observe, selectedDocument, snapshot, unavailable,
  type BoundPublicationContext,
} from "./publicationAdmission.js";

async function checkPrices(ctx: BoundPublicationContext, draft: CatalogDraftPayloadV2 | undefined): Promise<void> {
  if (!draft) return;
  const { input, structural, missing } = ctx.runtime;
  const { validationPayload } = ctx.admitted;
  const prices = z.array(z.object({ path: z.string(), code: z.string() })).safeParse(
    await observe(() => input.validatePrices?.(draft) ?? Promise.resolve(undefined)));
  if (!prices.success) structural.push(missing("price_validation_unavailable", "skus"));
  else {
    for (const issue of prices.data) {
      const match = /^skus[./](\d+)[./]priceOperations[./](\d+)$/u.exec(issue.path);
      const selected = match ? validationPayload.skus[Number(match[1])]?.priceOperations?.[Number(match[2])]
        : ctx.priceOperations.length === 1 ? ctx.priceOperations[0] : undefined;
      const path = match && selected ? `skus.${match[1]}.priceOperations.${match[2]}` : "skus";
      const diagnostic: Issue = {
        ...adopterIssue("validatePrices", issue.code, issue.path || path),
        phase: "pricing", ...(selected ? { subject: selected.priceListId } : {}),
      };
      if (!issue.code.endsWith("_unavailable")) throw new CatalogPublicationError(diagnostic);
      structural.push(unavailable(diagnostic));
    }
  }
}

export function checkPhysicalSources(ctx: BoundPublicationContext): void {
  const { position } = ctx.runtime;
  const { record, payload } = ctx.admitted;
  for (const [code, claim] of ctx.media) {
    position.path = "publication.evidence.media";
    position.subject = code;
    const source = ctx.authorship.sku(code, true, "catalog_publication_media_evidence_mismatch");
    if (!source) continue;
    if (source && source.source !== record) bindPhysicalSource(ctx, code, source.sku);
    need(source && !catalogPublicationMediaIssue(source.payload.product.sharedContent.presentation.mediaRef, source.sku.assetRefs ?? [], claim),
      "catalog_publication_media_evidence_mismatch");
  }
  for (const [index, sku] of payload.skus.entries()) {
    const actual = sku.code && ctx.skus.get(sku.code);
    const idMatch = ctx.originalById.get(sku.id);
    if (!actual && !idMatch) continue;
    position.path = `skus.${index}`;
    position.subject = sku.code ?? sku.id;
    bindPhysicalSource(ctx, sku.code, sku);
  }
  ctx.runtime.activating = ctx.affected.enabling.size > 0 || payload.publication.operations.some(op =>
    op.op === "set_product_lifecycle" && op.state === "active");
  for (const [index, operation] of payload.publication.operations.entries()) {
    if (operation.op !== "set_eligibility" || !enablesSku(operation)) continue;
    const source = ctx.savedSources.get(index);
    if (!source) continue;
    atOperation(ctx, index, operation);
    bindPhysicalSource(ctx, operation.skuCode, source.sku);
  }
  for (const sku of ctx.skus.values()) {
    if (sku.status === "active" && (sku.sellableStandalone || sku.sellableInSubscription) && ctx.affected.source(sku.code))
      ctx.activationCodes.add(sku.code);
  }
}

export async function checkActivationSources(ctx: BoundPublicationContext): Promise<void> {
  const { input: { definition, observations }, position, activationIssues, missing } = ctx.runtime;
  const { record, payload } = ctx.admitted;
  const proposed = [...payload.publication.operations].reverse().find(operation => operation.op === "set_product_presentation");
  const presentation = proposed?.op === "set_product_presentation" ? proposed.presentation : ctx.product?.presentation;
  for (const code of ctx.activationCodes) {
    if (ctx.missingProduct && !presentation) continue;
    position.path = "skus";
    position.subject = code;
    const source = ctx.authorship.sku(code, true);
    if (!source) continue;
    bindPhysicalSource(ctx, code, source.sku);
    need(source.sku.netContent, "catalog_publication_operation_source_mismatch");
    position.path = `skus.${source.payload.skus.indexOf(source.sku)}.grossMass`;
    assertCatalogPublicationGrossMass(source.sku.netContent!, source.sku.grossMass ?? null, definition);
    position.path = "publication.evidence.media";
    const assets = source.sku.assetRefs ?? [];
    const retainedReference = source.payload.product.sharedContent.presentation.mediaRef;
    if (source.source !== record && (retainedReference != null || assets.length)
      && (typeof retainedReference !== "string" || retainedReference !== presentation?.mediaRef)) {
      const reason = "catalog_publication_media_readiness_unproven";
      throw new CatalogPublicationError({
        ...publicationIssue(reason, position.phase, position.path, position.subject),
        detail: "Keep the selected draft's media reference in the proposed presentation.",
      });
    }
    const problem = catalogPublicationMediaIssue(presentation?.mediaRef, assets, ctx.media.get(code));
    if (problem === "media_readiness_unknown")
      activationIssues.push(missing("catalog_publication_media_validation_unavailable", position.path));
    else need(!problem, "catalog_publication_media_readiness_unproven");
  }
  position.path = "publication.evidence.media";
  const [requests] = snapshot([...ctx.media.values()].map(claim => ({ claim, head: ctx.expectedHead && { ...ctx.expectedHead } })));
  for (const { claim, head } of requests) {
    const code = claim.skuCode;
    position.subject = code;
    const accepted = await observe(() => observations?.verifyMedia?.(claim, head) ?? Promise.resolve(undefined));
    if (accepted === true) ctx.verifiedMedia.push(ctx.media.get(code)!);
    else if (accepted === false) publicationRefuse("catalog_publication_media_readiness_unproven");
    else activationIssues.push(missing("catalog_publication_media_validation_unavailable", position.path));
  }
}

async function checkRetainedAttributes(
  ctx: BoundPublicationContext,
  rows: Iterable<CatalogPublishedSku>,
  productAttributes: CatalogPublishedProduct["attributes"] = {},
): Promise<void> {
  const { input: { definition }, attributeReferences, structural, missing } = ctx.runtime;
  const { payload, contextualIssue } = ctx.admitted;
  const retainedAttributes = [...rows].filter(sku => ctx.incoming.get(sku.code)?.attributes === undefined);
  if (retainedAttributes.length || payload.product.attributes === undefined && Object.keys(productAttributes).length) {
    const validation = await validateCatalogAttributes(definition, {
      productAttributes,
      skus: retainedAttributes.map(({ id, attributes }) => ({ id, attributes })),
    }, attributeReferences);
    if (!validation.valid) {
      for (const issue of validation.issues) {
        if (issue.code === "attribute_reference_unresolved") structural.push(missing("publication_evidence_unavailable", issue.path));
        else throw new CatalogPublicationError(contextualIssue(publicationIssue(issue.code, undefined, issue.path), retainedAttributes));
      }
    }
  }
}

function applyProductOverlayAndEffects(ctx: BoundPublicationContext, result: CatalogPublishedProduct): void {
  const { payload, content, withdrawalOnly } = ctx.admitted;
  const productOverlay = { attributes: payload.product.attributes ?? result.attributes, axes: payload.product.dimensions };
  if (withdrawalOnly) need(equal(productOverlay, { attributes: result.attributes, axes: result.axes })
    && equal(payload.product.sharedContent.presentation, result.content.presentation), "catalog_lifecycle_withdrawal_overlay_refused");
  else {
    Object.assign(result, productOverlay);
    result.content = content;
    result.source = ctx.claim;
  }
  for (const [code, authored] of ctx.incoming) {
    const sku = ctx.skus.get(code!);
    need(sku, "catalog_publication_sku_effect_missing");
    if (ctx.created.has(code!)) need(authored.identifiers?.every(identifier =>
      sku!.identifiers.some(stored => matchesAuthoredIdentifier(identifier, stored))), "catalog_publication_identifier_effect_missing");
    if (authored.logisticsRef) need(sku!.logisticsRef === authored.logisticsRef, "catalog_publication_metadata_effect_missing");
  }
  for (const intent of payload.product.sharedContent.offerMemberships) {
    const sku = ctx.skus.get(intent.skuCode);
    need(sku?.memberships.some(row => row.offerVersion === intent.offerVersion && row.admitted === intent.admitted),
      "catalog_publication_membership_effect_missing");
  }
}

function validateMaterializedSkus(
  ctx: BoundPublicationContext,
  result: CatalogPublishedProduct | null,
  afterDocument: CatalogPublicationDocument | null | undefined,
  productPhysicalChange: boolean,
): void {
  const { input, position, structural } = ctx.runtime;
  const { rules, withdrawalOnly } = ctx.admitted;
  for (const sku of ctx.skus.values()) {
    position.path = "skus";
    position.subject = sku.code;
    const draft = ctx.incoming.get(sku.code);
    if (draft && !ctx.created.has(sku.code)) {
      const overlay = { attributes: draft.attributes ?? sku.attributes, grossMass: draft.grossMass ?? sku.grossMass, assetRefs: draft.assetRefs ?? sku.assetRefs };
      if (withdrawalOnly) need(equal(overlay, { attributes: sku.attributes, grossMass: sku.grossMass, assetRefs: sku.assetRefs })
        && (draft.logisticsRef === undefined || draft.logisticsRef === sku.logisticsRef), "catalog_lifecycle_withdrawal_overlay_refused");
      else Object.assign(sku, overlay);
    }
    const before = ctx.originalById.get(sku.id);
    if (result && !withdrawalOnly && before && rules && afterDocument && (productPhysicalChange || !equal(
      [before.netContent, before.options, before.attributes, before.facts, before.grossMass, before.assetRefs],
      [sku.netContent, sku.options, sku.attributes, sku.facts, sku.grossMass, sku.assetRefs]))) {
      const beforeDocument = selectedDocument(ctx, ctx.beforeReference);
      if (beforeDocument) need(rules.classifySkuChange(ruleSku(before), ruleSku(sku), {
        beforeProduct: ruleProduct(ctx.retainedState.product!), afterProduct: ruleProduct(result),
        beforeDocument: beforeDocument.canonicalText, afterDocument: afterDocument.canonicalText,
      }) === "compatible", "sku_identity_change_requires_new_sku");
    }
    need(sku.netContent.dimension === "mass", "catalog_publication_mass_required_until_mc5");
    catalogPublicationIntegralGrams(sku.netContent, input.definition);
    if (!withdrawalOnly && rules && afterDocument) need(equal(documentSkuFacts(afterDocument, sku, rules), sku.facts),
      "catalog_publication_v3_compile_derived_facts_mismatch");
    if (result && ctx.governed && (sku.sellableStandalone || sku.sellableInSubscription)) {
      const state = ctx.skuStates.get(sku.code)?.state;
      if (ctx.productState === undefined || state === undefined) structural.push(ctx.missingLifecycle(position.path));
      else need(ctx.productState === "active" && state === "active", "catalog_lifecycle_fresh_sale_refused");
    }
    const key = combination(ctx, sku);
    need(!ctx.identities.has(key), "duplicate_combination");
    ctx.identities.add(key);
  }
}

function finalizeCompiledPublication(
  ctx: BoundPublicationContext,
  result: CatalogPublishedProduct,
  afterDocument: CatalogPublicationDocument | null | undefined,
  documentDigests: ReadonlySet<string>,
) {
  const { input, structural, missing } = ctx.runtime;
  const { payload, rules, withdrawalOnly } = ctx.admitted;
  assertNativeProductReferences(result);
  const primary = [...ctx.skus.values()].find(sku => sku.id === result.primarySkuId);
  need(ctx.retainedState.product !== null || result.presentation, "catalog_publication_v3_structural_readiness_failed");
  need(equal(sealedPresentation(result.presentation), payload.product.sharedContent.presentation), "catalog_publication_presentation_effect_missing");
  need(primary && primary.status !== "archived", "catalog_publication_v3_compile_primary_foreign");
  const promotions = requiredPromotions(payload.publication.operations.filter(op => !isLifecycleOperation(op)), ctx.retainedState);
  need((!promotions.product || result.status === "active") && promotions.skus.every(code => ctx.skus.get(code)?.status === "active"),
    "catalog_publication_activation_effect_missing");
  if (ctx.governed && ctx.productState) Object.assign(result, {
    schemaVersion: GOVERNED_PUBLICATION_VERSION, lifecycleState: ctx.productState, definitionDigest: input.installedDefinitionDigest,
  });
  const sorted = [...ctx.skus.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const sku of sorted) {
    const before = ctx.originalById.get(sku.id);
    // The sealed SKU revision belongs to the issuing draft. The operation's
    // physical source and the registered document retain their own provenance.
    const state = ctx.skuStates.get(sku.code);
    if (ctx.governed && state) {
      const optionDigest = combination(ctx, sku);
      need(before?.optionDigest === undefined || before.optionDigest === optionDigest, "sku_identity_change_requires_new_sku");
      Object.assign(sku, { schemaVersion: GOVERNED_PUBLICATION_VERSION, lifecycleState: state.state, optionDigest });
    }
    sku.source = before && equal({ ...sku, source: before.source }, before) ? before.source : ctx.claim;
    const finalSku = decodePublishedSku(sku, "skus", sku.code);
    assertNativeSkuNetWeight(finalSku);
    assertPublishedSkuDocumentExclusion(finalSku, documentDigests);
  }
  const lifecycle = ctx.governed && ctx.productState ? { product: ctx.productState, skus: Object.fromEntries([...ctx.skuStates].sort()) } : undefined;
  const changed = ctx.original !== publicationJson(materialState(result, sorted)) || Boolean(lifecycle && !equal(lifecycle, ctx.evidence?.lifecycle ?? null));
  if (!changed && ctx.retainedState.product) {
    result.content = ctx.retainedState.product.content;
    result.source = ctx.retainedState.product.source;
  }
  result.source = ctx.claim;
  const published = decodePublishedProduct(result, documentDigests);
  if (!withdrawalOnly && rules && afterDocument) {
    const [refusal] = rules.validateProduct(ruleProduct(published), [...ctx.skus.values()].map(ruleSku), ctx.documents.map(document => document.canonicalText));
    if (refusal) throw new CatalogPublicationError(adopterIssue("validateProduct", refusal, "product"));
  }
  need(changed || structural.some(isUnavailable) || payload.publication.kind === "compensation" && payload.publication.operations.length > 0, "catalog_publication_v3_compile_change_noop");
  // Keep the assembled views for independent activation checks, while withholding effects.
  ctx.documentExclusionUnavailable = ctx.missingSavedDocumentRevision || [...ctx.referencesById.keys()].some(id => !ctx.documentValueDigests.has(id));
  if (ctx.documentExclusionUnavailable)
    structural.push(missing("catalog_publication_document_bytes_unavailable", result.presentation ? "product.presentation" : "product.content"));
  const operations = payload.publication.operations;
  const priced = sorted.filter(ctx.affected.priced);
  const compiled = {
    product: published, skus: sorted, documents: ctx.documents, operations, creations: ctx.creations,
    priceOperations: ctx.priceOperations, changed, lifecycle,
    pricedSkuCodes: priced.map(sku => sku.code), activationSourceCodes: [...ctx.activationCodes], activating: ctx.runtime.activating,
  };
  return { compiled, primary, priced };
}

export async function checkStructuralResult(ctx: BoundPublicationContext) {
  const { input, position } = ctx.runtime;
  const { definition } = input;
  const { payload, withdrawalOnly } = ctx.admitted;
  position.path = "product";
  position.subject = definition.key;
  const result = ctx.missingProduct ? null : knownProduct(ctx);
  need(ctx.pendingEligibility.size === 0, "catalog_lifecycle_fresh_sale_refused");
  if (!ctx.missingProduct && ctx.lastChildWithdrawn && ![...ctx.skuStates.values()].some(row => row.state === "active")) need(ctx.productState === "withdrawn"
    && payload.publication.operations.some(op => op.op === "set_product_lifecycle" && op.state === "withdrawn"),
  "catalog_lifecycle_last_active_child");
  if (result) {
    assertNativeProductDocument(result);
    if (payload.product.documentRevision)
      need(equal(payload.product.documentRevision, result.document), "catalog_publication_document_source_mismatch");
  }
  const afterDocument = result && selectedDocument(ctx, result.document);
  if (!withdrawalOnly && afterDocument)
    bindDocumentValue(ctx, afterDocument, payload.product.sharedContent.document, "catalog_publication_document_source_mismatch");
  const documentDigests = new Set([...ctx.referencesById.values()].map(reference => reference.digest));
  for (const digest of ctx.documentValueDigests.values()) documentDigests.add(digest);
  if (result?.document) documentDigests.add(result.document.digest);
  if (result) applyProductOverlayAndEffects(ctx, result);
  const productPhysicalChange = result !== null && ctx.retainedState.product !== null && !equal(
    [ctx.retainedState.product.type, ctx.retainedState.product.axes, ctx.retainedState.product.attributes, ctx.retainedState.product.document],
    [result.type, result.axes, result.attributes, result.document]);
  validateMaterializedSkus(ctx, result, afterDocument, productPhysicalChange);
  position.path = "product";
  position.subject = definition.key;
  await checkRetainedAttributes(ctx, ctx.skus.values(), result?.attributes ?? payload.product.attributes);
  need(ctx.skus.size <= (input.capacity ?? 50_000), "product_capacity_exceeded");
  if (!result) return;
  return finalizeCompiledPublication(ctx, result, afterDocument, documentDigests);
}

export type AssembledStructuralResult = NonNullable<Awaited<ReturnType<typeof checkStructuralResult>>>;

export async function checkActivationResult(
  ctx: BoundPublicationContext,
  assembled: AssembledStructuralResult | undefined,
): Promise<void> {
  const { input: { definition, observations }, position, activationIssues, missing } = ctx.runtime;
  const { content, validationPayload } = ctx.admitted;
  position.path = "skus";
  position.subject = definition.key;
  const [priceDraft, activationView, headView, mediaView] = snapshot(
    ctx.priceOperations.length ? { ...validationPayload, product: { ...validationPayload.product, sharedContent: content } } : undefined,
    assembled && (ctx.runtime.activating || assembled.priced.length)
      ? { product: assembled.compiled.product, skus: assembled.compiled.skus } : undefined,
    ctx.expectedHead, ctx.verifiedMedia,
  );
  await checkPrices(ctx, priceDraft);
  if (!assembled) return;
  const { compiled: { product: result, skus: compiledSkus }, primary } = assembled;
  position.path = "skus";
  for (const [index, sku] of compiledSkus.entries()) {
    if (!ctx.affected.priced(sku)) continue;
    const path = `skus.${index}`;
    position.path = `${path}.status`;
    position.subject = sku.code;
    need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
    position.path = `${path}.grossMass`;
    assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, definition);
    position.path = `${path}.identifiers`;
    need(sku.identifiers.some(identifier => identifier.scheme === "gs1:gtin" && identifier.isPrimary && identifier.packagingLevel === "unit"), "unit_trade_identifier_missing");
    position.path = `${path}.logisticsRef`;
    need(sku.logisticsRef, "catalog_publication_v3_activation_readiness_failed");
    position.path = `${path}.memberships`;
    need(sku.memberships.some(row => row.admitted), "catalog_publication_activation_membership_required");
  }
  position.subject = definition.key;
  const activatingProduct = ctx.operations.some(op => op.op === "set_product_status" && op.status === "active");
  const startingGovernedSales = ctx.governed && ctx.lifecycleAvailable && ctx.runtime.activating && (
    ctx.operations.some(op => op.op === "set_product_lifecycle" && op.state === "active"
      || op.op === "restore_product" || op.op === "restore_sku")
    || !ctx.retainedState.skus.some(sku => sku.sellableStandalone || sku.sellableInSubscription));
  if (activatingProduct || startingGovernedSales) {
    position.path = "product.primarySkuId";
    position.subject = primary?.code ?? definition.key;
    need(primary?.status === "active" && (primary.sellableStandalone || primary.sellableInSubscription), "catalog_publication_v3_active_primary_required");
    position.path = "product.presentation";
    need(result.presentation, "catalog_publication_v3_presentation_required");
  }
  if (activationView) {
    const verdict = publicationReadinessVerdict.safeParse(await observe(() =>
      observations?.assessActivation?.(activationView, headView, mediaView) ?? Promise.resolve(undefined)));
    if (!verdict.success) activationIssues.push(missing("activation_unknown", "publication"));
    else if (!verdict.data.ready) throw new CatalogPublicationError(adopterIssue("assessActivation", verdict.data.reasons[0]!, "product"));
  }
}

export function addPendingPreviewIssues(
  ctx: BoundPublicationContext,
  assembled: AssembledStructuralResult | undefined,
): void {
  if (!assembled || ctx.runtime.activating || assembled.priced.length) return;
  const result = assembled.compiled.product;
  for (const [index, sku] of ctx.admitted.payload.skus.entries()) {
    const path = `skus.${index}`;
    if (!sku.grossMass) ctx.runtime.pending.push({ path: `${path}.grossMass`, code: "gross_mass_missing" });
    if (!sku.logisticsRef) ctx.runtime.pending.push({ path: `${path}.logisticsRef`, code: "logistics_reference_missing" });
    if (!sku.priceOperations?.length) ctx.runtime.pending.push({ path: `${path}.priceOperations`, code: "price_reference_missing" });
    const modes = ctx.admitted.payload.product.sharedContent.requestedModes.find(intent => intent.skuCode === sku.code)?.modes;
    for (const channel of modes ?? []) ctx.runtime.pending.push({ path: `${path}.priceOperations`, code: "activation_not_assessed", channel });
    const mediaIssue = catalogPublicationMediaIssue(result.presentation?.mediaRef, ctx.skus.get(sku.code!)?.assetRefs ?? [], ctx.media.get(sku.code!));
    if (mediaIssue) ctx.runtime.pending.push({ path: `${path}.assetRefs`, code: mediaIssue });
  }
}
