import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { expect } from "vitest";
import { bindChannelPurchasedRows, canonicalChannelSource, channelSourceDigest, createChannelPurchasedSourceStore } from "@openlup/platform/channels/server";
import type { ChannelPullPage,NormalizedChannelOrder,ChannelPurchaseCapture } from "@openlup/platform/channels";
import type { ChannelRetainedPurchaseContext } from "@openlup/platform/channels/server";

/** Installer-owned imported history, never a simulated fresh qualification/approval. */
export async function channelPurchaseFixture(db: PoolClient, rail: "managed" | "portable") {
  const f = purchaseFixture(), { capture, context } = f;
  const actor = capture.execution.actorId, job = capture.execution.jobRunId;
  const providerKind = rail === "managed" ? /stock\.provider_kind='([^']+)'/u.exec((await db.query("SELECT pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure) body")).rows[0].body)![1] : "synthetic_stock";
  if (rail === "managed") {
    await db.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,'synthetic-channel@example.invalid','admin',true)", [actor]);
  } else await db.query("INSERT INTO public.platform_control_operators(principal_id) VALUES($1)", [actor]);
  await db.query(`INSERT INTO public.sales_channel_connections(id,slug,connector_provider_kind,connector_shape,display_name,status,
    control_version,application_ref,environment_ref,seller_external_ref) VALUES($1,'synthetic-link',$2,'direct','Synthetic link','active',11,$3,$4,$5)`,
  [capture.scope.connectionId, capture.scope.connectorKind, capture.namespace.applicationRef, capture.scope.environmentRef, capture.scope.sellerRef]);
  await db.query(`INSERT INTO public.sales_channels(id,connection_id,slug,display_name,status,channel_external_ref,currency,region_code,control_version,
    buyer_comms_owner,delivery_selection) VALUES($1,$2,$3,'Synthetic surface','active',$4,'EUR','DE',17,'channel',$5)`,
  [capture.scope.channelId, capture.scope.connectionId, capture.normalized.channelSlug, capture.namespace.channelExternalRef,
    { providerKind, serviceCode: "SYNTHETIC", reference: "fixture:delivery" }]);
  const product = randomUUID();
  await db.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Synthetic product','active')", [product, product]);
  if (rail === "managed") await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,pet_type,net_weight_g,kcal_per_unit)
    VALUES($1,$2,'PART-A','Synthetic component','active','other',1,1)`, [context.bundle.components[0].skuId, product]);
  else await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status) VALUES($1,$2,'PART-A','Synthetic component','active')", [context.bundle.components[0].skuId, product]);
  await db.query("INSERT INTO public.catalog_bundles(id,code,title) VALUES($1,$2,'Synthetic retained kit')", [context.bundle.bundleId, context.bundle.code]);
  await db.query("INSERT INTO public.catalog_bundle_components(bundle_id,catalog_sku_id,quantity,is_addon) VALUES($1,$2,1,false)", [context.bundle.bundleId, context.bundle.components[0].skuId]);
  const digest = (await db.query("SELECT public.catalog_bundle_composition_digest($1) digest", [context.bundle.bundleId])).rows[0].digest;
  context.bundle.compositionDigest = digest; context.firstApproval.bundleDigest = digest; context.firstQualification.bundleDigest = digest;
  // Only the trusted installer can import the already-issued facts. Runtime never gets these DDL rights.
  await db.query("ALTER TABLE public.catalog_bundles DISABLE TRIGGER channel_retained_bundle_guard");
  await db.query("UPDATE public.catalog_bundles SET composition_locked_at=$2,composition_digest=$3 WHERE id=$1",
    [context.bundle.bundleId, context.bundle.lockedAt, digest]);
  await db.query("ALTER TABLE public.catalog_bundles ENABLE TRIGGER channel_retained_bundle_guard");
  await db.query(`INSERT INTO public.sales_channel_listings(id,channel_id,sellable_kind,sellable_bundle_id,external_offer_ref,control_version)
    VALUES($1,$2,'bundle',$3,$4,21)`, [context.listing.id, capture.scope.channelId, context.bundle.bundleId, context.listing.externalOfferRef]);
  await db.query(`INSERT INTO public.sales_channel_listing_qualifications(id,listing_id,actor_id,listing_version,body) VALUES($1,$2,$3,$4,$5)`,
    [context.firstQualification.id, context.listing.id, actor, context.firstQualification.listingVersion, context.firstQualification]);
  await db.query(`INSERT INTO public.sales_channel_listing_approvals(id,listing_id,qualification_id,actor_id,listing_version,body) VALUES($1,$2,$3,$4,$5,$6)`,
    [context.firstApproval.id, context.listing.id, context.firstQualification.id, actor, context.firstApproval.listingVersion, context.firstApproval]);
  await db.query("ALTER TABLE public.sales_channel_listings DISABLE TRIGGER channel_retained_listing_guard");
  await db.query(`UPDATE public.sales_channel_listings SET current_qualification_id=$2,current_approval_id=$3,exposure_issued_basis_ref=$3,
    exposure_issued_units=60,exposure_generation=1 WHERE id=$1`, [context.listing.id, context.firstQualification.id, context.firstApproval.id]);
  await db.query("ALTER TABLE public.sales_channel_listings ENABLE TRIGGER channel_retained_listing_guard");
  const scope = { connectionId: capture.scope.connectionId, channelId: capture.scope.channelId, connectorProviderKind: capture.scope.connectorKind,
    connectorShape: "direct", applicationRef: capture.namespace.applicationRef, environmentRef: capture.scope.environmentRef,
    sellerRef: capture.scope.sellerRef, channelExternalRef: capture.namespace.channelExternalRef, externalOfferRef: context.listing.externalOfferRef };
  await db.query(`INSERT INTO public.sales_channel_control_operations(resource_kind,resource_id,operation,operation_id,actor_id,input_digest,canonical_text,result)
    VALUES('listing',$1,'exposure_allocate',$2,$3,repeat('a',64),'{}',$4)`, [context.listing.id, randomUUID(), actor,
    { before: { generation: 0 }, appliedGeneration: 1, effect: { scope, bundleDigest: digest } }]);
  // The reference runner owns this dormant job seed; this fixture enables only its transaction.
  await db.query("INSERT INTO public.platform_job_controls(job_name,enabled,active_driver) VALUES('channel-order-pull',false,$1) ON CONFLICT(job_name) DO NOTHING", [rail === "managed" ? "vercel_cron" : "scheduler"]);
  const driver = (await db.query("SELECT active_driver FROM public.platform_job_controls WHERE job_name='channel-order-pull'")).rows[0].active_driver;
  await db.query(`UPDATE public.platform_job_controls SET enabled=true,lease_token=$1,lease_owner=$2,lease_until=now()+interval '1 hour'
    WHERE job_name='channel-order-pull'`, [job, driver]);
  if (rail === "managed") {
    await db.query("UPDATE public.platform_job_controls SET lease_expires_at=now()+interval '1 hour' WHERE job_name='channel-order-pull'");
    await db.query(`INSERT INTO public.platform_job_runs(id,job_name,trigger_source,driver,lease_owner,lease_expires_at)
      VALUES($1,'channel-order-pull','vercel_cron',$2,$2,now()+interval '1 hour')`, [job, driver]);
  } else await db.query("INSERT INTO public.platform_job_runs(id,job_name,driver,lease_until) VALUES($1,'channel-order-pull',$2,now()+interval '1 hour')", [job, driver]);
  capture.normalized.payloadDigest = capture.rawSourceDigest;
  capture.normalizedDigest = channelSourceDigest(canonicalChannelSource(capture.normalized));
  const bound = bindChannelPurchasedRows({ capture, contexts: [context] });
  const page: ChannelPullPage = { schemaVersion: "channel.pull-page.v1", pagePacketId: capture.pagePacketRef, scope: capture.scope, namespace: capture.namespace,
    execution: capture.execution, expected: { cursor: null, watermark: null, generation: 0 }, request: { from: null, limit: 50 },
    events: [{ providerEventId: capture.providerEventId, externalOrderRef: capture.externalOrderRef, externalOrderRevision: capture.externalOrderRevision,
      occurredAt: "2026-02-12T07:15:00Z", rawSourceDigest: capture.rawSourceDigest, disposition: "purchase", captureRef: capture.captureId }],
    observedHead: { providerEventId: capture.providerEventId, occurredAt: "2026-02-12T07:15:00Z" }, observedAt: "2026-02-12T07:19:00Z",
    next: { cursor: capture.providerEventId, watermark: "2026-02-12T07:15:00Z", generation: 1 } };
  const signatures: Record<string, readonly string[]> = {
    channel_ingest_record_inbound_event: ["uuid","text","text","text","jsonb","text","text"], channel_ingest_capture_read: ["uuid","text","uuid"],
    channel_pull_page_record: ["uuid","uuid","uuid","uuid","text","text"], channel_pull_page_read: ["uuid","uuid","uuid","text"],
    channel_pull_progress_commit: ["uuid","uuid","uuid","uuid","text","timestamptz","bigint","text","timestamptz"],
    channel_purchase_conversion_command: ["uuid","text","uuid","uuid","text"],
  };
  async function asRole<T>(role: string, work: () => Promise<T>): Promise<T> {
    if (!["service_role", "anon", "authenticated"].includes(role)) throw new Error("fixture_role_invalid");
    await db.query("SAVEPOINT channel_role");
    try {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, sub: actor })]);
      await db.query(`SET LOCAL ROLE ${role}`);
      expect((await db.query("SELECT current_user name")).rows[0].name).toBe(role);
      return await work();
    } finally { await db.query("ROLLBACK TO SAVEPOINT channel_role; RELEASE SAVEPOINT channel_role"); }
  }
  // Successful function writes survive role reset; failures roll back just their statement.
  const failures: { name: string; code?: string; message?: string; where?: string }[] = [];
  async function rpc(name: string, args: Record<string, unknown>) {
    if (!/^(?:channel_|commerce_payment_control_|commerce_create_channel_order|inventory_new_purchase_stock_read)/u.test(name) || !/^[a-z_]+$/u.test(name) || Object.keys(args).some(key => !/^p_[a-z_]+$/u.test(key))) throw new Error("fixture_rpc_unknown");
    const casts = signatures[name];
    await db.query("SAVEPOINT channel_rpc");
    try {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role", sub: actor })]);
      await db.query("SET LOCAL ROLE service_role");
      const data = (await db.query(`SELECT public.${name}(${Object.keys(args).map((key,index)=>`${key} => $${index+1}${casts ? `::${casts[index]}` : ""}`).join(',')}) response`,
        Object.values(args).map(value => value !== null && typeof value === "object" ? JSON.stringify(value) : value))).rows[0].response;
      await db.query("RESET ROLE; RELEASE SAVEPOINT channel_rpc");
      return { data, error: null };
    } catch(error) {
      const detail = error as { code?: string; message?: string; where?: string }; failures.push({ name, code: detail.code, message: detail.message, where: detail.where });
      await db.query("ROLLBACK TO SAVEPOINT channel_rpc; RELEASE SAVEPOINT channel_rpc");
      return { data: null, error: { code: detail.code, message: detail.message ?? String(error) } };
    }
  }
  const source = createChannelPurchasedSourceStore({ actorId: actor, rail, client: { rpc } });
  return { ...f, capture: bound, page, source, asRole, actor, job, rpc, failures, providerKind };
}

/** Import a second already-issued listing sharing the original physical SKU. */
export async function secondChannelRetainedListing(db:PoolClient, first:Awaited<ReturnType<typeof channelPurchaseFixture>>) {
  const original=structuredClone(first.context),listing=randomUUID(),bundle=randomUUID(),approval=randomUUID(),qualification=randomUUID();
  const context={...original,
    listing:{...original.listing,id:listing,bundleId:bundle,externalOfferRef:"offer:second",approvalId:approval},
    bundle:{...original.bundle,bundleId:bundle,code:"LOCKED-SECOND"},
    firstApproval:{...original.firstApproval,id:approval,listingId:listing,qualificationId:qualification,firstBasisApprovalId:approval},
    firstQualification:{...original.firstQualification,id:qualification,listingId:listing,offer:{...original.firstQualification.offer,externalOfferRef:"offer:second"}}};
  await db.query("INSERT INTO public.catalog_bundles(id,code,title) VALUES($1,$2,'Synthetic second retained kit')",[bundle,context.bundle.code]);
  await db.query("INSERT INTO public.catalog_bundle_components(bundle_id,catalog_sku_id,quantity,is_addon) VALUES($1,$2,1,false)",[bundle,context.bundle.components[0].skuId]);
  const digest=(await db.query("SELECT public.catalog_bundle_composition_digest($1) digest",[bundle])).rows[0].digest;
  context.bundle.compositionDigest=digest;context.firstApproval.bundleDigest=digest;context.firstQualification.bundleDigest=digest;
  await db.query("ALTER TABLE public.catalog_bundles DISABLE TRIGGER channel_retained_bundle_guard");
  await db.query("UPDATE public.catalog_bundles SET composition_locked_at=$2,composition_digest=$3 WHERE id=$1",[bundle,context.bundle.lockedAt,digest]);
  await db.query("ALTER TABLE public.catalog_bundles ENABLE TRIGGER channel_retained_bundle_guard");
  await db.query("INSERT INTO public.sales_channel_listings(id,channel_id,sellable_kind,sellable_bundle_id,external_offer_ref,control_version) VALUES($1,$2,'bundle',$3,'offer:second',21)",[listing,first.capture.scope.channelId,bundle]);
  await db.query("INSERT INTO public.sales_channel_listing_qualifications(id,listing_id,actor_id,listing_version,body) VALUES($1,$2,$3,$4,$5)",[qualification,listing,first.actor,context.firstQualification.listingVersion,context.firstQualification]);
  await db.query("INSERT INTO public.sales_channel_listing_approvals(id,listing_id,qualification_id,actor_id,listing_version,body) VALUES($1,$2,$3,$4,$5,$6)",[approval,listing,qualification,first.actor,context.firstApproval.listingVersion,context.firstApproval]);
  await db.query("ALTER TABLE public.sales_channel_listings DISABLE TRIGGER channel_retained_listing_guard");
  await db.query("UPDATE public.sales_channel_listings SET current_qualification_id=$2,current_approval_id=$3,exposure_issued_basis_ref=$3,exposure_issued_units=60,exposure_generation=1 WHERE id=$1",[listing,qualification,approval]);
  await db.query("ALTER TABLE public.sales_channel_listings ENABLE TRIGGER channel_retained_listing_guard");
  const scope={connectionId:first.capture.scope.connectionId,channelId:first.capture.scope.channelId,connectorProviderKind:first.capture.scope.connectorKind,connectorShape:"direct",applicationRef:first.capture.namespace.applicationRef,environmentRef:first.capture.scope.environmentRef,sellerRef:first.capture.scope.sellerRef,channelExternalRef:first.capture.namespace.channelExternalRef,externalOfferRef:"offer:second"};
  await db.query("INSERT INTO public.sales_channel_control_operations(resource_kind,resource_id,operation,operation_id,actor_id,input_digest,canonical_text,result) VALUES('listing',$1,'exposure_allocate',$2,$3,repeat('a',64),'{}',$4)",[listing,randomUUID(),first.actor,{before:{generation:0},appliedGeneration:1,effect:{scope,bundleDigest:digest}}]);
  return context;
}

// Host-side synthetic input remains independent of package-internal test modules.
const id = (number: number): string => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const digest = "c".repeat(64);
function orderFixture(): NormalizedChannelOrder {
  return {
    contractVersion: "channel.order.v1", channelSlug: "synthetic-surface", externalOrderRef: "sale:47",
    externalOrderRevision: "revision:8", providerEventId: "delivery:903", placedAt: "2026-02-12T08:11:00+01:00", currency: "EUR",
    buyer: { externalCustomerRef: "buyer:61", email: "relay@example.test", emailIsMasked: true,
      firstName: "Zoë", lastName: null, phone: null, taxId: null, companyName: null },
    shipTo: { recipientName: "Zoë Example", line1: "Example Lane 7", line2: null, postalCode: "10115", city: "Example",
      countryCode: "DE", phone: null, pickupPointRef: "locker:24" },
    lines: [{ externalLineRef: "line:19", sellable: { kind: "sku", externalOfferRef: "offer:53", skuCode: "PART-A" },
      quantity: 3, unitGrossMinor: 3, lineGrossMinor: 9, lineDiscountMinor: 4, vatRateBps: 1900 }],
    shipping: { grossMinor: 7, discountMinor: 2, methodLabel: "Collected service", carrierHint: null },
    totals: { itemsGrossMinor: 9, itemsDiscountMinor: 4, shippingGrossMinor: 7, shippingDiscountMinor: 2, grandTotalMinor: 10 },
    payment: { state: "paid_externally", externalPaymentRef: "collection:78", paidAt: "2026-02-12T08:13:17+01:00", methodLabel: null },
    payloadDigest: "wire:χ:512",
  };
}
export function purchaseFixture(): { capture: ChannelPurchaseCapture; context: ChannelRetainedPurchaseContext } {
  const order = orderFixture();
  order.lines[0].sellable = { kind: "bundle", externalOfferRef: "offer:53", bundleCode: null };
  const scope = { connectionId: id(101), channelId: id(102), connectorKind: "synthetic_source", sellerRef: "seller:23",
    environmentRef: "test-region", connectionVersion: 11, registryVersion: 17, currency: "EUR", regionCode: "DE" };
  const namespace = { applicationRef: "application:29", channelExternalRef: "surface:31" };
  const context: ChannelRetainedPurchaseContext = {
    scope, namespace, channelSlug: order.channelSlug,
    listing: { id: id(103), version: 21, scope, bundleId: id(104), externalOfferRef: "offer:53", state: "approved", manualStop: false, approvalId: id(105) },
    bundle: { bundleId: id(104), code: "LOCKED-KIT", compositionDigest: digest, lockedAt: "2026-02-10T10:12:00Z",
      fulfillmentMode: "virtual", constraintRef: null, components: [{ skuId: id(107), skuCode: "PART-A", quantity: 1, isAddon: false }] },
    firstApproval: { id: id(105), listingId: id(103), qualificationId: id(106), listingVersion: 19, approvedBy: id(108),
      approvedAt: "2026-02-10T10:13:00Z", bundleDigest: digest, requestedPrice: { grossMinor: 41, currency: "EUR" },
      controlledDigest: digest, termsDigest: digest, policyRef: "policy:43", firstBasisApprovalId: id(105), recoveryPolicy: "same_approved_offer_when_ready" },
    firstQualification: { id: id(106), listingId: id(103), listingVersion: 18, connectionVersion: 9, registryVersion: 15,
      bundleDigest: digest, catalogHead: { protocol: "catalog.v1", headDigest: null }, purchaseMode: "one_time", sourceDigest: digest,
      policyRef: "policy:43", policyDigest: digest, mapping: [{ skuId: id(107), externalProductRef: "product:59" }],
      basis: [{ skuId: id(107), weightMinor: 1, priceListId: "list:67", priceEntryId: "entry:71", resolvedAt: "2026-02-10T10:01:00Z",
        sourceMode: "one_time", sourceAmountKind: "gross", matchedMinQty: 1 }], requestedPrice: { grossMinor: 41, currency: "EUR" },
      validUntil: "2026-02-10T10:20:00Z", disposition: "qualified", reasons: [],
      offer: { observationRef: "observation:73", observedAt: "2026-02-10T10:02:00Z", scope, externalOfferRef: "offer:53",
        revisionRef: null, controlledDigest: digest, products: [{ externalProductRef: "product:59", quantity: 1,
          unitIdentifiers: [{ kind: "synthetic", issuer: "fixture", value: "unit:79" }] }], price: { grossMinor: 41, currency: "EUR" },
        terms: { digest, deliveryRef: "delivery:83", returnsRef: null, documentPolicyRef: "document:89", fiscalProfileRef: "fiscal:97" },
        sellingState: "ACTIVE", restrictions: [] },
    },
  };
  const capture: ChannelPurchaseCapture = { schemaVersion: "channel.purchase-source.v1", captureId: id(110), scope, namespace,
    execution: { actorId: id(111), jobRunId: id(112) }, providerEventId: order.providerEventId, externalOrderRef: order.externalOrderRef,
    externalOrderRevision: order.externalOrderRevision, normalized: order, normalizedDigest: digest, rawSourceDigest: "d".repeat(64),
    products: [{ externalLineRef: "line:19", externalOfferRef: "offer:53", purchasedAt: "2026-02-12T07:12:00Z",
      products: [{ externalProductRef: "product:59", quantityPerSet: 1 }] }],
    capturedAt: "2026-02-12T07:20:00Z", pagePacketRef: id(113) };
  return { capture, context };
}
