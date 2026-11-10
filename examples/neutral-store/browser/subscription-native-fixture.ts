import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { StoreConfig } from '../shared/config.ts';
import type { EditorCandidate, EditorSubscription } from '../shared/subscription-edit.ts';
import type { PackageEditRequest, SizedEditRequest } from '@openlup/platform/subscriptions/contracts';
import { routes } from '../shared/routes.ts';

export interface SubscriptionProofOptions { composeProject: string }
export const test = base.extend<SubscriptionProofOptions>({ composeProject: ['',{ option: true }] });
export { expect };

/** Test-only owner access to an explicitly selected disposable Compose installation.
 * No template/price-list backfill: every editable subscription must originate in checkout. */
export async function nativeSubscription(page: Page,baseURL: string | undefined,project: string,quantity = 6,options: { completeIntro?: boolean } = {}) {
  if (!baseURL || !/^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(baseURL) || !/^[a-z0-9-]+$/u.test(project)) throw new Error('starter_subscription_browser_project_required');
  const compose = (args: string[],input?: string) => execFileSync('docker',['compose','--project-name',project,...args],{
    encoding: 'utf8',stdio: ['pipe','pipe','pipe'],...(input === undefined ? {} : { input }),timeout: 30000 });
  const sql = (query: string) => compose(['exec','-T','database','psql','-X','-v','ON_ERROR_STOP=1','-At','-U','starter_install','-d','neutral_store','-c',query]).trim();
  if (sql("SELECT pg_catalog.shobj_description(oid,'pg_database') FROM pg_catalog.pg_database WHERE datname=current_database()") !== 'openlup-neutral-store-demo-v1') throw new Error('starter_subscription_demonstration_required');
  const uuid = (value: string) => { if (!/^[0-9a-f-]{36}$/iu.test(value)) throw new Error('starter_subscription_fixture_identity_invalid'); return value; };
  const rows = (query: string): Record<string,unknown>[] => JSON.parse(sql(`SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM (${query}) t`));
  const action = async (operation: string,data: Record<string,unknown>,key: string = randomUUID()) => {
    const response = await page.request.post(`${baseURL}/api/actions/${operation}`,{
      headers: { Origin: baseURL,'X-Starter-Request': '1','Idempotency-Key': key },data });
    return { status: response.status(),body: await response.json() };
  };
  const config = (await (await page.request.get(`${baseURL}/api/config`)).json()).config as StoreConfig;
  const email = `${randomUUID()}@example.test`;
  const purchase = { acquisitionCapability: 'subscription-acquisition.v1', locale: 'en',configuration: config.id,country: config.market.country,
    termsRevision: config.legal.revision,termsAccepted: true,email,firstName: 'Example',lastName: 'Customer',phone: '000000000',
    line1: '1 Example Street',city: 'Example City',postalCode: '00000',
    cart: { schemaVersion: 1,configuration: config.id,mode: 'subscription',cadenceDays: config.offer.defaultCadenceDays,
      lines: [{ sku: config.offer.products[0]!.sku,quantity },...(quantity > 1 ? [{ sku: config.offer.products[1]!.sku,quantity: 2 }] : [])] } };
  const quote = await action('offer.validate',purchase); expect(quote.body.ok).toBe(true);
  const bought = await action('checkout.create',{ ...purchase,quoteAcceptance: quote.body.value.quoteAcceptance,expectedTotal: quote.body.value.expectedTotal });
  expect(bought.body.ok).toBe(true);
  const paid = await action('payment.simulate',{ orderRef: bought.body.value.orderRef,token: bought.body.value.token,outcome: 'captured' });
  expect(paid.body.ok).toBe(true);
  expect((await action('auth.request',{ email })).body.ok).toBe(true);
  const mail = compose(['exec','-T','--user','node','application','cat','/application/.context/captured-messages/identity.jsonl']).trim().split('\n')
    .map(line => JSON.parse(line)).findLast(message => message.email === email);
  if (!mail || typeof mail.token !== 'string') throw new Error('starter_subscription_native_challenge_required');
  expect((await action('auth.verify',{ token: mail.token })).body.ok).toBe(true);
  const read = async (): Promise<EditorSubscription> => {
    const result = await action('account.read',{}); expect(result.body.ok).toBe(true);
    const subscription = result.body.value.subscriptionEditors.find((item: EditorSubscription) => item.status === 'active');
    if (!subscription) throw new Error('starter_subscription_purchase_required'); return subscription;
  };
  const purchased = await read(),id = uuid(purchased.subscriptionId);
  // Servicing starts after the real introductory phase, never by rewriting its marker/count.
  if (config.quote.acquisition.enabled && options.completeIntro !== false) {
    const code = `import assert from 'node:assert/strict';import pg from 'pg';
      import {createNativeRenewalCodec,createPostgresRenewalStore,createPostgresRenewalSettlementPort,runOneAutomaticSubscriptionRenewal} from '@openlup/platform/subscriptions';
      import {createPostgresRenewalReservationPort} from '@openlup/platform/inventory';
      import {composeRenewalSandbox} from './host/renewal-sandbox.ts';
      import {selectConfiguration} from './owned/store.config.ts';
      const config=selectConfiguration(${JSON.stringify(config.id)}),pool=new pg.Pool({connectionString:'postgresql://starter_runtime@database/neutral_store'});
      const withTransaction=async work=>{const db=await pool.connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
      try {for(let cycle=0;cycle<2;cycle++) {
        const next=(await pool.query('SELECT next_cycle_at FROM public.subscriptions WHERE id=$1',[${JSON.stringify(id)}])).rows[0].next_cycle_at;
        const at=new Date(new Date(next).getTime()+60000).toISOString(),codec=createNativeRenewalCodec(),store=createPostgresRenewalStore(pool,codec,withTransaction);
        const sandbox=composeRenewalSandbox({executor:pool,withTransaction,codec,config:{...config.renewal,sandbox:{initial:'succeeded',retry:'succeeded'}},now:()=>at,
          failureTemplate:config.purchase.sandbox.dunningTemplateSlug,recoveredTemplate:config.purchase.sandbox.recoveryTemplateSlug,recoveryPath:config.purchase.sandbox.recoveryUrlPath});
        await sandbox.refresh();const due=(await store.listDue(100,at)).find(row=>row.subscriptionId===${JSON.stringify(id)});assert.ok(due);
        const result=await runOneAutomaticSubscriptionRenewal({store,settlement:createPostgresRenewalSettlementPort(pool,codec,withTransaction),
          inventory:createPostgresRenewalReservationPort(pool),paymentRails:sandbox.paymentRails,policy:sandbox.policy,
          failureHandoff:{async handoffFailure(){throw Error('unexpected_intro_renewal_failure');}},workerId:'editor-browser-intro'},due,at);
        assert.equal(result.status,'succeeded');
      }} finally{await pool.end();}`;
    compose(['exec','-T','--user','node','application','node','--input-type=module'],code);
  }
  const sub = await read();
  if (!sub.lines.some(line => !line.isAddon) || sub.editBlockedReason === 'starter_subscription_template_unavailable') {
    throw new Error('starter_subscription_purchase_template_required: awaiting native purchase template attachment; no fixture backfill permitted');
  }
  const catalogue = async (sized = false,optIn = false) => {
    const result = await action('subscription.catalog',{ subscriptionRef: id,mode: sized ? 'sized' : 'classic',...(optIn ? { optIn: true } : {}) });
    expect(result.body.ok).toBe(true); return result.body.value as { candidates: EditorCandidate[]; context: { compositionConstraint: Record<string,unknown> } };
  };
  const accepted = async (request: PackageEditRequest | SizedEditRequest | Record<string,unknown>,key: string = randomUUID()) => {
    const preview = await action('subscription.preview',{ request },key); expect(preview.body.ok).toBe(true);
    expect(preview.body.value.preview.canApply).toBe(true);
    return { key,request: { ...request,acceptedQuoteHash: preview.body.value.quoteHash },preview: preview.body.value };
  };
  const apply = async (request: PackageEditRequest | SizedEditRequest | Record<string,unknown>,key?: string) => {
    const quote = await accepted(request,key); const result = await action('subscription.command',{ request: quote.request },quote.key);
    expect(result.body.ok).toBe(true); return { ...quote,result: result.body.value };
  };
  const classicRequest = async (): Promise<PackageEditRequest> => {
    const current = await read(); return { subscriptionId: id,expectedTemplateVersion: current.templateVersion,planDays: current.cadenceDays,
      base: current.lines.filter(line => !line.isAddon).map(line => ({ variantId: line.variantId,qty: line.qty })),
      addons: current.lines.filter(line => line.isAddon).map(line => ({ variantId: line.variantId,qty: line.qty })) };
  };
  const sizedRequest = async (optIn = false): Promise<SizedEditRequest> => {
    const current = await read(),catalog = await catalogue(true,optIn);
    const coreLines = current.lines.filter(line => !line.isAddon).map(line => ({ variantId: line.variantId,qty: line.qty }));
    return { action: 'resize_bundle',subscriptionId: id,expectedTemplateVersion: current.templateVersion,cadenceDays: current.cadenceDays,
      compositionConstraint: { ...catalog.context.compositionConstraint,value: coreLines.reduce((sum,line) => sum+line.qty,0) },
      resizeLever: { kind: 'subscription.sized.parcel',value: { coreLines,...(optIn ? { optInToSized: true } : {}) } } };
  };
  const optIn = async () => apply(await sizedRequest(true));
  const eventPricing = () => rows(`SELECT payload->'linePricing' AS pricing FROM public.subscription_events WHERE subscription_id='${id}' AND payload ? 'linePricing' ORDER BY occurred_at DESC,id DESC LIMIT 1`)[0]?.pricing;
  const subjectKey = `starter_sized_subject:${config.id}`;
  const subject = () => rows(`SELECT value_text FROM public.commerce_settings WHERE key='${subjectKey}'`)[0]!.value_text as string;
  const setSubject = (value: unknown) => sql(`UPDATE public.commerce_settings SET value_text=convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('hex')}','hex'),'UTF8') WHERE key='${subjectKey}'`);
  const setStock = (variantId: string,amount: number) => {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('fixture_stock_invalid');
    const code = `import pg from 'pg'; import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
      const pool=new pg.Pool({connectionString:'postgresql://starter_runtime@database/neutral_store'});
      try {const row=(await pool.query('SELECT sku FROM public.catalog_skus WHERE id=$1',[${JSON.stringify(uuid(variantId))}])).rows[0];
      await createPostgresFulfillmentStockSyncPort(pool,{sourceKey:${JSON.stringify(`starter-demo:${config.id}`)},readLocalInventoryStock:async()=>[]})
      .recordProviderStockCurrent({requestKey:${JSON.stringify(randomUUID())},snapshot:{providerRef:'starter-sandbox',collectedAt:'2030-01-01T00:00:00.000Z',sourceRevision:null,revisionSource:'collection',quantityKind:'snapshot',skuRef:row.sku,totalQuantity:${amount},forSaleQuantity:${amount},reservedOrUnavailableQuantity:0,syncRunId:'editor-browser'},inventoryClass:'sellable',lastSyncedAt:'2030-01-01T00:00:00.000Z',staleAfter:'3000-01-01T00:00:00.000Z'});}finally{await pool.end()}`;
    compose(['exec','-T','--user','node','application','node','--input-type=module'],code);
  };
  const captureNotices = (): { key: string; kind: string; subscriptionId: string }[] => {
    const code = `import pg from 'pg'; import {createPostgresLifecycleMessages} from '@openlup/platform/subscriptions';
      import {createPostgresTransactionalDeliveryStore,createTransactionalDelivery,createCapturedTransactionalDelivery} from '@openlup/platform/communications';
      const url='postgresql://starter_runtime@database/neutral_store',pool=new pg.Pool({connectionString:url}),store=createPostgresTransactionalDeliveryStore({connectionString:url}),captures=[];
      try {const delivery=createTransactionalDelivery({store,delivery:createCapturedTransactionalDelivery({outcome(command){captures.push({key:command.idempotencyKey});return {state:'accepted'}}})});
      const kinds=new Map();const dispatcher=createPostgresLifecycleMessages({delivery:{send:delivery.send,readReceipt:store.readReceipt},async withSession(work){const db=await pool.connect();try{return await work(db)}finally{db.release()}},async bind(notice){kinds.set(notice.messageKey,{kind:notice.kind,subscriptionId:notice.subscriptionId});return {recipientReference:'client:'+notice.clientId,templateReference:notice.templateSlug}}});
      await dispatcher.run(100); await dispatcher.run(100);process.stdout.write(JSON.stringify(captures.map(item=>({...item,...kinds.get(item.key)}))));}finally{await store.close();await pool.end()}`;
    return JSON.parse(compose(['exec','-T','--user','node','application','node','--input-type=module'],code));
  };
  const open = (sized = false,invitation = false) => page.goto(`${routes[sized ? 'sizedEdit' : 'classicEdit'].en}?subscription=${id}${invitation ? '&optIn=1' : ''}`);
  const confirm = async (invitation = false) => {
    await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
    await page.getByRole('button',{ name: invitation ? 'I accept size-aware servicing and the price; save' : 'Confirm changes',exact: true }).click();
    await expect(page).toHaveURL(/packageSaved=1$/);
  };
  return { action,config,sub,id,read,rows,sql,uuid,catalogue,accepted,apply,classicRequest,sizedRequest,optIn,eventPricing,subject,setSubject,setStock,captureNotices,open,confirm };
}
export type NativeSubscriptionFixture = Awaited<ReturnType<typeof nativeSubscription>>;
