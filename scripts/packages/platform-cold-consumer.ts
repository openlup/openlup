/** Cold installed-artifact proof. Never repack or use workspace resolution. */
import ts from "typescript";
import { disposableLabelArgs } from "../disposable-docker.mjs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { env as processEnvironment } from "node:process";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORM_MODULE_GRAPH } from "../../eslint.config.js";
import { assertInstalledPackages, isolatedConsumerEnv, readCurrentPackManifest } from "./pack-manifest-input.ts";
import { POSTGRES_PROOF_IMAGE } from "./outbox-disposable-postgres.ts";
import { proveApplicationUpgradePostgres } from "./application-upgrade-proof.ts";

export const NON_ADAPTER_ENTRIES = [
  "lifecycle",
  "portability",
  "operations",
  "operations/contracts",
  "account-support",
  "account-support/contracts",
  "marketing",
  "marketing/contracts",
  "marketing/server",
  "commerce",
  "commerce/contracts",
  "commerce/server",
  "invoicing",
  "invoicing/contracts",
  "subscriptions",
  "subscriptions/contracts",
  "fulfillment",
  "fulfillment/contracts",
  "payments",
  "payments/contracts",
  "bff",
  "catalog/contracts",
  "communications/contracts",
  "composition",
  "http",
  "identity/contracts",
  "inventory",
  "inventory/contracts",
  "kernel",
  "pricing",
  "pricing/browser",
  "pricing/contracts",
  "promotions/contracts",
  "scheduler",
  "shipping",
  "shipping/contracts",
] as const;
// identity, communications, promotions and catalog are adapter entries: their declarations reach data/pg types.
// Its cold runtime import/refusal is below; declarations compile after selecting peers.
export const ADAPTER_ENTRIES = [
  "operations/server",
  "marketing/server/postgres",
  "blob",
  "catalog",
  "communications",
  "communications/klaviyo",
  "communications/resend",
  "payments/stripe",
  "payments/tpay",
  "fulfillment/omnipack",
  "data",
  "identity",
  "job-ledger",
  "migrations",
  "promotions",
] as const;
export const OPTIONAL_PEERS = ["pg", "@types/pg", "@aws-sdk/client-s3"] as const;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function command(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(name, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
export function consumerNode(consumer: string, source: string, args: string[] = []): string {
  // The file (rather than --eval in the checkout) anchors both ESM and CJS resolution.
  const script = join(consumer, "proof.mjs");
  writeFileSync(script, source);
  return command(process.execPath, [script, ...args], consumer);
}

export function assertConsumerIsolation(consumer: string, checkout: string, peersAbsent = true): void {
  const owned = realpathSync(consumer), repository = realpathSync(checkout);
  if (owned === repository || owned.startsWith(repository + sep) || repository.startsWith(owned + sep)) throw new Error("Consumer must be outside the repository and its ancestors");
  // With no ancestor node_modules and no module-path environment, even transitive
  // dependency resolution cannot accidentally borrow a checkout/host dependency.
  for (let parent = dirname(owned); ; parent = dirname(parent)) {
    if (lstatSync(join(parent, "node_modules"), { throwIfNoEntry: false })) throw new Error(`Ancestor node_modules can supply packages: ${parent}`);
    if (parent === dirname(parent)) break;
  }
  assertInstalledPackages(consumer, ["@openlup/core", "@openlup/platform", "zod"]);
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
const owned = realpathSync(process.cwd()), require = createRequire(import.meta.url);
const peers = ${JSON.stringify(OPTIONAL_PEERS)};
function walk(directory) {
  const segments = directory.slice(owned.length + 1).split(sep);
  const packageSegments = segments.slice(segments.lastIndexOf("node_modules") + 1);
  const isPackage = packageSegments.length === (packageSegments[0]?.startsWith("@") ? 2 : 1);
  ${peersAbsent ? 'if (isPackage && !peers.includes(packageSegments.join("/"))) assert(["@openlup/core", "@openlup/platform", "zod", "@types/node", "undici-types"].includes(packageSegments.join("/")), "Unexpected cold dependency: " + packageSegments.join("/"));' : ''}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!lstatSync(path).isSymbolicLink(), "Installed package tree contains a symlink: " + path);
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    ${peersAbsent ? 'assert(!peers.some(peer => path.endsWith(sep + "node_modules" + sep + peer) || (peer.startsWith("@") && path.endsWith(sep + "node_modules" + sep + peer.split("/").join(sep)))), "Optional peer is physically present: " + path);' : ''}
    walk(path);
  }
}
// .bin consists of npm-generated executable symlinks, not resolvable package directories.
for (const entry of readdirSync(join(owned, "node_modules"))) {
  if (entry === ".bin") continue;
  const path = join(owned, "node_modules", entry);
  assert(!lstatSync(path).isSymbolicLink(), "Installed package is a symlink: " + path);
  if (lstatSync(path).isDirectory()) walk(path);
}
${peersAbsent ? `for (const peer of peers) {
  assert(!lstatSync(join(owned, "node_modules", peer), { throwIfNoEntry: false }), "Optional peer is physically present: " + peer);
  for (const resolve of [name => require.resolve(name), name => import.meta.resolve(name)]) {
    assert.throws(() => resolve(peer), error => ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error.code), "Optional peer resolves: " + peer);
  }
}` : ''}
for (const name of ["@openlup/core", "@openlup/platform"]) {
  const metadata = JSON.parse(require("node:fs").readFileSync(join(owned, "node_modules", name, "package.json"), "utf8"));
  for (const entry of Object.keys(metadata.exports)) {
    const specifier = name + (entry === "." ? "" : entry.slice(1));
    for (const resolved of [require.resolve(specifier), fileURLToPath(import.meta.resolve(specifier))]) {
      assert(realpathSync(resolved).startsWith(owned + sep), "OpenLup resolves outside consumer: " + specifier);
    }
  }
}
`);
}

export function assertExportInventory(consumer: string): void {
  const metadata = JSON.parse(readFileSync(join(consumer, "node_modules/@openlup/platform/package.json"), "utf8"));
  const expected = [...NON_ADAPTER_ENTRIES, ...ADAPTER_ENTRIES].map(name => `./${name}`).sort();
  if (JSON.stringify(Object.keys(metadata.exports).sort()) !== JSON.stringify(expected)) throw new Error("Platform export inventory needs classification");
}


export const ACCOUNT_SUPPORT_COMPOSITION_PROOFS = ["NodeNext", "Bundler", "disabled", "unknown", "ready", "null-record", "null-member", "owner-unsupported"] as const;
/** R5a: concrete installed declarations and the same executable refusal transcript. */
export function proveAccountSupportCompositionConsumer(consumer: string, compiler: string, proof: typeof ACCOUNT_SUPPORT_COMPOSITION_PROOFS[number]): void {
  if (proof === "NodeNext" || proof === "Bundler") {
    const file = join(consumer, "account-support-composition.ts");
    writeFileSync(file, `
import { createAccountSupportBindings, createAccountSupportServices, type AccountSupportCapabilities, type AccountSupportBindingRefusal } from "@openlup/platform/account-support";
import { createAccountSupportContribution } from "@openlup/platform/composition";
declare const capabilities: AccountSupportCapabilities;
const binding = createAccountSupportBindings({ graph: "native", capabilities,
  operations: { apply: async (request: { actorId: string; idempotencyKey: string }) => ({ revision: 7, key: request.idempotencyKey }) }, commerce: { checkoutStart: null } });
const services = createAccountSupportServices({ enabled: true, ...binding, readiness: async () => ({ kind: "ready" }) });
export const contribution = createAccountSupportContribution({ version: "0.26.0", requiredSchema: { version: "full", migration: "host", objects: [] },
  accountSupport: services.operations, dependsOn: [], routes: [{ id: "apply", handle: services.operations.apply }] });
const result: { revision: number; key: string } | AccountSupportBindingRefusal = await services.operations.apply({ actorId: "actor-a", idempotencyKey: "key-b" });
if ("kind" in result) { const code: "disabled" | "schema_unknown" | "schema_unsatisfied" = result.code; void code; }
else { const revision: number = result.revision; void revision; }
export const absent = await binding.commerce("checkoutStart", { orderId: "order-c" });
// @ts-expect-error the selected owner request is preserved
services.operations.apply({ actorId: "actor-a", idempotencyKey: 99 });
// @ts-expect-error a graph is an explicit two-value selection
createAccountSupportBindings({ graph: "automatic", capabilities, operations: {} });
`);
    const mode = proof;
    const configuration = join(consumer, "account-support-composition.json");
    writeFileSync(configuration, JSON.stringify({ compilerOptions: { target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext",
      moduleResolution: mode, strict: true, skipLibCheck: false, noEmit: true, types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: [file] }));
    try { process.stdout.write(command(process.execPath, [compiler, "-p", configuration], consumer)); }
    catch (error) {
      const output = (error as { stdout?: string; stderr?: string });
      throw new Error(`R5 installed ${mode} declarations failed: ${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: error });
    }
    return;
  }
  try { consumerNode(consumer, `
import assert from "node:assert/strict";
import { createAccountSupportBindings, createAccountSupportServices } from "@openlup/platform/account-support";
import { createAccountSupportContribution } from "@openlup/platform/composition";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
const unavailable={supported:false,refusalCode:"host_binding_required"};
const proof=${JSON.stringify(proof)};
const capabilities={graph:"native",accountRead:{supported:true},customer360Read:unavailable,invoiceAccess:unavailable,commerceRecovery:unavailable,configuredPurchase:unavailable,
paymentMethodSetup:{supported:false,refusalCode:"unsupported"},operatorContact:{supported:false,refusalCode:"operator_subscription_authority_unavailable"},operatorSubscription:{supported:false,refusalCode:"operator_subscription_authority_unavailable"},
subscriptions:NATIVE_SUBSCRIPTION_CAPABILITIES,communicationGifts:{supported:false,refusalCode:"unsupported_preference"}};
let calls=0,observations=0;
const receipt={revision:7,key:"key-b"}; const ownerUnsupported={kind:"unsupported",ownerReason:"original"};
const apply=async request=>{calls++;assert.equal(request,requestBody);return receipt;};
const requestBody={actorId:"actor-a",idempotencyKey:"key-b"};
const binding=createAccountSupportBindings({graph:"native",capabilities,operations:{apply,alias:apply,unbound:null},commerce:proof==="null-record"?null:{checkoutStart:null}});
const options={...binding,readiness:async()=>{observations++;return {kind:"ready"};}};
if(proof==="disabled") {
const off=createAccountSupportServices(options);
assert.deepEqual(await off.operations.apply(requestBody),{kind:"refused",code:"disabled"});assert.equal(calls,0);assert.equal(observations,0);
} else if(proof==="unknown") {
const unknown=createAccountSupportServices({...options,enabled:true,readiness:async()=>({kind:"refused",code:"schema_unknown"})});
assert.deepEqual(await unknown.operations.apply(requestBody),{kind:"refused",code:"schema_unknown"});assert.equal(calls,0);
} else if(proof==="ready") {
const services=createAccountSupportServices({...options,enabled:true});
assert.equal(services.operations.apply,services.operations.alias);assert.equal(services.operations.unbound,null);
const composed=createAccountSupportContribution({version:"0.26.0",requiredSchema:{version:"full",migration:"host",objects:[]},accountSupport:services.operations,dependsOn:[],routes:[{id:"apply",handle:services.operations.apply}]});
assert.equal(composed.ports["@openlup/platform/account-support:apply"],services.operations.apply);
assert.equal(composed.routes["@openlup/platform/account-support:apply"],services.operations.apply);
assert.equal(await composed.routes["@openlup/platform/account-support:apply"](requestBody),receipt,"R5 selected delegate must execute");assert.equal(calls,1);assert.equal(observations,1);
assert.deepEqual(composed.contributions[0].manifest.requiredPorts,["apply","alias","unbound"]);assert.deepEqual(composed.triggers,{});assert.deepEqual(composed.contributions[0].handlers,[]);
} else if(proof==="null-record"||proof==="null-member") {
assert.deepEqual(await binding.commerce("checkoutStart",{}),{kind:"unsupported",code:"host_binding_required"});
assert.equal(calls,0);assert.equal(observations,0);
} else {
const selected=createAccountSupportBindings({graph:"native",capabilities,operations:{},commerce:{checkoutStart:async()=>ownerUnsupported}});
assert.equal(await selected.commerce("checkoutStart",{}),ownerUnsupported);
}
`); } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw new Error(`R5 installed runtime failed: ${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: error });
  }
}

/** R1 exercises the installed delegation boundary, including nulls and owner errors. */
export function proveAccountSupportConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createAccountReadFacade, CustomerAccountReadModelError, withCustomerAccountReadStage, customerAccountReadFailureDetails, createOperatorRecovery, createPostgresOperatorAuthority, operatorAuthorityCapabilities, linkThenApply } from "@openlup/platform/account-support";
import * as contracts from "@openlup/platform/account-support/contracts";
assert.deepEqual(Object.keys(contracts), []);

const account={revision:"owner-revision", getAccount(userId){assert.equal(this,account);assert.equal(userId,"principal-a");return Promise.resolve(snapshot);}};
const snapshot={profile:{privateExtension:"host-owned"},frozenTotal:2301};
const input={limit:17}, list={orders:[{orderId:"order-b",frozenTotal:2301}]}, detail={orderId:"order-c",revision:"original"};
const orders={listOrders(userId,request){assert.equal(this,orders);assert.equal(userId,"principal-b");assert.equal(request,input);return Promise.resolve(list);},getOrderDetail(userId,orderId){assert.equal(this,orders);assert.equal(userId,"principal-c");assert.equal(orderId,"order-c");return Promise.resolve(detail);}};
const read=createAccountReadFacade({account,orders});
assert.equal(await read.getAccount("principal-a"),snapshot);
assert.equal(await read.listOrders("principal-b",input),list);
assert.equal(await read.getOrderDetail("principal-c","order-c"),detail);
const cause=Error("UPSTREAM_UNAVAILABLE");
for(const fail of [false,true]) {
  const result=async()=>{if(fail)throw cause;return null;};
  const missing=createAccountReadFacade({account:{getAccount:result},orders:{listOrders:result,getOrderDetail:result}});
  for(const run of [()=>missing.getAccount("a"),()=>missing.listOrders("b",{limit:4}),()=>missing.getOrderDetail("c","o")]) {
    if(fail)await assert.rejects(run,error=>error===cause);else assert.equal(await run(),null);
  }
}
await assert.rejects(()=>withCustomerAccountReadStage("account_aggregate",async()=>{throw cause;}),error=>error instanceof CustomerAccountReadModelError && error.cause===cause);
assert.deepEqual(customerAccountReadFailureDetails(cause),{reason:"read_model_failed",stage:"unknown"});
let nativeQueries=0;
const native=createPostgresOperatorAuthority({run:async()=>{nativeQueries++;throw Error("unexpected native SQL");}}, {operatorId:"operator",now:()=>0,recoveryPath:token=>"/repair?token="+token});
assert.deepEqual(await native.linkSubjectAccount({operatorId:"operator",subjectId:"subject",expectedEmail:"a@example.invalid",authUserId:null,idempotencyKey:"link-key"}),{outcome:"refused",refusalCode:"operator_subscription_authority_unavailable"});
assert.equal(nativeQueries,0);assert.equal(operatorAuthorityCapabilities("native").email.supported,false);
const owner={outcome:"refused",refusalCode:"payment_blocked"};
const recovery=createOperatorRecovery({graph:"native",authority:{...native,applySubscriptionAction:async()=>owner}});
assert.equal(await recovery.execute({actor:{operatorId:"operator",graph:"native",role:"admin",isMachineActor:false},subject:{subjectId:"subject",subscriptionId:"subscription"},command:{action:"apply_subscription_action",subscriptionId:"subscription",subscriptionAction:"pause",expectedVersion:4,idempotencyKey:"action-key"},idempotencyKey:"action-key",expectedVersion:4,reason:null,evidence:[]}),owner);
const timeline=[];
assert.deepEqual(await linkThenApply({link:async()=>{timeline.push("link-key");return {outcome:"applied"};},onLinked:()=>{timeline.push("callback");return new Promise(()=>{});},apply:async()=>{timeline.push("action-key");return owner;}}),{outcome:"partial",link:{outcome:"applied"},subscription:owner});
assert.deepEqual(timeline,["link-key","callback","action-key"]);

`);
}

/** C10: installed self-service selection, exact owner receipt/refusal and no fallback. */
export function proveSelfServiceConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createSelfServiceCommandFacade } from "@openlup/platform/account-support";
assert.equal(typeof createSelfServiceCommandFacade,"function","self-service factory must be callable");
const receipt={status:"applied",commandFingerprint:"original",eventId:"owner-event",extra:{host:true}};
const refusal={status:"refused",reason:"subscription_command_unsupported_action",owner:true};
let result=receipt,calls=0;
const raw={async apply(command){assert.equal(this,raw);assert.equal(command,request);calls++;return result;},async preview(){throw Error("unexpected-preview");}};
const facade=createSelfServiceCommandFacade({context:{principalId:"actor",clientId:"client",graph:"native"},capabilities:{graph:"native",accountRead:{supported:false,refusalCode:"host_binding_required"},customer360Read:{supported:false,refusalCode:"host_binding_required"},invoiceAccess:{supported:false,refusalCode:"host_binding_required"},operatorSubscription:{supported:false,refusalCode:"operator_subscription_authority_unavailable"},operatorContact:{supported:false,refusalCode:"operator_subscription_authority_unavailable"},communicationGifts:{supported:false,refusalCode:"unsupported_preference"},subscriptions:{graph:"native",multiCyclePrepaid:{supported:false,refusalCode:"multi_cycle_prepaid_unsupported"},genericBundleCommands:{supported:true},commandBoundReceipts:{supported:true},preparedAttemptStore:{supported:false,refusalCode:"native_prepared_attempt_store_unsupported"},retryRecovery:"selected",stockRecovery:"unavailable",deliveryAdmission:"required",executorCount:1,defaultEnabled:false},paymentMethodSetup:{supported:false,refusalCode:"unsupported"},commerceRecovery:{supported:false,refusalCode:"host_binding_required"},configuredPurchase:{supported:false,refusalCode:"host_binding_required"}},nativeRawSubscription:raw});
const request={actorId:"actor",clientId:"client",idempotencyKey:"retained-key",subscriptionId:"subscription",action:"update_bundle",payload:{expectedTemplateVersion:3},now:"original-time"};
assert.equal(await facade.nativeRawSubscription.apply(request),receipt);
result=refusal;assert.equal(await facade.nativeRawSubscription.apply(request),refusal);
await assert.rejects(()=>facade.nativeRawSubscription.apply({...request,actorId:"foreign"}),/customer_principal_mismatch/);
await assert.rejects(()=>facade.nativeRawSubscription.preview({...request,clientId:"foreign"}),/customer_principal_mismatch/);
assert.equal(calls,2);
assert.deepEqual(await facade.nativeLegacySubscription.applyAction("actor",{subscriptionId:"s",action:"pause"}),{supported:false,refusalCode:"host_binding_required"});
assert.deepEqual(await facade.nativeSubscription.apply({actor:{actorId:"actor",clientId:"client"}}),{supported:false,refusalCode:"host_binding_required"});
assert.equal(await facade.paymentMethod.execute("actor",{}),facade.capabilities.paymentMethodSetup);assert.deepEqual(facade.capabilities.paymentMethodSetup,{supported:false,refusalCode:"unsupported"});
assert.equal("host" in facade,false);
`);
  // Inspect account-support's installed closure; declared module edges own their imports.
  const packageRoot = join(consumer, "node_modules/@openlup/platform");
  const boundary = realpathSync(join(packageRoot, "dist/account-support"));
  const graph = PLATFORM_MODULE_GRAPH["account-support"];
  const allowedEntries = new Set([...graph.values, ...graph.types].flatMap(module =>
    ["index.js", "index.d.ts"].map(entry => realpathSync(join(packageRoot, "dist", module, entry)))));
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const packages = new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {})]);
  const pending: string[] = ["./account-support", "./account-support/contracts"].flatMap(entry => Object.values(metadata.exports[entry]) as string[]);
  const visited = new Set<string>();
  while (pending.length) {
    const target = pending.pop()!;
    const path = realpathSync(resolve(packageRoot, target));
    if (!path.startsWith(boundary + sep) || !/\.(?:js|d\.ts)$/.test(path)) throw new Error("Account-support installed import escapes declared module boundaries: " + target);
    if (visited.has(path)) continue;
    visited.add(path);
    const imports = ts.preProcessFile(readFileSync(path, "utf8"), true, true);
    for (const item of [...imports.importedFiles, ...imports.referencedFiles, ...imports.typeReferenceDirectives]) {
      if (!item.fileName.startsWith(".")) {
        const name = item.fileName.split("/").slice(0, item.fileName.startsWith("@") ? 2 : 1).join("/");
        if (!packages.has(name)) throw new Error("Account-support installed import escapes declared module boundaries: " + item.fileName);
        if (item.fileName !== name) {
          try {
            const dependencyMetadata = JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"));
            if (dependencyMetadata.exports === undefined) throw new Error("Dependency has no declared subpath exports");
            createRequire(path).resolve(item.fileName);
          } catch (cause) {
            throw new Error("Account-support installed import escapes declared module boundaries: " + item.fileName, { cause });
          }
        }
        continue;
      }
      const dependency = resolve(dirname(path), item.fileName);
      // A .d.ts import ending in .js resolves to the adjacent declaration.
      let installed: string;
      try {
        installed = realpathSync(path.endsWith(".d.ts") ? dependency.replace(/\.js$/, ".d.ts") : dependency);
      } catch (cause) {
        throw new Error("Account-support installed import escapes declared module boundaries: " + item.fileName, { cause });
      }
      if (!/\.(?:js|d\.ts)$/.test(installed)) throw new Error("Account-support installed import escapes declared module boundaries: " + item.fileName);
      if (installed.startsWith(boundary + sep)) {
        pending.push(installed);
        continue;
      }
      if (!allowedEntries.has(installed)) throw new Error("Account-support installed import escapes declared module boundaries: " + item.fileName);
    }
  }
}

/** Actual installed P1 descriptor and browser import; no live provider or worker. */
export function proveInvoicingConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createInvoiceServices, createInvoiceContribution, claimInvoiceSellerRevision, readInvoiceCapabilities, createNativeUnsupportedInvoicePorts, runInvoiceAdapterConformance, createPostgresInvoiceStore, INVOICING_MIGRATIONS, runNativeInvoiceIssueJob, collectInvoiceDuties, createIndependentInvoiceDutyBinding } from "@openlup/platform/invoicing";
import * as contracts from "@openlup/platform/invoicing/contracts";
assert.deepEqual(Object.keys(contracts), []);
for (const entry of ["invoicing", "invoicing/contracts"]) assert(import.meta.resolve("@openlup/platform/" + entry).startsWith(new URL("./node_modules/", import.meta.url).href));
const supported = {supported:true}, unsupported = {supported:false,reason:"host_required"};
const capability = {version:"invoicing.capabilities.v1",providerRef:"fiscal-a",fiscalScope:{scopeRef:"host-scope",version:"v1"},policies:{identifierRef:"id-v1",taxRef:"tax-v1",roundingRef:"round-v1"},documentKinds:["host-document"],correctionKinds:["full_reversal"],numberingOwner:"provider",sellerTiming:"execution",defaultOff:true,
operations:Object.fromEntries(["issue","correction","recovery","readback","exactAbsence","remoteVoid","artifact","clearance","settlement","companyLookup"].map(key=>[key,key==="issue"?supported:key==="remoteVoid"?{supported:false,reason:"not_implemented"}:unsupported]))};
assert.equal(readInvoiceCapabilities({selection:{providerRef:"fiscal-a"},capability}).code,"disabled");
assert.equal(readInvoiceCapabilities({enabled:true,selection:null,capability}).code,"selection_required");
assert.equal(readInvoiceCapabilities({enabled:true,selection:{providerRef:"other"},capability}).code,"selection_required");
assert.equal(readInvoiceCapabilities({enabled:true,selection:{providerRef:"fiscal-a"},capability}).capability,capability);
const native=createNativeUnsupportedInvoicePorts();
let factoryRuns=0;
const composition={...native,selection:{providerRef:"fiscal-a"},capability,readiness:async()=>({kind:"ready"}),factories:{issue:()=>async()=>{factoryRuns++;return "installed-run";}}};
assert.equal((await createInvoiceServices(composition).run("issue")).code,"disabled");assert.equal(factoryRuns,0);
assert.equal(await createInvoiceServices({...composition,enabled:true}).run("issue"),"installed-run");assert.equal(factoryRuns,1);
assert.equal((await createInvoiceServices({...composition,enabled:true}).run("correction")).kind,"unsupported");
assert.deepEqual(await claimInvoiceSellerRevision(async()=>({kind:"unknown",code:"unknown"})),{kind:"unknown",code:"unknown"});
assert.deepEqual(await claimInvoiceSellerRevision(async()=>({kind:"found",seller:{name:"installed-seller"},revisionRef:"installed-revision"})),{kind:"found",seller:{name:"installed-seller"},revisionRef:"installed-revision"});
assert.equal(createInvoiceContribution({version:"test",requiredSchema:{version:"full",migration:"full",objects:[]},invoicing:{},handlers:[],schedules:[],routes:[]}).contributions[0].manifest.module.id,"invoicing");
const unsupportedResult={kind:"unsupported",code:"host_binding_required",retryable:false,effectMayHaveSucceeded:false};
assert.deepEqual(await native.host.facts.read("order-a"),unsupportedResult);
assert.deepEqual(await native.host.settlement.record({}),unsupportedResult);
assert.deepEqual(await native.store.requestLocalDocument({}),unsupportedResult);
const identity={providerRef:"fiscal-a",requestKey:"key-a",providerCreateIdentity:"create-a",factRevision:"revision-a",orderRef:"order-a",invoiceRef:"invoice-a",operation:"issue",correctionRef:null,parentProviderDocumentRef:null};
const correction={...identity,operation:"full_reversal",correctionRef:"correction-a",parentProviderDocumentRef:"external-a"};
const evidence=await runInvoiceAdapterConformance([{subjectId:"native",capability:{...capability,operations:{...Object.fromEntries(Object.keys(capability.operations).map(key=>[key,unsupported])),remoteVoid:capability.operations.remoteVoid}},provider:native.provider,readWriteCount:()=>0,sensitiveValues:[],fixtures:{
issue:[{input:{identity,facts:{},recoveryLookupRequired:false},expected:unsupportedResult}],
correction:[{input:{identity:correction,before:{},after:{totalNetMinor:0,totalTaxMinor:0,totalGrossMinor:0},reason:"reason",recoveryLookupRequired:true},expected:unsupportedResult}],
readback:[{input:identity,expected:unsupportedResult}],void:[{input:{...identity,operation:"remote_void"},expected:unsupportedResult}]}}]);
assert(evidence.subjects[0].cases.includes("read:unsupported"));
let calls=0;
const store=createPostgresInvoiceStore({async query(sql,values){calls++;assert(sql.includes("invoicing_duty_readback"));assert.deepEqual(values,["order-a"]);return {rows:[{response:{orderId:"order-a",captureFaults:[],duties:[]}}]};}});
const discoveredStore=createPostgresInvoiceStore({async query(sql,values){assert(sql.includes("NOT EXISTS (SELECT 1 FROM public.invoicing_fact_revisions"));assert.deepEqual(values,[7,"prior-a"]);assert(sql.includes("($2::uuid IS NULL OR d.id>$2::uuid)"));return {rows:[{dutyId:"owed-a",orderId:"order-a"}]};}});
assert.deepEqual(await discoveredStore.discoverDuties(7,"prior-a"),[{dutyId:"owed-a",orderId:"order-a"}]);
assert.equal((await store.installFacts({dutyId:"owed-a",facts:{}})).kind,"unsupported");assert.equal(calls,0);
assert.deepEqual(await store.readDuties("order-a"),{orderId:"order-a",captureFaults:[],duties:[]});assert.equal(calls,1);
const {readFileSync}=await import("node:fs"),{createHash}=await import("node:crypto");
assert.equal(INVOICING_MIGRATIONS.native.correctionStorage,"child_document");assert.equal(INVOICING_MIGRATIONS.managed.correctionStorage,"base_row");
for(const unit of INVOICING_MIGRATIONS.native.units)assert.equal(createHash("sha256").update(readFileSync(unit.url)).digest("hex"),unit.sha256);
assert.deepEqual(await runNativeInvoiceIssueJob({store:native.store,provider:native.provider,money:native.host.money,
  readLocalPayment:async()=>({kind:"unavailable",code:"money_unavailable"}),providerRef:"host-a"}),unsupportedResult);
let remoteReads=0,nativeFailures=0;
const recovered=await runNativeInvoiceIssueJob({providerRef:"fiscal-a",store:{
  claim:async()=>[{dutyId:"duty-a",documentId:"doc-a",requestId:"req-a",token:"token-a",generation:3,leaseUntil:"2099-01-01",identity,facts:{},action:"readback",correction:null}],
  preflight:async()=>{throw Error("unexpected payment preflight");},finish:async()=>{throw Error("unexpected acknowledgement");},
  fail:async value=>{assert.equal(value.kind,"unknown");assert.equal(value.claim.attemptCount,3);nativeFailures++;return {kind:"recorded"};}},
  provider:{...native.provider,read:async value=>{assert.deepEqual(value,identity);remoteReads++;return {kind:"unknown",identity,code:"unknown"};}},
  money:{read:async()=>{throw Error("unexpected money read");}},readLocalPayment:async()=>{throw Error("unexpected local read");}});
assert.deepEqual(recovered,{checked:1,updated:0,failures:1,ok:false});assert.equal(remoteReads,1);assert.equal(nativeFailures,1);
assert.deepEqual(await collectInvoiceDuties({store:native.store}),unsupportedResult);
let prepared=0,finished=0;
const dutyBinding=createIndependentInvoiceDutyBinding({store:{
  sweep:async()=>({collected:1,claims:[{dutyId:"duty-a",token:"token-a"}]}),
  prepareFacts:async claim=>{assert.deepEqual(claim,{dutyId:"duty-a",token:"token-a"});prepared++;return {status:"ready",documentId:"document-a",requestId:"request-a"};},
  finishFacts:async input=>{assert.equal(input.result.documentId,"document-a");finished++;return {dutyId:input.dutyId,status:"ready"};}
}});
assert.deepEqual(await dutyBinding.collect(),{kind:"collected",collected:1,prepared:1,failures:0});
assert.equal(prepared,1);assert.equal(finished,1);
console.log("invoicing consumer passed");
`);
}

/** Offline fulfillment contract and explicit-selection proof from installed bytes. */
export function proveFulfillmentConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { customerStepFromSignals, readFulfillmentCapabilities, createFulfillmentServices, FULFILLMENT_NATIVE_UNSUPPORTED } from "@openlup/platform/fulfillment";
import { createBundleComposer, createFulfillmentContribution } from "@openlup/platform/composition";
import * as contracts from "@openlup/platform/fulfillment/contracts";
assert.deepEqual(Object.keys(contracts), []);
for (const entry of ["fulfillment", "fulfillment/contracts", "composition"]) assert(import.meta.resolve("@openlup/platform/" + entry).startsWith(new URL("./node_modules/", import.meta.url).href));
let writes = 0, reads = 0;
const support = {supported:true}, no = {supported:false,reason:"not_exposed"};
const capability = {providerRef:"warehouse-a",role:"warehouse",defaultOff:true,selected:true,readiness:{ready:true},
  operations:Object.fromEntries(["dispatch","readback","exactAbsence","verifyObservation","syncStock","syncProducts","labelCreate","labelRead","labelVoid","cancel","pickupPoint","courierPickup"].map(key=>[key,key==="dispatch"?support:no])),
  authentication:"none",freshness:"not_available",ownsDeliveredNotification:false,stockAuthority:"local_atp",labelReadOwner:"none",actionPolicy:{providerSpecificAdminActions:false,genericAdminActions:false,mutationSurface:"none"}};
const options = {selection:{providerRef:"warehouse-a",carrierRef:"carrier-a",serviceRef:"service-a",deliveryKind:"courier",pickupPoint:null},capability,
  store:{async markStaleSubmissionsUncertain(){writes++;return 0;}},provider:{},readiness:async()=>({ready:true}),listCandidates:async()=>{reads++;return [];},
  keys:{request:v=>v.requestKey,mappedAttempt:key=>key,acceptance:ref=>({providerAttemptKey:ref,labelKey:ref})},config:{mode:"live",batchLimit:1}};
const off = createFulfillmentServices(options);
assert.equal((await off.runDispatch()).refusal.reason,"disabled");assert.equal(writes,0);assert.equal(reads,0);
const refused = createFulfillmentServices({...options,enabled:true,store:null});
assert.equal(await refused.runDispatch(),FULFILLMENT_NATIVE_UNSUPPORTED);
const ready = createFulfillmentServices({...options,enabled:true});
assert.equal(createBundleComposer({blob:()=>null,fulfillment:()=>ready})({}).ports.fulfillment,ready);
const contribution=createFulfillmentContribution({version:"0.21.0",requiredSchema:{version:"fixture",migration:"fixture",objects:[]},fulfillment:{dispatch:ready.runDispatch},handlers:[],schedules:[],routes:[]});
assert.equal(contribution.ports["@openlup/platform/fulfillment:dispatch"],ready.runDispatch);
assert.equal((await ready.runDispatch()).checked,0);assert.equal(writes,1);assert.equal(reads,1);

assert.equal(customerStepFromSignals(["label_created", "picking"]), "packing");
assert.deepEqual(readFulfillmentCapabilities([], null), {kind:"refused",refusal:{reason:"selection_required",phase:"selection",retryable:false}});
`);
}

/** Offline installed subscription trial with host-owned policies and refusal declarations. */
export function proveSubscriptionsConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { renewalIdentity, NATIVE_SUBSCRIPTION_CAPABILITIES, executeRenewalCycle, prepareRenewalAttempt, checkRenewalDeliveryAdmission, propagateRenewalFailure } from "@openlup/platform/subscriptions";
import * as contracts from "@openlup/platform/subscriptions/contracts";
assert.deepEqual(Object.keys(contracts), []);
assert.equal(NATIVE_SUBSCRIPTION_CAPABILITIES.defaultEnabled, false);
assert.equal(NATIVE_SUBSCRIPTION_CAPABILITIES.executorCount, 1);
for (const [capability, refusalCode] of [
  ["multiCyclePrepaid", "multi_cycle_prepaid_unsupported"],
  ["preparedAttemptStore", "native_prepared_attempt_store_unsupported"],
]) assert.deepEqual(NATIVE_SUBSCRIPTION_CAPABILITIES[capability], {supported:false,refusalCode});
for (const capability of ["genericBundleCommands", "commandBoundReceipts"]) assert.deepEqual(NATIVE_SUBSCRIPTION_CAPABILITIES[capability], {supported:true});
const input = {subscriptionId:"subscription",scheduledAt:"2026-10-21T14:00:00+02:00",scheduledInstant:1792584000000};
const identity = {cycleIdempotencyKey:"original:cycle",executionIdempotencyKey:"original:execute",externalIdempotencyKey:"original:external",requestFingerprint:"original:fingerprint"};
assert.equal(renewalIdentity(input, value => { assert.equal(value,input); return identity; }), identity);
for (const mechanism of [executeRenewalCycle, prepareRenewalAttempt, propagateRenewalFailure]) assert.equal(typeof mechanism,"function");
const allowed={allowed:true,state:"clear",reason:"synthetic"};
assert.equal((await checkRenewalDeliveryAdmission({admitDeliveryAlignment:async value=>{assert.equal(value.scheduledAt,input.scheduledAt);return allowed;}},{subscriptionId:input.subscriptionId,nextCycleAt:input.scheduledAt},"now")).admitted,allowed);
console.log("subscriptions consumer passed");
`);
}

/** Offline installed payments trial with host-owned persistence and refusal policy. */
export function provePaymentsConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { executePreparedAttemptMechanism, createPaymentServices } from "@openlup/platform/payments";
import { createBundleComposer } from "@openlup/platform/composition";
import * as contracts from "@openlup/platform/payments/contracts";
assert.deepEqual(Object.keys(contracts), []);
let opened = 0, closed = 0;
assert.equal(createPaymentServices({schema:{truth:"unsupported"},openTruth:async()=>{opened++;throw Error("unexpected");}}),null);
const services = createPaymentServices({schema:{truth:"supported"},openTruth:async()=>{
 opened++; return {port:{readEvent:async()=>null},close:async()=>{closed++;}};
}});
assert.equal(opened,0);
assert.equal(await services.run(port=>port.readEvent("event-a")),null);
assert.equal(opened,1); assert.equal(closed,1);
assert.equal(createBundleComposer({blob:()=>null})({}).ports.payments,undefined);
assert.equal(createBundleComposer({blob:()=>null,payments:()=>services})({}).ports.payments,services);
assert.equal(opened,1);


const trace = [];
const stored = {paymentAttemptId:"attempt-a",status:"created",replayed:false,providerAttemptId:null,providerSessionId:null,nextActionKind:null};
const execution = {provider:"provider-a",providerAttemptId:"remote-a",providerSessionId:null,attemptStatus:"processing",nextActionKind:null,requestPayload:{},responsePayload:{}};
const input = {provider:"provider-a",paymentIntentId:"intent-a",providerIdempotencyKey:"host-key",providerRequestFingerprint:"host-fingerprint",providerFlow:"one_time",
 prepareIdempotencyKey:"prepare-a",finalizeIdempotencyKey:"finalize-a",prepareRequestPayload:{},
 executionInput:{idempotencyKey:"execute-a",providerIdempotencyKey:"host-key",providerRequestFingerprint:"host-fingerprint",paymentIntentId:"intent-a",amountMinor:100,currency:"XXX",mode:"one_time"},
 paymentPort:{prepareProviderAttempt:async()=>{trace.push("prepare");return stored;},finalizeProviderAttempt:async(value)=>{trace.push("finalize");assert.equal(value.providerIdempotencyKey,"host-key");return {...stored,status:"processing"};}},
 executionPort:{validateInput:()=>trace.push("validate"),execute:async(value)=>{trace.push("execute");assert.equal(value,input.executionInput);return execution;}}};
const policy = {replayError:()=>Error("in-flight"),isTrustedNoCharge:()=>false,logRetry:()=>{},exhaustedError:e=>e,executionError:e=>e,finalizationError:e=>e};
assert.deepEqual(await executePreparedAttemptMechanism(input,policy),{execution,attempt:{paymentAttemptId:"attempt-a",status:"processing"}});
assert.deepEqual(trace,["validate","prepare","execute","finalize"]);
trace.length=0; stored.replayed=true;
await assert.rejects(()=>executePreparedAttemptMechanism(input,policy),/in-flight/);
assert.deepEqual(trace,["validate","prepare"]);
trace.length=0; input.executionPort.validateInput=()=>{throw Error("invalid-input");};
await assert.rejects(()=>executePreparedAttemptMechanism(input,policy),/invalid-input/);
assert.deepEqual(trace,[]);
`);
}

/** Installed marketing runtime, type-only entry, identity and deep-import refusal. */
export function proveMarketingConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import * as marketing from "@openlup/platform/marketing";
import * as contracts from "@openlup/platform/marketing/contracts";
import * as core from "@openlup/core/marketing/research";
assert.deepEqual(marketing.acquisitionCaseListRequestSchema.parse({ view: marketing.ACQUISITION_CASE_VIEW }), { view: marketing.ACQUISITION_CASE_VIEW, limit: 25 });
assert.equal(marketing.acquisitionCaseListRequestSchema.safeParse({ view: marketing.ACQUISITION_CASE_VIEW, extra: true }).success, false);
assert.deepEqual(marketing.prelaunchAcquisitionListRequestSchema.parse({ view: marketing.PRELAUNCH_ACQUISITION_VIEW, limit: "2" }), { view: marketing.PRELAUNCH_ACQUISITION_VIEW, limit: 2 });
assert.equal(marketing.prelaunchAcquisitionDetailRequestSchema.safeParse({ sourceRef: "case:one" }).success, false);
assert.equal("MARKETING_PRELAUNCH_CONTRACT_VERSION" in marketing, false);
assert.deepEqual(Object.keys(contracts), []);
assert.equal(marketing.createNoopAnalytics().trackPageView("/"), undefined);
assert.deepEqual(marketing.createAnalyticsDataLayer().emitAnalyticsEvent("page_view", { page_path: "/" }), { deployment: false, optional: false });
const routes = marketing.createAnalyticsRoutePolicy({ publicPaths: ["/entry"], redirectSources: [], privatePathPrefixes: [], privateAuthPaths: [], capabilityPathPrefixes: [] });
assert.equal(routes.sanitizeDeploymentAnalyticsUrl("/entry?secret=one", "https://host.example"), "https://host.example/entry");
assert.equal(marketing.projectPaidPurchase({ status: "pending" }), null);
assert.equal(marketing.selectMarketingHistoricalConsentTime({ command: { consentedAt: null, listId: null }, state: { consent: "unknown", suppressions: [] }, now: new Date(NaN) }).reason, "consent_time_invalid");
const origin="https://shop.example";
const facts={name:"Example Store",legalName:"Example Company",url:origin,logo:{url:origin+"/logo.png",contentUrl:origin+"/logo.png",width:160,height:60},email:"contact@example.invalid",vatID:"VAT-1",taxID:"TAX-1",areaServed:"Region-A",sameAs:[],contactPoint:{email:"contact@example.invalid",contactType:"support",availableLanguage:["alpha"]},address:{streetAddress:"Example Lane 1",addressLocality:"Example Town",postalCode:"00000",addressRegion:"Region-A",addressCountry:"Territory-A"}};
const node=marketing.organizationLd(origin,"Organization",facts);
assert.equal(node["@id"],origin+"/#organization");
assert.equal(marketing.jsonLdGraph(node,node)["@graph"].length,1);
const hostile={name:"</script><script>probe</script>\\u2028\\u2029"};
const serialized=marketing.serializeJsonLd(hostile);
assert(!serialized.includes("<"));
assert.deepEqual(JSON.parse(serialized),hostile);
const head=marketing.buildHeadDescriptor({origin,route:{id:"home",locale:"alpha",canonicalPath:"/"},routes:[],xDefaultLocale:"alpha",htmlLang:"alpha",title:"Example",description:"Example content",siteName:facts.name,ogImage:origin+"/image.png",ogImageWidth:1200,ogImageHeight:630,twitterHandle:"@example",ogLocale:"alpha",twitterImage:origin+"/card.png",jsonLd:hostile});
assert.deepEqual(head.tags[1],{kind:"link",rel:"canonical",href:origin+"/"});
assert.deepEqual(JSON.parse(head.jsonLd)["@graph"],[hostile]);
for (const [name, value] of Object.entries(core)) assert.equal(marketing[name], value);
for (const name of ["acquisitionCaseSubmitRequestSchema", "acquisitionCaseSubmitResponseSchema", "acquisitionCaseTransitionRequestSchema", "acquisitionCaseTransitionResponseSchema"]) assert.equal(name in marketing, false);
await assert.rejects(import("@openlup/platform/dist/marketing/acquisitionCaseSchemas.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
`);
}

/** Installed server factories preserve historical reads and bounded port refusals without pg. */
export function proveMarketingServerConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createAcquisitionCaseHandlers, createAcquisitionCaseActiveCountDirectHandler, createAcquisitionSurveySubmitDirectHandler, createAnalyticsContextHandler } from "@openlup/platform/marketing/server";
import { createBffResponder } from "@openlup/platform/bff";
const calls = [];
const port = { activeCount: async scope => { calls.push(scope); return { ok: true, value: 4 }; } };
const handlers = createAcquisitionCaseHandlers(port);
const respond = createBffResponder();
let status, body;
const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; return this; } };
await createAcquisitionCaseActiveCountDirectHandler({ respond, isDirect: () => true, authorize: async () => { throw Error("public count must not authorize"); }, resolveBinding: async () => ({ handlers }) })({ method: "GET" }, res);
assert.equal(status, 200);
assert.deepEqual(body, { ok: true, data: { activeTesterCount: 4 } });
assert.deepEqual(calls, ["public_tester_application"]);
await createAcquisitionSurveySubmitDirectHandler({ respond, authorize: async () => null, resolveBinding: async () => ({ submitSurvey: async () => ({ ok: false, error: { kind: "conflict" } }) }) })({ method: "POST", headers: { "idempotency-key": "survey-key-0001" }, body: { view: "acquisition_survey_v1", caseReference: "acquisition-case:11111111-1111-4111-8111-111111111111", surveyType: "consumer", responseData: { answer: "synthetic" } } }, res);
assert.equal(status, 409);
assert.deepEqual(body, { ok: false, error: { code: "CONFLICT", message: "Acquisition evidence request conflicts with prior state" } });
await createAnalyticsContextHandler({ respond, isEnabled: () => true,
  resolveStore: () => { throw Error("invalid context must not read persistence"); },
  readAccessToken: () => null, resolveTrustedSubject: async () => null,
  capabilityCrypto: { mintToken: () => { throw Error("invalid context must not mint"); }, hashToken: token => token },
  cookieName: "__Host-context", clientIdField: "browserRef",
})({ method: "POST", headers: { host: "shop.example", origin: "https://shop.example" }, body: { granted: true } }, res);
assert.equal(status, 400);
assert.deepEqual(body, { ok: false, error: { code: "BAD_REQUEST", message: "Invalid analytics context" } });
await assert.rejects(import("@openlup/platform/marketing/server/internal"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const { createMarketingPrivacyContributor, createMarketingPrivacyBindings } = await import("@openlup/platform/marketing/server");
assert.equal(typeof createMarketingPrivacyContributor, "function");
assert.equal(typeof createMarketingPrivacyBindings, "function");
const disabledPrivacy = createMarketingPrivacyBindings({ acquisition: null, remoteErasure: null,
  randomId: () => { throw Error("disabled privacy must not create a case"); } });
assert.equal(disabledPrivacy.contributor, null);
assert.deepEqual(disabledPrivacy.callables, { exportPersonalData: null, assessErasure: null, eraseOrRetain: null });
assert.equal(disabledPrivacy.issues.length, 2);
`);
}

/** Installed type witness for neutral analytics facts and host step literals. */
export function compileMarketingAnalyticsConsumer(consumer: string, compiler: string): void {
  const file = join(consumer, "marketing-analytics.ts");
  writeFileSync(file, [
    'import { createAnalyticsDataLayer, projectPaidPurchase, selectMarketingHistoricalConsentTime } from "@openlup/platform/marketing";',
    'import type { AnalyticsEventMap, PurchaseOrder, MarketingHistoricalConsentCommand } from "@openlup/platform/marketing/contracts";',
    'const analytics = createAnalyticsDataLayer<"choose" | "confirm">();',
    'analytics.pushAnalyticsEvent("configurator_step_view", { step_number: 1, step_name: "choose" });',
    '// @ts-expect-error the host literal union stays closed',
    'analytics.pushAnalyticsEvent("configurator_step_view", { step_number: 1, step_name: "other" });',
    'declare const order: PurchaseOrder;',
    'export const purchase: AnalyticsEventMap["purchase"] | null = projectPaidPurchase(order);',
    'declare const command: MarketingHistoricalConsentCommand;',
    'export const consent = selectMarketingHistoricalConsentTime({ command, state: { consent: "unknown", suppressions: [] }, now: new Date() });',
  ].join("\n"));
  for (const mode of ["NodeNext", "Bundler"]) {
    const configuration = join(consumer, "marketing-analytics-tsconfig.json");
    writeFileSync(configuration, JSON.stringify({ compilerOptions: {
      target: "ES2020", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"],
      typeRoots: [join(consumer, "node_modules/@types")],
    }, files: [file] }));
    process.stdout.write(command(process.execPath, [compiler, "-p", configuration], consumer));
  }
}

/** M11 K1: installed neutral contracts, a successful projection and a strict refusal. */
export function proveCommerceConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { z } from "zod";
import * as commerce from "@openlup/platform/commerce";
import { createCommerceQuotePrimitives, acquisitionCapabilitySchema, acquisitionTermsExpectationSchema } from "@openlup/platform/pricing/browser";
const primitives = createCommerceQuotePrimitives(z.literal("XXX"));
assert.deepEqual(primitives.commerceMoneySchema.parse({ amountMinor: 1, currency: "XXX" }), { amountMinor: 1, currency: "XXX" });
assert(!primitives.commerceMoneySchema.safeParse({ amountMinor: 1, currency: "invalid" }).success);
assert(acquisitionCapabilitySchema.safeParse("subscription-acquisition.v1").success);
assert(!acquisitionCapabilitySchema.safeParse("unsupported").success);
assert(acquisitionTermsExpectationSchema.safeParse({ revision: "example", delivery2DiscountBps: 10000 }).success);
assert(!acquisitionTermsExpectationSchema.safeParse({ revision: "example", delivery2DiscountBps: 10001 }).success);
await assert.rejects(import("@openlup/platform/pricing/browser/internal"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
import * as contracts from "@openlup/platform/commerce/contracts";
import * as server from "@openlup/platform/commerce/server";
assert.equal(typeof server.createAdminCommerceOrdersListHandler, "function");
assert.equal("createAdminCommerceOrdersListHandler" in commerce, false);
assert.equal(typeof server.tryCompensate, "function");
assert.equal("tryCompensate" in commerce, false);
await assert.rejects(import("@openlup/platform/commerce/server/internal"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
assert.deepEqual(Object.keys(contracts), []);
const items = commerce.offerAvailabilityRequestItems([{sku:"ITEM-A",slug:"item-a",variantId:"variant-a"}],"subscription");
assert.deepEqual(items,[{sku:"ITEM-A",productSlug:"item-a",variantId:"variant-a",requestedQuantity:1,checkoutMode:"subscription"}]);
assert.equal(commerce.DEFAULT_LOW_STOCK_THRESHOLD,20);
assert.equal(commerce.statusForSellableNow(null),"unknown");
assert.equal(commerce.statusForSellableNow(0),"out_of_stock");
assert.equal(commerce.reasonCodeFor("low_stock"),"low_stock");
assert.equal(commerce.defaultOfferAvailability(items[0]).reasonCode,"static_available");
const availability=commerce.deriveOfferAvailability({...items[0],sellableNow:4,source:"synthetic"});
assert.equal(availability.status,"low_stock");
assert.equal(commerce.availabilityBySku([availability]).get("ITEM-A"),availability);
const schemas = commerce.createOfferAvailabilitySchemas(z.string().min(1), z.string().min(1));
assert(schemas.commerceOfferAvailabilityRequestItemSchema.safeParse(items[0]).success);
assert(!schemas.commerceOfferAvailabilityRequestItemSchema.safeParse({...items[0],requestedQuantity:0}).success);
assert.equal(commerce.commerceOfferVersionSchema.parse("offer-a.v2"),"offer-a.v2");
assert(!commerce.commerceOfferVersionSchema.safeParse("INVALID OFFER").success);
assert.equal(commerce.commerceMinimumUnits({minimumUnits:2},14),2);
assert.equal(commerce.commerceMinimumUnits({},14),14);
assert.deepEqual(commerce.commerceOfferEvidenceSchema.parse({tier:"a",units:2}),{tier:"a",units:2});
assert(!commerce.commerceOfferEvidenceSchema.safeParse({invalid_key:"a"}).success);
assert.equal(commerce.CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS,2700);
const commandSchemas=commerce.createCheckoutCommandSchemas({sku:z.string(),paymentIntentStatus:z.literal("created"),paymentAttemptStatus:z.literal("created")});
assert(commandSchemas.checkoutCommandV1Schema.safeParse({version:commerce.CHECKOUT_COMMAND_V1,idempotencyKey:"command-a",mode:"one_time",lines:[{sku:"ITEM-A",quantity:1}],customer:{firstName:"Buyer",lastName:"Example",email:"buyer@example.test",phone:"123456789"},shippingAddress:{street:"Example 12",postalCode:"00000",city:"Example",country:"AA"},currency:"XTS"}).success);

const scopeSchema=z.literal("all_orders"), methodSchema=z.literal("saved");
const defaults=commerce.createCustomerDefaultsSnapshotSchemas({paymentPreferenceScopeSchema:scopeSchema,paymentMethodKindSchema:methodSchema});
assert(!defaults.commerceCustomerDefaultsSnapshotSchema.safeParse({version:commerce.CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,clientId:"invalid"}).success);
assert.equal(commerce.resolveRecoveryDestination({state:"terminal_expired",source:"checkout_expired"}),"fresh_checkout");
assert.throws(()=>{throw new commerce.CommerceOrderDraftUnsupportedMoneyError("zero_payable_unsupported");},
 error=>error instanceof commerce.CommerceOrderDraftUnsupportedMoneyError && error.reason==="zero_payable_unsupported");
`);
}

/** M11 K2: exercise installed Node-only checkout exports without optional peers. */
export function proveCommerceServerConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import * as server from "@openlup/platform/commerce/server";
for (const name of ["tryCompensate", "createCommerceRuntimeService", "createPaidOrderOrchestration", "createCommerceCheckoutHandler", "createCheckoutQuoteGuard", "createStarterOfferGuard", "resolveCheckoutOffer"]) assert.equal(typeof server[name], "function");
for (const name of ["createOrderDraftRpcPayload", "createCommerceOrderDraftRpcPort", "createManagedCommerceRuntimeOrderPort", "createConfiguratorIntentPersistenceRpcPort", "createCommerceCheckoutResumeQueryPort", "createManagedReservationSweepPort", "createCheckoutCompensationRpcAdapter", "createExpiredCheckoutRecoveryPolicy", "quotesMatchForRecovery", "hashCheckoutRecoveryToken", "generateCheckoutRecoveryToken"]) assert.equal(typeof server[name], "function");
const stockQueries=[];
const physical=server.createOfferAvailabilityPort({from(table){return {select(){return {async in(column,values){stockQueries.push([table,column,values]);return {data:[],error:null};}};}};}},{isStockProvider:kind=>kind==="stock-source"});
assert.deepEqual(await physical.getAvailability({items:[]}),[]);
assert.deepEqual(stockQueries,[]);
assert.equal((await physical.getAvailability({items:[{sku:"ITEM-A",productSlug:"item-a",variantId:"variant-a",requestedQuantity:1,checkoutMode:"one_time"}]}))[0].status,"unknown");
assert.deepEqual(stockQueries.map(([table])=>table),["fulfillment_provider_stock_current","inventory_balances","inventory_reservations"]);
assert.equal(server.classifyCheckoutRecoveryTokenState("expired"), "expired_policy");
assert.equal(server.classifyCheckoutRecoveryTokenState("active"), "continuation");
assert.equal(server.classifyCheckoutRecoveryTokenState("unknown"), "refused");
assert.equal(server.hashCheckoutRecoveryToken("token"), "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0");
const sweepCalls = [];
const sweep = server.createManagedReservationSweepPort({ async rpc(name, args) { sweepCalls.push([name, args]); return { data: { sweep: { skippedSubscription: 1 } }, error: null }; } });
assert.equal((await sweep.sweep({ now: "synthetic-instant", limit: 3 })).skippedSubscription, 1);
assert.deepEqual(sweepCalls, [["commerce_sweep_expired_reservation_holds", { p_idempotency_prefix: "commerce-reservation-sweep-run", p_now: "synthetic-instant", p_limit: 3 }]]);
const codec = server.createCheckoutPaymentContinuationCodec("synthetic-root-at-least-thirty-two-bytes", { cookieName: "__Host-example_continuation", executionRails: ["embedded", "redirect"] });
assert(codec);
const claims = { journeyId: "checkout:11111111-1111-4111-8111-111111111111", orderId: "22222222-2222-4222-8222-222222222222", clientId: "33333333-3333-4333-8333-333333333333", paymentIntentId: "44444444-4444-4444-8444-444444444444", paymentAttemptId: "55555555-5555-4555-8555-555555555555", executionRail: "embedded" };
const cookie = codec.issue(claims);
assert.deepEqual(codec.verifyCookieHeader(cookie.setCookie.split(";")[0]), cookie.claims);
await assert.rejects(server.resolveCheckoutOffer(undefined, { offerVersion: "offer-a" }, "one_time"), error => error instanceof server.CheckoutOfferRefusedError && error.reason === "offer_version_unsupported");
const calls = [];
await server.tryCompensate({
  async releaseOrderReservations(input) { calls.push(["release", input]); return { releasedCount: 1 }; },
  async cancelUnstartedPromotionOrder(input) { calls.push(["promotion", input]); return { cancelled: false }; },
  async cancelAbandonedOrder(input) { calls.push(["abandon", input]); return { cancelled: true }; },
}, "intent-key", "order-1");
assert.deepEqual(calls, [
  ["release", { idempotencyKey: "intent-key:checkout-compensation", orderId: "order-1", reason: "checkout_orchestration_failed" }],
  ["promotion", { idempotencyKey: "intent-key", orderId: "order-1", reason: "checkout_orchestration_failed_before_runtime" }],
  ["abandon", { idempotencyKey: "intent-key", orderId: "order-1", reason: "checkout_orchestration_failed_before_provider_dispatch" }],
]);
`);
}

/** Useful operations proof from the installed artifact; no provider or optional SDK is loaded. */
export function proveOperationsConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import * as operations from "@openlup/platform/operations";
import * as contracts from "@openlup/platform/operations/contracts";
import * as server from "@openlup/platform/operations/server";
assert.deepEqual(Object.keys(contracts), []);
assert.equal(operations.buildAlertsOverview([], null, new Date("2026-10-26T12:00:00Z")).health, "unknown");
const calls=[];
const clients=operations.createOperationsClients(async (path,schema,options)=>{
  calls.push({path,options});
  return schema.parse(path.endsWith("/update")?{key:options.body.key,saved:true}:{settings:{"jobs.enabled":true},adminUsers:[]});
});
assert.deepEqual(await clients.getAdminSettings("synthetic-token"),{settings:{"jobs.enabled":true},adminUsers:[]});
assert.deepEqual(await clients.updateAdminSetting("synthetic-token",{key:"jobs.enabled",value:false}),{key:"jobs.enabled",saved:true});
assert.equal(calls[0].options.headers.get("authorization"),"Bearer synthetic-token");
assert.equal(calls[1].options.method,"POST");
const receipts=new Map();let writes=0;
const executor={async query(sql,values){
  if(!sql.includes("platform_control_set_control"))return {rows:[]};
  const [operator,key,fingerprint]=values;
  assert.equal(operator,"operator");assert.match(fingerprint,/^[a-f0-9]{64}$/);
  const prior=receipts.get(key);
  if(prior){if(prior.fingerprint!==fingerprint)throw Object.assign(Error("private database details"),{code:"23505"});return {rows:[{...prior.row,replayed:true}]};}
  writes++;const row={action:"set-control",replayed:false,revision:writes,recorded_at:"2026-10-26T12:00:00Z"};receipts.set(key,{fingerprint,row});return {rows:[row]};
}};
function response(){return {statusCode:0,payload:null,headers:{},setHeader(name,value){this.headers[name]=value;},status(code){this.statusCode=code;return this;},json(value){this.payload=value;return this;},end(){return this;}};}
const command={action:"set-control",idempotencyKey:"control-key",controlKey:"jobs.enabled",enabled:true};
const handler=server.createPlatformControlPlaneHandler({port:server.createPlatformControlPlanePort(executor,"operator"),authorizeAdmin:async()=>true,responseRequestId:()=>"request-operations"});
let res=response();await handler({method:"POST",body:command},res);assert.equal(res.statusCode,200);assert.equal(res.payload.data.replayed,false);assert.equal(res.headers["x-request-id"],"request-operations");
res=response();await handler({method:"POST",body:command},res);assert.equal(res.payload.data.replayed,true);assert.equal(writes,1);
res=response();await handler({method:"POST",body:{...command,enabled:false}},res);assert.equal(res.statusCode,409);assert(!JSON.stringify(res.payload).includes("private database details"));assert.equal(writes,1);
res=response();await handler({method:"POST",body:{...command,enabled:"wrong"}},res);assert.equal(res.statusCode,400);assert.equal(writes,1);
res=response();await server.createPlatformControlPlaneHandler({port:server.createPlatformControlPlanePort(executor,"operator"),authorizeAdmin:async()=>false})({method:"POST",body:command},res);assert.equal(res.statusCode,401);assert.equal(writes,1);
res=response();await server.createPlatformControlPlaneHandler({port:{readControlPlane:async()=>({controls:"invalid"}),mutateControlPlane:async()=>null},authorizeAdmin:async()=>true})({method:"GET"},res);assert.equal(res.statusCode,502);
let heartbeats=0;
const port={readControlPlane:async()=>({controls:[],alerts:[],jobs:[{jobName:"refresh-example",enabled:true,lastStatus:"failed"}]}),mutateControlPlane:async()=>{heartbeats++;return {replayed:false};}};
const dry=await server.runControlPlaneWatchdogTick(port,new Date("2026-10-26T12:00:00Z"),true);assert.equal(dry.body.health,"degraded");assert.equal(heartbeats,0);
const tick=await server.runControlPlaneWatchdogTick(port,new Date("2026-10-26T12:00:00Z"),false);assert.equal(tick.body.heartbeatRecorded,true);assert.equal(heartbeats,1);
await assert.rejects(import("@openlup/platform/operations/server/internal"),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
`);
}

/** Installed server entry: actual private bytes, replay and injected-row refusals without peers. */
export function provePortabilityConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import * as portability from "@openlup/platform/portability";
assert.deepEqual(Object.keys(portability).sort(),["ObjectTransferError","PostgresTransferError","captureCompatiblePostgresRows","copyTransferObjects","createFilesystemTransferObjects","restoreCompatiblePostgresRows"].sort());
const {copyTransferObjects,createFilesystemTransferObjects,captureCompatiblePostgresRows,restoreCompatiblePostgresRows}=portability;
const root=await mkdtemp(join(await realpath(process.cwd()),"portability-"));
try {
 const bytes=Buffer.from("private installed object"),object={key:"nested/private",version:"v1",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),metadata:{contentType:"application/octet-stream"},access:"source-private"};
 const source=await createFilesystemTransferObjects({root:join(root,"source"),maximumObjectBytes:1024,access:"source-private"});
 const targetOptions={root:join(root,"target"),maximumObjectBytes:1024,access:"target-private"};
 let destination=await createFilesystemTransferObjects(targetOptions);
 await source.createIfAbsent(object,bytes);
 const input={inventory:{sourceId:"installed-source",snapshot:{kind:"quiesced",id:"snapshot-1"},objects:[object]},source,destination,accessMapping:{"source-private":"target-private"},maximumObjectBytes:1024,maximumTotalBytes:1024};
 await assert.rejects(copyTransferObjects({...input,checkpoint:async()=>{throw Error("checkpoint interrupted");}}),/checkpoint interrupted/,"installed byte copy must reach verified checkpoint");
 destination=await createFilesystemTransferObjects(targetOptions);
 assert.deepEqual(await copyTransferObjects({...input,destination}),{copied:0,replayed:1,verifiedKeys:[object.key]});
 const read=await destination.read(object.key,"v1"),chunks=[];for await(const chunk of read.body)chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks),bytes);
 assert.deepEqual(read.object,{...object,access:"target-private",lineage:{sourceId:"installed-source",snapshotId:"snapshot-1",sourceVersion:"v1"}});
 await assert.rejects(destination.read("absent"),{code:"absent"});
 await assert.rejects(destination.read(object.key,"v2"),{code:"version_conflict"});
 await assert.rejects(destination.createIfAbsent({...object,key:"public",access:"public"},bytes),{code:"denied"});
 const raw='{"id":"11111111-1111-4111-8111-111111111111","payload":{"large":9007199254740993}}';
 const columns=[{name:"id",type:"uuid",key:true,generated:"",identity:""},{name:"payload",type:"jsonb",key:false,generated:"",identity:""}];
 let stored=false,trigger=false,conflict=false;
 const db={async query(sql,values){
  if(sql.includes("transaction_read_only"))return {rows:[{readonly:"on",isolation:"repeatable read"}]};
  if(sql.includes("session_replication_role"))return {rows:[{mode:"origin"}]};
  if(sql.includes("pg_catalog.pg_attribute"))return {rows:columns};
  if(sql.includes("pg_catalog.pg_trigger"))return {rows:trigger?[{}]:[]};
  if(sql.startsWith("SELECT to_jsonb(t)::text"))return {rows:[{value:raw}]};
  if(sql.startsWith("INSERT")){assert.equal(values[0],raw);const prior=stored;stored=true;return {rows:prior?[]:[{inserted:1}]};}
  if(sql.startsWith("SELECT to_jsonb(t) ="))return {rows:[{identical:!conflict}]};
  assert(sql.startsWith("SET LOCAL")||sql.startsWith("LOCK TABLE"));return {rows:[]};
 }};
 const packet=await captureCompatiblePostgresRows({source:{withSnapshot:work=>work(db)},sourceId:"injected-source",catalogueId:"injected-profile",tables:["outbox_events"],maximumRows:10,maximumBytes:1024});
 assert.equal(packet.tables[0].rows[0],raw);
 const restore={target:{withTransaction:work=>work(db)},catalogueId:"injected-profile",packet};
 assert.equal((await restoreCompatiblePostgresRows(restore)).inserted,1);
 assert.equal((await restoreCompatiblePostgresRows(restore)).replayed,1);
 trigger=true;await assert.rejects(restoreCompatiblePostgresRows(restore),{code:"insert_trigger_requires_owner"});
 trigger=false;conflict=true;await assert.rejects(restoreCompatiblePostgresRows(restore),{code:"target_conflict"});
} finally {await rm(root,{recursive:true,force:true});}
`);
}

/** Installed lifecycle operations retain file ownership and finite legacy-role refusals. */
export function proveLifecycleConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {promises as fs} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import * as lifecycle from "@openlup/platform/lifecycle";
assert.deepEqual(Object.keys(lifecycle).sort(),["AppUpgradeConflictError","applyAppUpgrade","inspectLegacyPostgresInstallRoles","planAppUpgrade"]);
const roleRequest={migrationLogin:"migration",runtimeLogin:"migration",roleMode:"installer-managed"};
const role={name:"migration",login:true,superuser:true,inherit:false,createRole:false,createDatabase:false,replication:false,bypassRls:false};
const observed={database:"synthetic",currentUser:"migration",sessionUser:"migration",roles:[role],memberships:[]};
let queries=0;
const query=async(sql,values)=>{queries++;assert.ok(sql.startsWith("SELECT "));assert.deepEqual(values,[["anon","authenticated","platform_acquisition_owner","platform_acquisition_runtime","migration"]]);return {rows:[observed]};};
const qualified=await lifecycle.inspectLegacyPostgresInstallRoles({query},roleRequest);
assert.equal(queries,1);assert.equal(qualified.scope,"legacy-fresh-bootstrap-role-prerequisites");
assert.equal(qualified.rolePrerequisitesMet,true);assert.deepEqual(qualified.blockers,[]);
const refused=await lifecycle.inspectLegacyPostgresInstallRoles({query:async()=>({rows:[{...observed,roles:[{...role,superuser:false}]}]})},roleRequest);
assert.equal(refused.rolePrerequisitesMet,false,"installed role observation must retain superuser refusal");
assert.deepEqual(refused.blockers,[{code:"legacy_bootstrap_requires_superuser"}]);
await assert.rejects(lifecycle.inspectLegacyPostgresInstallRoles({query:async()=>{throw new Error("synthetic private driver detail");}},roleRequest),{message:"postgres_install_observation_failed"});
const root=await fs.mkdtemp(join(await fs.realpath(process.cwd()),"app-upgrade-"));
try {
 const from={version:"example-N-1",schema:{min:1,max:2},files:{"generated/entry.mjs":"export const revision = 1;\\n","generated/second.txt":"old\\n","theme.css":"original\\n"}};
 const to={version:"example-N",schema:{min:1,max:2},files:{"generated/entry.mjs":"export const revision = 2;\\n","generated/second.txt":"new\\n","theme.css":"original\\n"}};
 await fs.mkdir(join(root,"generated"));
 for(const [path,bytes] of Object.entries(from.files))await fs.writeFile(join(root,path),bytes);
 await fs.writeFile(join(root,"brand.txt"),"adopter brand");
 await fs.writeFile(join(root,"theme.css"),"adopter theme");
 const input={root,from,to,schemaVersion:2};
 assert.deepEqual((await lifecycle.planAppUpgrade(input)).conflicts,[]);
 assert.equal(await fs.readFile(join(root,"generated/entry.mjs"),"utf8"),from.files["generated/entry.mjs"],"planning must not write");
 await fs.writeFile(join(root,"generated/entry.mjs"),"local managed edit");
 await assert.rejects(lifecycle.applyAppUpgrade(input),lifecycle.AppUpgradeConflictError);
 assert.equal(await fs.readFile(join(root,"generated/entry.mjs"),"utf8"),"local managed edit");
 assert.equal(await fs.readFile(join(root,"generated/second.txt"),"utf8"),from.files["generated/second.txt"],"conflict must precede other writes");
 await fs.writeFile(join(root,"generated/entry.mjs"),from.files["generated/entry.mjs"]);
 const child=\`import {promises as fs} from "node:fs";import {applyAppUpgrade} from "@openlup/platform/lifecycle";const rename=fs.rename.bind(fs);fs.rename=async(...args)=>{await rename(...args);process.kill(process.pid,"SIGKILL");await new Promise(()=>{});};await applyAppUpgrade(JSON.parse(process.argv[1]));\`;
 assert.throws(()=>execFileSync(process.execPath,["--input-type=module","-e",child,JSON.stringify(input)],{cwd:process.cwd(),timeout:5000,stdio:["ignore","pipe","pipe"]}),error=>error.signal==="SIGKILL","installed app upgrade must reach atomic replacement");
 assert.equal(await fs.readFile(join(root,"generated/entry.mjs"),"utf8"),to.files["generated/entry.mjs"]);
 assert.deepEqual((await lifecycle.applyAppUpgrade(input)).applied,["generated/second.txt"]);
 assert.deepEqual((await lifecycle.applyAppUpgrade(input)).applied,[]);
 assert.equal((await import(pathToFileURL(join(root,"generated/entry.mjs")).href)).revision,2);
 assert.equal(await fs.readFile(join(root,"brand.txt"),"utf8"),"adopter brand");
 assert.equal(await fs.readFile(join(root,"theme.css"),"utf8"),"adopter theme");
 await assert.rejects(lifecycle.applyAppUpgrade({...input,schemaVersion:3}),lifecycle.AppUpgradeConflictError);
 await assert.rejects(import("@openlup/platform/lifecycle/internal"),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
} finally {await fs.rm(root,{recursive:true,force:true});}
`);
}

/** Two separate methods keep their own request and result shapes in both module-resolution modes. */
export function compileOperationsConsumer(consumer: string, compiler: string): void {
  const file=join(consumer,"operations-types.ts");
  writeFileSync(file,`
import { createOperationsClients } from "@openlup/platform/operations";
import type { OperationsRequestBff } from "@openlup/platform/operations";
import type { PlatformControlPlanePort } from "@openlup/platform/operations/contracts";
import { runPlatformWatchdog } from "@openlup/platform/operations/server";
declare const requestBff: OperationsRequestBff;
const clients=createOperationsClients(requestBff);
const setting: {key:string;saved:true}=await clients.updateAdminSetting("token",{key:"enabled",value:true});
const pipeline: {emailSendCount:number}=await clients.getAdminPipeline("token");
// @ts-expect-error a setting write does not return a pipeline result
const wrong: {emailSendCount:number}=await clients.updateAdminSetting("token",{key:"enabled",value:true});
// @ts-expect-error values remain the existing scalar setting contract
clients.updateAdminSetting("token",{key:"enabled",value:{invented:true}});
declare const control: PlatformControlPlanePort;
control.mutateControlPlane({action:"set-control",idempotencyKey:"key",controlKey:"enabled",enabled:true});
// @ts-expect-error heartbeat inputs cannot masquerade as control writes
control.mutateControlPlane({action:"set-control",idempotencyKey:"key",health:"healthy"});
declare const ledgerPort: import("@openlup/platform/operations/contracts").AlertLedgerPort;
declare const sinkPort: import("@openlup/platform/operations/contracts").AlertSinkPort;
runPlatformWatchdog({evidencePort:{collectSnapshot:async()=>({checkedAt:"instant",sample:7})},ledgerPort,sinkPort,catalog:[{name:"example"}],checkOnly:true,evaluate(snapshot,catalog){const sample:number=snapshot.sample;const name:string=catalog[0].name;void sample;void name;return [];}});
declare const hostLedger: import("@openlup/platform/operations/contracts").AlertLedgerPort<"operator-pager">;
declare const hostSink: import("@openlup/platform/operations/contracts").AlertSinkPort<"operator-pager">;
const hostDecision: import("@openlup/platform/operations/contracts").AlertDecision<"operator-pager">={dedupeKey:"example",severity:"p0",owner:"ops",runbookUrl:"/runbook",title:"Example",message:"Synthetic",channels:["operator-pager"],payload:{}};
const hostRun=await runPlatformWatchdog({evidencePort:{collectSnapshot:async()=>({checkedAt:"instant"})},ledgerPort:hostLedger,sinkPort:hostSink,catalog:[],checkOnly:false,evaluate:()=>[hostDecision]});
const hostChannel: "operator-pager"=hostRun.decisions[0].channels[0];
// @ts-expect-error the host sink preserves its own channel key
hostSink.send({...hostDecision,channels:["other-channel"]},{id:"alert",dedupeKey:"example",status:"open",severity:"p0",lastNotifiedAt:null});
const otherDecision: import("@openlup/platform/operations/contracts").AlertDecision<"other-channel">={...hostDecision,channels:["other-channel"]};
// @ts-expect-error composition cannot widen a narrow host sink/ledger to another channel
runPlatformWatchdog({evidencePort:{collectSnapshot:async()=>({checkedAt:"instant"})},ledgerPort:hostLedger,sinkPort:hostSink,catalog:[],checkOnly:false,evaluate:()=>[otherDecision]});
void setting;void pipeline;void wrong;void hostChannel;
`);
  const configuration=join(consumer,"operations-types.json");
  for(const [module,moduleResolution] of [["NodeNext","NodeNext"],["ESNext","Bundler"]]) {
    writeFileSync(configuration,JSON.stringify({compilerOptions:{module,moduleResolution,target:"ES2022",strict:true,noEmit:true,skipLibCheck:false,types:["node"],typeRoots:[join(consumer,"node_modules/@types")]},files:[file]}));
    command(process.execPath,[compiler,"-p",configuration],consumer,isolatedConsumerEnv());
  }
}

export function compileConsumer(consumer: string, entries: readonly string[], compiler: string): void {
  const file = join(consumer, "consumer.ts");
  const surfaces = entries.map((name, index) => `import type * as Entry${index} from "@openlup/platform/${name}";\nexport type Surface${index} = typeof Entry${index};`);
  if (entries.includes("marketing") && entries.includes("marketing/contracts")) surfaces.push([
    'import { acquisitionCaseListRequestSchema, prelaunchAcquisitionListRequestSchema, buildHeadDescriptor, organizationLd } from "@openlup/platform/marketing";',
    'import type { AcquisitionCaseListRequest, AcquisitionNewsletterConsentEvent, MarketingResearchSurveySubmitPort, AcquisitionCasePort, AcquisitionEvidencePort, PrelaunchAcquisitionListRequest, ContactContent, LegalDocumentContent, PrivacyProcessorDisclosure } from "@openlup/platform/marketing/contracts";',
    'export const marketingRequest: AcquisitionCaseListRequest = acquisitionCaseListRequestSchema.parse({ view: "acquisition_case_v1" });',
    '// @ts-expect-error parsed default is required in the output type',
    'export const missingMarketingLimit: AcquisitionCaseListRequest = { view: "acquisition_case_v1" };',
    'export const prelaunchRequest: PrelaunchAcquisitionListRequest = prelaunchAcquisitionListRequestSchema.parse({ view: "prelaunch_acquisition_v1" });',
    'declare const casePort: AcquisitionCasePort;',
    'export const caseList = casePort.list({ actorRef: "actor:one", scope: "public_tester_application", limit: 25 });',
    '// @ts-expect-error retired submission is application-owned',
    'casePort.submit({});',
    'declare const evidencePort: AcquisitionEvidencePort;',
    'export const surveyList = evidencePort.listSurveys({ actorReference: "actor:one", view: "acquisition_survey_v1", limit: 50 });',
    'declare const marketingEvent: AcquisitionNewsletterConsentEvent;',
    'export const explicitConsent: boolean = marketingEvent.explicitOptInEvidence;',
    'declare const surveyPort: MarketingResearchSurveySubmitPort;',
    'export const surveyResult = surveyPort.submitSurveyResponse({ surveyType: "consumer", responseData: { answer: true } });',
    'declare const contact: ContactContent;',
    'export const processor: PrivacyProcessorDisclosure = { processorName: "Example Processor", purpose: "Example purpose", dataCategories: ["Example data"] };',
    'export const legal: LegalDocumentContent = { title: "Example document", intro: "Example introduction", sections: [{ title: "Example section", body: "Example body" }] };',
    'export const contactInput: ContactContent = { organization: contact.organization, supportEmail: "support@example.invalid", addressLine: "Example address", registrationIdentifiers: [] };',
    'export const siteIdentity = contact.organization.name;',
    'export const processorName = processor.processorName;',
    'export const head = buildHeadDescriptor({ origin: "https://shop.example", route: { id: "home", locale: "alpha", canonicalPath: "/" }, routes: [], xDefaultLocale: "alpha", htmlLang: "alpha", title: "Example", description: "Example content", siteName: "Example Store", ogImage: "https://shop.example/image.png", ogImageWidth: 1200, ogImageHeight: 630, twitterHandle: "@example", ogLocale: "alpha", twitterImage: "https://shop.example/card.png", jsonLd: organizationLd("https://shop.example", "Organization", contact.organization) });',
    '// @ts-expect-error organization facts are required for contact content',
    'const missingContact: ContactContent = { supportEmail: "support@example.invalid", addressLine: "Example address", registrationIdentifiers: [] };',
    '// @ts-expect-error legal document sections are required',
    'const missingSections: LegalDocumentContent = { title: "Example", intro: "Example introduction" };',
    '// @ts-expect-error processor data categories are required',
    'const missingCategories: PrivacyProcessorDisclosure = { processorName: "Example", purpose: "Example purpose" };',
    'void missingContact; void missingSections; void missingCategories;',
  ].join("\n"));
  if (entries.includes("marketing/server")) surfaces.push([
    'import { createAcquisitionCaseHandlers, createAcquisitionCaseActiveCountDirectHandler } from "@openlup/platform/marketing/server";',
    'import type { AcquisitionCasePort as ServerAcquisitionCasePort, AcquisitionCaseDirectDeps } from "@openlup/platform/marketing/server";',
    'declare const acquisitionPort: ServerAcquisitionCasePort;',
    'declare const acquisitionDirect: AcquisitionCaseDirectDeps;',
    'export const acquisitionHandlers = createAcquisitionCaseHandlers(acquisitionPort);',
    'export const acquisitionCount = createAcquisitionCaseActiveCountDirectHandler(acquisitionDirect);',
  ].join("\n"));
  if (entries.includes("lifecycle")) surfaces.push([
    'import { planAppUpgrade, applyAppUpgrade, inspectLegacyPostgresInstallRoles } from "@openlup/platform/lifecycle";',
    'import type { AppVersionSnapshot, AppUpgradeInput, AppUpgradePlan, PostgresInstallQuery, LegacyPostgresInstallRequest, LegacyPostgresInstallRoleReport } from "@openlup/platform/lifecycle";',
    'declare const from: AppVersionSnapshot; declare const to: AppVersionSnapshot;',
    'const upgrade: AppUpgradeInput = { root: "/example-app", from, to, schemaVersion: 2 };',
    'export const plannedUpgrade: Promise<AppUpgradePlan> = planAppUpgrade(upgrade);',
    'export const appliedUpgrade = applyAppUpgrade(upgrade);',
    'declare const roleDb: PostgresInstallQuery;',
    'const roleRequest: LegacyPostgresInstallRequest = { migrationLogin: "migration", runtimeLogin: "migration", roleMode: "installer-managed" };',
    'export const legacyRoles: Promise<LegacyPostgresInstallRoleReport> = inspectLegacyPostgresInstallRoles(roleDb, roleRequest);',
    '// @ts-expect-error qualification modes are explicit and do not imply install readiness',
    'inspectLegacyPostgresInstallRoles(roleDb, { ...roleRequest, roleMode: "ready" });',
    '// @ts-expect-error schema admission uses an explicit integer ordinal',
    'planAppUpgrade({ ...upgrade, schemaVersion: "2" });',
  ].join("\n"));
  if (entries.includes("portability")) surfaces.push([
    'import { captureCompatiblePostgresRows, restoreCompatiblePostgresRows, copyTransferObjects } from "@openlup/platform/portability";',
    'import type { CompatiblePostgresSnapshot, CompatiblePostgresTarget, CompatiblePostgresPacket, TransferObjectInventory, TransferObjectStore } from "@openlup/platform/portability";',
    'declare const source: CompatiblePostgresSnapshot; declare const target: CompatiblePostgresTarget;',
    'export const captured: Promise<CompatiblePostgresPacket> = captureCompatiblePostgresRows({source,sourceId:"source",catalogueId:"catalogue",tables:["outbox_events"],maximumRows:10,maximumBytes:1024});',
    'export const restored = restoreCompatiblePostgresRows({target,catalogueId:"catalogue",packet:await captured});',
    'declare const inventory: TransferObjectInventory; declare const objects: TransferObjectStore;',
    'export const copied = copyTransferObjects({inventory,source:objects,destination:objects,accessMapping:{private:"private"},maximumObjectBytes:1024,maximumTotalBytes:1024});',
    '// @ts-expect-error migration ledgers are not compatible data candidates',
    'captureCompatiblePostgresRows({source,sourceId:"source",catalogueId:"catalogue",tables:["platform_schema_migrations"],maximumRows:10,maximumBytes:1024});',
  ].join("\n"));
  if (entries.includes("commerce/server")) surfaces.push([
    'import { tryCompensate } from "@openlup/platform/commerce/server";',
    'import type { CheckoutCompensationPort } from "@openlup/platform/commerce/server";',
    'declare const compensationPort: CheckoutCompensationPort;',
    'export const compensationResult: Promise<void> = tryCompensate(compensationPort, "intent-key", "order-1");',
  ].join("\n"));
  if (entries.includes("commerce") && entries.includes("commerce/contracts")) surfaces.push([
    'import { offerAvailabilityRequestItems } from "@openlup/platform/commerce";',
    'import type { CommerceOfferAvailabilityPort } from "@openlup/platform/commerce/contracts";',
    'export const commerceItems = offerAvailabilityRequestItems([], "one_time");',
    'declare const commercePort: CommerceOfferAvailabilityPort;',
    'export const commerceResult = commercePort.getAvailability({ items: commerceItems });',
    '// @ts-expect-error checkout mode is a closed contract',
    'offerAvailabilityRequestItems([], "unsupported");',
  ].join("\n"));
  if (entries.includes("account-support") && entries.includes("account-support/contracts")) surfaces.push([
    'import { createAccountReadFacade } from "@openlup/platform/account-support";',
    'import type { AccountReadPort, InvoiceAccessPort, NativeOperatorSubscriptionResult } from "@openlup/platform/account-support/contracts";',
    'export const nativeRefusal: NativeOperatorSubscriptionResult = { outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" };',
    'const accountRead: AccountReadPort<{ revision: string }, { orders: string[] }, { orderId: string }> = createAccountReadFacade({ account: { getAccount: async () => ({ revision: "original" }) }, orders: { listOrders: async () => ({ orders: [] }), getOrderDetail: async (_userId, orderId) => ({ orderId }) } });',
    'export const accountResult = accountRead.listOrders("principal-a", { limit: 17 });',
    '// @ts-expect-error cursor pagination is not an owner capability',
    'accountRead.listOrders("principal-a", { limit: 17, cursor: "invented" });',
    'declare const invoiceAccess: InvoiceAccessPort;',
    '// @ts-expect-error account and order scope are required for download authorization',
    'invoiceAccess.resolveDownload({ documentRef: "document-a" });',
  ].join("\n"));
  // The composer's structural payments slot must accept the payments factory result for typed hosts.
  if (entries.includes("composition") && entries.includes("payments")) surfaces.push([
    'import { createBundleComposer } from "@openlup/platform/composition";',
    'import type { createPaymentServices } from "@openlup/platform/payments";',
    "declare const services: NonNullable<ReturnType<typeof createPaymentServices>>;",
    "export const composedWithPayments = createBundleComposer({ blob: () => null, payments: () => services });",
  ].join("\n"));
  if (entries.includes("fulfillment") && entries.includes("fulfillment/contracts") && entries.includes("composition")) surfaces.push([
    'import { createFulfillmentServices } from "@openlup/platform/fulfillment";',
    'import { createFulfillmentContribution, createBundleComposer as composeFulfillment } from "@openlup/platform/composition";',
    'import type { FulfillmentServicesOptions, FulfillmentServices } from "@openlup/platform/fulfillment/contracts";',
    'declare const fulfillmentOptions: FulfillmentServicesOptions;',
    'const fulfillment: FulfillmentServices = createFulfillmentServices(fulfillmentOptions);',
    'export const composedFulfillment = composeFulfillment({blob:()=>null,fulfillment:()=>fulfillment});',
    'export const fulfillmentContribution = createFulfillmentContribution({version:"0.21.0",requiredSchema:{version:"fixture",migration:"fixture",objects:[]},fulfillment:{dispatch:fulfillment.runDispatch},handlers:[],schedules:[],routes:[]});',
  ].join("\n"));
  if (entries.includes("invoicing") && entries.includes("invoicing/contracts")) surfaces.push([
    'import { createInvoiceServices, createInvoiceContribution, claimInvoiceSellerRevision, type InvoiceServices, readInvoiceCapabilities, createNativeUnsupportedInvoicePorts, runInvoiceAdapterConformance } from "@openlup/platform/invoicing";',
    'import type { InvoiceFacts, InvoiceLine, InvoiceSeller, InvoiceBuyer, InvoiceIdentity, InvoiceWriteResult, InvoiceReadbackResult, InvoiceArtifactResult, InvoiceSettlementResult, InvoiceCapabilities, InvoiceCompanyLookupPort, InvoiceStorePort, InvoiceHostPorts, InvoiceServicesOptions, InvoiceDocumentIdentity, InvoiceProviderPort, InvoiceSettlementPort, InvoiceSettlementItem, InvoiceDutyReadback, InvoiceUnsupported, InvoiceDiagnosticCode, InvoiceProof, InvoiceClearanceObservation, InvoiceSellerRevision } from "@openlup/platform/invoicing/contracts";',
    'declare const invoiceCapability: InvoiceCapabilities;',
    'declare const invoiceOptions: InvoiceServicesOptions;',
    'export const invoiceServices: InvoiceServices = createInvoiceServices({ ...invoiceOptions, factories: {} });',
    'export const invoiceRun: Promise<unknown> = invoiceServices.run("issue");',
    'declare const sellerRevision: InvoiceSellerRevision;',
    'export const selectedSeller = claimInvoiceSellerRevision(async () => ({ kind: "found", ...sellerRevision }));',
    'export const invoiceContribution = createInvoiceContribution({ version: "test", requiredSchema: { version: "complete", migration: "complete", objects: [] }, invoicing: {}, handlers: [], routes: [], schedules: [] });',
    'export const unsupportedInvoices = createNativeUnsupportedInvoicePorts();',
    'export type InvoiceConformanceSubject = Parameters<typeof runInvoiceAdapterConformance>[0][number];',
    'export const invoiceSelection = readInvoiceCapabilities({ enabled: true, selection: { providerRef: invoiceCapability.providerRef }, capability: invoiceCapability });',
    'export type InvoiceConsumer = [InvoiceFacts, InvoiceLine, InvoiceSeller, InvoiceBuyer, InvoiceIdentity, InvoiceWriteResult, InvoiceReadbackResult, InvoiceArtifactResult, InvoiceSettlementResult, InvoiceCompanyLookupPort, InvoiceStorePort, InvoiceHostPorts, InvoiceServicesOptions, InvoiceDocumentIdentity, InvoiceProviderPort, InvoiceSettlementPort, InvoiceSettlementItem, InvoiceDutyReadback, InvoiceUnsupported, InvoiceDiagnosticCode, InvoiceProof, InvoiceClearanceObservation];',
    // CI compiles the 14 pinned SQL seam mappings from portFit.test.ts against installed types.
    // Distribute over union arms so absent evidence and before_send phase cannot disappear.
    'type RequiredKeys<T> = T extends object ? { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T] : "$value";',
    'type SeamInput<M extends keyof InvoiceStorePort> = Parameters<InvoiceStorePort[M]>[0];',
    'export const invoiceSeam_captureDuty = {"requestKey": "p_key", "sourceKind": "p_source_kind", "sourceId": "p_source_id", "orderId": "p_order_id", "occurredAt": "p_occurred_at", "evidence": "p_evidence"} satisfies Record<RequiredKeys<SeamInput<"captureDuty">>, string>;',
    'export const invoiceSeam_installFacts = {"dutyId": "p_duty", "facts": "p_facts + p_revision"} satisfies Record<RequiredKeys<SeamInput<"installFacts">>, string>;',
    'export const invoiceSeam_sweep = {"$value": "p_limit"} satisfies Record<RequiredKeys<SeamInput<"sweep">>, string>;',
    'export const invoiceSeam_prepareFacts = {"dutyId": "p_duty", "token": "p_token"} satisfies Record<RequiredKeys<SeamInput<"prepareFacts">>, string>;',
    'export const invoiceSeam_finishFacts = {"dutyId": "p_duty", "token": "p_token", "result": "p_result"} satisfies Record<RequiredKeys<SeamInput<"finishFacts">>, string>;',
    'export const invoiceSeam_readDuties = {"$value": "p_order_id"} satisfies Record<RequiredKeys<SeamInput<"readDuties">>, string>;',
    'export const invoiceSeam_claim = {"limit": "p_limit", "visibilitySeconds": "p_visibility / managed local lease", "providerRef": "p_provider / managed binding validation"} satisfies Record<RequiredKeys<SeamInput<"claim">>, string>;',
    'export const invoiceSeam_preflight = {"claim": "p_duty + p_token + p_generation", "amountMinor": "p_evidence", "currency": "p_evidence", "status": "p_evidence", "proof": "p_evidence (observed arm)", "evidence": "p_evidence (absent arm)"} satisfies Record<RequiredKeys<SeamInput<"preflight">>, string>;',
    'export const invoiceSeam_finish = {"claim": "p_duty + p_token + p_generation", "result": "p_external + p_number + p_proof"} satisfies Record<RequiredKeys<SeamInput<"finish">>, string>;',
    'export const invoiceSeam_fail = {"claim": "p_duty + p_token + p_generation", "retrySeconds": "p_delay", "kind": "p_kind", "phase": "p_evidence (retryable arm)", "proof": "p_evidence", "evidence": "p_evidence (absent arm)"} satisfies Record<RequiredKeys<SeamInput<"fail">>, string>;',
    'export const invoiceSeam_requestReversal = {"requestKey": "p_key", "orderId": "p_order", "reason": "p_reason", "proof": "p_evidence"} satisfies Record<RequiredKeys<SeamInput<"requestReversal">>, string>;',
    'export const invoiceSeam_recordObservation = {"requestKey": "p_key", "documentId": "p_document", "eventRef": "p_observation", "eventKind": "p_observation", "identity": "p_observation", "providerDocumentRef": "p_observation", "providerDocumentNumber": "p_observation", "clearance": "p_observation", "artifacts": "p_observation", "observedAt": "p_observation", "payloadHash": "p_observation", "source": "p_observation"} satisfies Record<RequiredKeys<SeamInput<"recordObservation">>, string>;',
    'export const invoiceSeam_claimDeliveries = {"limit": "p_limit", "visibilitySeconds": "p_visibility", "requireClearance": "p_require_clearance"} satisfies Record<RequiredKeys<SeamInput<"claimDeliveries">>, string>;',
    'export const invoiceSeam_settleDelivery = {"deliveryRef": "p_delivery", "token": "p_token", "generation": "p_generation", "providerDocumentRef": "local claimed document validation", "retrySeconds": "p_evidence (native); p_retry_seconds (managed)", "result": "p_kind + p_receipt (NULL when uncertain) + p_evidence (retryable and uncertain receipt hint)"} satisfies Record<RequiredKeys<SeamInput<"settleDelivery">>, string>;',
    'declare const invoiceIdentity: InvoiceIdentity;',
    'export const invoiceAbsent: InvoiceReadbackResult = { kind: "absent", identity: invoiceIdentity, evidence: { exact: true, complete: true, scope: invoiceIdentity, evidenceRef: "lookup-a", fingerprint: "fingerprint-a", observedAt: "2026-10-22T12:00:00Z" } };',
  ].join("\n"));
  writeFileSync(file, surfaces.join("\n"));
  for (const mode of ["NodeNext", "Bundler"]) {
    const configuration = join(consumer, "tsconfig.json");
    writeFileSync(configuration, JSON.stringify({ compilerOptions: {
      target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"],
      typeRoots: [join(consumer, "node_modules/@types")],
    }, files: [file] }));
    process.stdout.write(command(process.execPath, [compiler, "-p", configuration], consumer));
    console.log(`Platform declarations PASS (${mode}; ${entries.join(", ")})`);
  }
}

// OIDC uses a host-selected implementation, separate from the historical adapter fixture inventory.
const oidcOperations = `
import assert from "node:assert/strict";
import { createOidcIdentityVerifier, createPostgresAccountLinkStore, deriveOidcPrincipalId } from "@openlup/platform/identity";
import { OIDC_FAILURE_CODES } from "@openlup/platform/identity";
assert(OIDC_FAILURE_CODES.includes("OIDC_NATIVE_SESSION_REQUIRED"));
assert.equal(deriveOidcPrincipalId("https://issuer.example.com/realm", "subject"), "262d8593-5c2f-8ce3-a5f2-de2751bbfe90");
let oidcFetches = 0, oidcLoads = 0;
const oidcIssuer = "https://issuer.example.invalid";
const oidc = createOidcIdentityVerifier({ issuer: oidcIssuer, audience: "api", algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600 }, {
  fetch: async url => { oidcFetches++; return Response.json(String(url).endsWith("openid-configuration") ? { issuer: oidcIssuer, jwks_uri: oidcIssuer + "/keys" } : { keys: [{ kty: "RSA", alg: "RS256", kid: "key", use: "sig", n: "synthetic", e: "AQAB" }] }); },
  loadJwt: async () => { oidcLoads++; return import("jose"); },
});
assert.equal(oidcFetches, 0); assert.equal(oidcLoads, 0);
const oidcToken = [{ alg: "RS256", kid: "key" }, { iss: oidcIssuer }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".c2ln";
assert.deepEqual(await oidc.verifyToken(oidcToken), { ok: false, code: "OIDC_JWT_LIBRARY_UNAVAILABLE" });
assert.equal(oidcLoads, 1);
await assert.rejects(async () => {
  const accountLinks = createPostgresAccountLinkStore({ connectionString: "postgresql://unused.invalid/consumer" });
  try { await accountLinks.findAccountByPrincipalId("11111111-1111-4111-8111-111111111111"); }
  finally { await accountLinks.close(); }
}, error => error.message.startsWith("OPENLUP_E_PEER_MISSING: pg is required by ") && Boolean(error.cause));
`;

export function proveOidcRefusals(consumer: string): void {
  consumerNode(consumer, oidcOperations);
}

// A valid synthetic catalogue gets as far as the lazy driver, never a deployment's SQL.
const adapterOperations = `
import assert from "node:assert/strict";
import { bindBlobPort } from "@openlup/platform/blob";
import { createPostgresDataGateway, createPostgresRoleFreeTransactionLane } from "@openlup/platform/data";
import { createPostgresMigrationRunner } from "@openlup/platform/migrations";
import { createEnvAdvisoryLock } from "@openlup/platform/scheduler";
import { createPostgresCustomerMePort, createPostgresPrivacyStore, createPostgresCustomerChallengeStore, createDirectOperatorInvitationStore, createDirectOperatorIdentityDirectory, createSupabaseIdentityVerifier as createManagedVerifier, createSupabaseAccountLinkStore as createManagedLinkStore, createPostgresOperatorIdentityStore, createOperatorSessionService, createOperatorAdminAuth, createOperatorIdentityVerifier, createPostgresPrivacyUnitOfWork, createManagedPrivacyStore, createPersonalDataContributorRegistry } from "@openlup/platform/identity";
import { operatorChallengeRequestSchema, operatorSessionSchema, privacyExportRequestSchema } from "@openlup/platform/identity/contracts";

assert.equal(typeof createOperatorSessionService, "function");
assert.equal(createManagedPrivacyStore().erasureSupported, false);
assert.deepEqual(createPersonalDataContributorRegistry([], { requiredContributorIds: ["identity"] }).missingContributors, ["identity"]);
assert(privacyExportRequestSchema.safeParse({ subject: { kind: "contact", contactId: "11111111-1111-4111-8111-111111111111" } }).success);
assert.equal(typeof createOperatorAdminAuth, "function");
assert.equal(typeof createOperatorIdentityVerifier, "function");
assert(operatorChallengeRequestSchema.safeParse({ email: "admin@example.invalid" }).success);
assert(!operatorSessionSchema.safeParse({ accessToken: "incomplete" }).success);
const manifest = { schemaVersion: 1, baseline: { file: "baseline.sql", sha256: "0".repeat(64) }, forward: [], objectInventorySha256: "0".repeat(64) };
function postgresOperations(connectionString) {
  return [
    () => createPostgresDataGateway({ connectionString }).asService(async () => "service"),
    async () => { const lane = createPostgresRoleFreeTransactionLane({ connectionString }); try { return await lane.run(async () => "transaction"); } finally { await lane.close(); } },
    () => createPostgresMigrationRunner({ connectionString }, {
      root: process.cwd(), lockName: "platform-cold-consumer", catalogProjectionPayload: async () => "",
      source: { readMigrations: () => ({ migrations: [{ file: "baseline.sql", content: "SELECT 1;" }], errors: [] }), readManifest: () => manifest, evaluate: () => [] },
    }).status(),
    async () => { const lock = createEnvAdvisoryLock({ DATABASE_URL: connectionString }); try { assert.equal(await lock.tryAcquire("consumer"), true); await lock.release("consumer"); } finally { await lock.close(); } },
    async () => { const store = createPostgresOperatorIdentityStore({ connectionString }); try { return await store.findMembership("11111111-1111-4111-8111-111111111111"); } finally { await store.close(); } },
    async () => { const lane = createPostgresPrivacyUnitOfWork({ connectionString }); try { return await lane.run(async () => "privacy"); } finally { await lane.close(); } },
    () => createPostgresDataGateway({ connectionString }).asActor({ role: "authenticated", sub: "11111111-1111-4111-8111-111111111111" }, db => createPostgresCustomerMePort(db).getCustomerMe("11111111-1111-4111-8111-111111111111")),
    async () => { const lane = createPostgresPrivacyUnitOfWork({ connectionString }); try { return await lane.run(db => createPostgresPrivacyStore().findReceipt(db, { kind: "contact", contactId: "11111111-1111-4111-8111-111111111111" })); } finally { await lane.close(); } },
    async () => { const store = createPostgresCustomerChallengeStore({ connectionString }); try { return await store.pruneChallenges({ limit: 1 }); } finally { await store.close(); } },
    async () => { const store = createDirectOperatorInvitationStore({ connectionString }); try { return await store.read("11111111-1111-4111-8111-111111111111"); } finally { await store.close(); } },
    async () => { const directory = createDirectOperatorIdentityDirectory({ connectionString }); try { return await directory.ensurePrincipal({ email: "operator@example.invalid", redirectTo: "https://example.invalid/admin/auth/callback" }); } finally { await directory.close(); } },
  ];
}
const structuralClient = {
  auth: { getUser: async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111", email: "customer@example.invalid", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
};
assert.equal((await createManagedVerifier(structuralClient).verifyAccessToken("synthetic")).emailVerified, true);
assert.equal(await createManagedLinkStore(structuralClient).findAccountByPrincipalId("11111111-1111-4111-8111-111111111111"), null);
`;

export function proveAdapterRefusals(consumer: string): void {
  consumerNode(consumer, adapterOperations + `
// This selected entry retains its original static driver import.
await assert.rejects(import("@openlup/platform/marketing/server/postgres"),
  error => error.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package 'pg'/.test(error.message));
const blob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://example.invalid" });
const checks = [["@aws-sdk/client-s3", () => blob.upload("probe", Buffer.from("probe"))],
  ...Object.values(postgresOperations("postgresql://unused.invalid/consumer")).map(operation => ["pg", operation])];
for (const [peer, operation] of checks) {
  await assert.rejects(operation, error => error.message.startsWith("OPENLUP_E_PEER_MISSING: " + peer + " is required by ") && Boolean(error.cause));
}
`);
}

export function proveInstalledAdapters(consumer: string): void {
  consumerNode(consumer, adapterOperations + `
import * as sdk from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createS3ClientFromEnv } from "@openlup/platform/blob";
import { createPostgresAcquisitionCasePort, createPostgresAcquisitionEvidencePort } from "@openlup/platform/marketing/server/postgres";
assert.equal(typeof createPostgresAcquisitionCasePort, "function");
assert.equal(typeof createPostgresAcquisitionEvidencePort, "function");
assert.throws(() => createPostgresAcquisitionCasePort({ connectionString: " " }), /acquisition_case_database_url_required/);
assert.throws(() => createPostgresAcquisitionEvidencePort({ connectionString: " " }), /acquisition_evidence_database_url_required/);
// The default loaders must reach real SDK configuration, without opening a socket.
// Invalid URLs deterministically fail before a transport can contact any provider.
const invalidBlob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://example.invalid",
  BLOB_S3_ENDPOINT: "invalid endpoint", BLOB_S3_ACCESS_KEY_ID: "synthetic", BLOB_S3_SECRET_ACCESS_KEY: "synthetic" });
await assert.rejects(() => invalidBlob.upload("probe", Buffer.from("probe")), error => error.code === "ERR_INVALID_URL");
for (const operation of Object.values(postgresOperations("postgresql://synthetic@localhost:invalid/consumer"))) {
  await assert.rejects(operation, error => error.code === "ERR_INVALID_URL");
}
// Inject only the transport into the real S3 SDK; execute its serializer,
// middleware, deserializer and the platform's binding/storage operations.
const objects = new Map();
const requestHandler = { async handle(request) {
  const key = decodeURIComponent(request.path);
  let statusCode = 200, body = "";
  if (request.method === "PUT") {
    const chunks = [];
    if (typeof request.body === "string" || ArrayBuffer.isView(request.body)) chunks.push(Buffer.from(request.body));
    else for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
  } else if (request.method === "HEAD") statusCode = objects.has(key) ? 200 : 404;
  else if (request.method === "DELETE") { objects.delete(key); statusCode = 204; }
  else body = "<ListBucketResult>" + [...objects.keys()].map(key => "<Contents><Key>" + key.split("/").slice(2).join("/") + "</Key></Contents>").join("") + "</ListBucketResult>";
  return { response: { statusCode, headers: { "content-type": "application/xml" }, body: Readable.from([Buffer.from(body)]) } };
} };
class TransportClient extends sdk.S3Client {
  constructor(config) { super({ ...config, requestHandler }); }
}
const clients = [];
const blob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://storage.invalid/consumer",
  BLOB_S3_ENDPOINT: "https://storage.invalid", BLOB_S3_FORCE_PATH_STYLE: "true", BLOB_S3_ACCESS_KEY_ID: "synthetic", BLOB_S3_SECRET_ACCESS_KEY: "synthetic" }, {
  s3ClientFactory: env => createS3ClientFromEnv(env, () => ({ ...sdk, S3Client: class extends TransportClient {
    constructor(config) { super(config); clients.push(this); }
  } })),
});
try {
  assert.equal(await blob.exists("probe"), false);
  const uploaded = await blob.upload("probe", Buffer.from("probe"));
  assert.equal(objects.get("/consumer/probe").toString(), "probe");
  assert.equal(await blob.exists("probe"), true);
  assert.deepEqual(await blob.list(), { keys: ["probe"] });
  await blob.delete(uploaded.url); assert.equal(await blob.exists("probe"), false);
} finally { for (const client of clients) client.destroy(); }

`);
}

export function provePostgresOperations(consumer: string, connectionString: string): void {
  consumerNode(consumer, adapterOperations + `
const operations = postgresOperations(process.argv[2]);
assert.equal(await operations[0](), "service");
assert.equal(await operations[1](), "transaction");
assert.deepEqual(await operations[2](), { pending: ["baseline.sql"], applied: [] });
await operations[3]();
// A selected driver alone cannot enable operator login without its migrated schema.
await assert.rejects(() => operations[4](), error => error.code === "42P01");
assert.equal(await operations[5](), "privacy");
// Default gateway and migration pools have no public shutdown API.
process.exit(0);
`, [connectionString]);
}

/** Runs from the installed artifact with optional peers physically absent. */
/** Offline opt-in payment proof from installed bytes with no SDK or ambient I/O. */
export function provePaymentAdapterConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const sdk = ["str", "ipe"].join("");
for (const name of [sdk, "@" + sdk + "/" + sdk + "-js", ["tp", "ay"].join("")]) {
 assert.throws(() => require.resolve(name), error => ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(error.code));
}
const forbidden = () => { throw Error("ambient I/O forbidden"); };
globalThis.fetch = forbidden; http.request = forbidden; https.request = forbidden; net.connect = forbidden;
for (const operation of ["writeFile", "writeFileSync"]) fs[operation] = forbidden;
syncBuiltinESMExports();
const adapter = await import("@openlup/platform/payments/stripe");
assert.deepEqual(Object.keys(adapter).sort(), ["createStripePaymentAdapter", "stripePaymentCapabilities", "createStripeSandboxPaymentExecutionAdapter", "createStripePaymentReconciliationProvider", "mapStripeIntent", "mapSetupIntent", "normalizeStripeFailureEvidence"].sort());
let calls = 0;
const configured = adapter.createStripePaymentAdapter({ mode: "test", supportedCurrencies: ["EUR"], webhookSigningSecrets: ["fixture"], client: {
 createPaymentIntent: async (input, options) => { calls++; assert.equal(options.idempotencyKey,"host-key");
  assert.equal(input.metadata.providerRequestFingerprint,"host-fingerprint");
  return {id:"pi_fixture",status:"requires_confirmation",client_secret:"transient_fixture"}; },
 retrievePaymentIntent: async () => ({id:"pi_fixture",status:"processing",amount:2599,currency:"eur"})
} });
assert.equal(calls,0);
const input = {attemptRef:"attempt-a",intentRef:"intent-a",fingerprint:"host-fingerprint",providerIdempotencyKey:"host-key",
 money:{amountMinor:2599,currency:"EUR"},mode:"test",purpose:"initial"};
const result = await configured.attemptPort.execute(input);
assert.equal(calls,1); assert.equal(result.handoff.payload,"transient_fixture");
assert(!JSON.stringify(result.diagnostics).includes("transient_fixture"));
await assert.rejects(() => configured.attemptPort.execute({...input,mode:"live"}));
assert.equal(calls,1); assert.equal(configured.absencePort,undefined);
const second = await import("@openlup/platform/payments/tpay");
const secondFactory = "create" + "T" + "payPaymentAdapter";
const secondCapabilities = "t" + "payPaymentCapabilities";
assert.deepEqual(Object.keys(second).sort(), [secondFactory, secondCapabilities, "createTpayPaymentExecutionAdapter", "createTpayPaymentReconciliationProvider", "createTpayHttpClient", "normalizeTpayFailureEvidence", "aliasValue", "ProviderAttemptPreDispatchError"].sort());
for (const entry of ["payments", "payments/contracts"]) {
 const neutral = await import("@openlup/platform/" + entry);
 for (const name of [...Object.keys(adapter), ...Object.keys(second)]) assert(!Object.hasOwn(neutral, name), "vendor leaked to neutral entry");
}
assert.equal(second[secondCapabilities].exactAbsence,"unsupported");
assert.equal(second[secondCapabilities].refundCreate,"unsupported");
assert.equal(second[secondCapabilities].authorizationCaptureSplit,"unsupported");
assert.deepEqual(second[secondCapabilities].supportedCurrencies,[String.fromCharCode(80,76,78)]);
assert.throws(() => second[secondFactory]({ notification: {} }));
assert.equal(configured.capabilities.refundCreate,"unsupported");
assert.deepEqual(await configured.verifyPort.verifyAndNormalize({rawBody:Buffer.from("{}"),headers:{},receivedAt:"2026-10-21T00:00:00Z"}),{kind:"refusal",reason:"signature"});
`);
}

/** Opt-in warehouse proof with absent SDK/peers and exclusively injected I/O. */
export function proveWarehouseAdapterConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
const subpath = "fulfillment/omnipack";
const provider = subpath.split("/")[1];
assert.throws(() => createRequire(import.meta.url).resolve(provider), error => ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(error.code));
const forbidden = () => { throw Error("ambient I/O forbidden"); };
globalThis.fetch = forbidden; http.request = forbidden; https.request = forbidden; net.connect = forbidden;
syncBuiltinESMExports();
const entry = await import("@openlup/platform/" + subpath);
const factory = "create" + provider[0].toUpperCase() + provider.slice(1) + "FulfillmentAdapter";
const descriptor = provider + "FulfillmentCapabilities";
assert.deepEqual(Object.keys(entry).sort(), [factory, descriptor].sort());
assert.equal(entry[descriptor].defaultOff, true); assert.equal(entry[descriptor].selected, false);
assert.equal(entry[descriptor].readiness.ready, false);
let calls = 0, credentials = 0;
const config = {http:{baseUrl:"https://warehouse.example.test", timeoutMs:1000, safeReadRetries:0, productPath:"/products",
 credentials:()=>{credentials++;return {username:"example",password:"transient-placeholder"};},
 fetchImpl:async(_,input)=>{calls++; assert.equal(input.method,"POST"); return new Response(JSON.stringify({orderId:"external-a",apiKey:"transient-placeholder"}));}},
 resolveProduct:async()=>({}),notification:{token:()=>"transient-placeholder",expectedEvent:"order.delivered"},
 clock:()=>"2026-10-21T10:00:00Z",mintSyncRunId:()=>"sync-a",mintEvidenceReference:()=>"evidence:00000000-0000-4000-8000-000000000001",approveTrackingUrl:()=>false};
const dormant = entry[factory](config);
const request = {requestKey:"request-a",fulfillmentRef:"fulfillment-a",orderRef:"order-a",orderNumber:"ORDER-A",parcelRef:null,
 contactRevision:{schemaVersion:1,source:"checkout",revision:1},
 recipient:{name:"Example Recipient",email:"recipient@example.test",phone:"+12025550123",line1:"123 Example Street",line2:null,city:"Example City",postalCode:"10001",country:"US",deliveryInstructions:null,courierInstructions:null},
 lines:[{skuRef:"SKU-A",title:null,quantity:1,productRef:null,packRef:null}],
 selection:{providerRef:provider,carrierRef:"carrier-a",serviceRef:"service-a",deliveryKind:"courier",pickupPoint:null}};
assert.equal((await dormant.dispatch.prepare(request)).refusal.reason,"disabled");
const adapter = entry[factory]({...config,selected:true,readiness:{ready:true}});
const missing = await adapter.dispatch.dispatch(request,{});
assert.equal(missing.kind,"not_dispatched"); assert.equal(missing.refusal.reason,"not_dispatchable");
assert.equal(calls,0); assert.equal(credentials,0);
const prepared = await adapter.dispatch.prepare(request); assert.equal(prepared.kind,"prepared");
const result = await adapter.dispatch.dispatch(request,prepared.evidence); assert.equal(result.kind,"accepted");
assert.equal(calls,1);assert.equal(credentials,1);
assert(!JSON.stringify(result).includes("transient-placeholder"));assert(!JSON.stringify(result).includes("recipient@example.test"));
assert.equal((await adapter.readback.read({providerRef:provider,requestKey:"request-a",fulfillmentRef:"fulfillment-a",externalRef:null,mode:"command"})).kind,"unsupported");
assert.equal(calls,1);
`);
}

/** Same installed-artifact harness; no vendor SDK, ambient fetch or provider access. */
export function proveResendConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
globalThis.fetch = () => { throw Error("ambient network forbidden"); };
const adapter = await import("@openlup/platform/communications/resend");
assert.deepEqual(Object.keys(adapter).sort(), ["createResendTransport", "createResendWebhookHandler", "runResendDeliveryReconciliation"], "I02 exact three-export surface");
for (const value of Object.values(adapter)) assert.equal(typeof value, "function");
for (const entry of ["communications", "communications/contracts"]) {
 const neutral = await import("@openlup/platform/" + entry);
 for (const name of Object.keys(adapter)) assert(!Object.hasOwn(neutral, name), "vendor leaked to neutral entry");
}
const message = {from:"sender@example.invalid",to:"reader@example.invalid",subject:"Synthetic",html:"<p>Notice</p>"};
const calls = [];
const fetch = async (url, options) => { calls.push({url,options}); return Response.json({id:"cold-message",last_event:"delivered",to:[message.to]}); };
for (const mode of ["blocked","drop"]) {
 const sender = adapter.createResendTransport({environmentTagName:"host_env",fetch,policy:()=>({mode,reason:"synthetic_policy"})});
 const result = await sender.send(message);
 assert.equal(calls.length,0,"I02 blocked/drop zero POST"); assert.equal(result.outcome.ok,mode === "drop","I02 blocked/drop exact outcome");
}
const sender = adapter.createResendTransport({environmentTagName:"host_env",fetch,policy:to=>({mode:"sandbox_sink",reason:"synthetic_sink",intendedRecipient:to,recipient:"sink@example.invalid",credential:"synthetic-selected",environmentTag:"non_production"})});
assert.equal((await sender.send(message)).outcome.resendId,"cold-message");
assert.equal(calls.length,1); assert.equal(calls[0].options.method,"POST");
assert.equal(calls[0].options.headers.Authorization,"Bearer synthetic-selected");
assert.equal(calls[0].options.headers["X-Original-Recipient"],message.to);
assert.deepEqual(JSON.parse(calls[0].options.body).to,["sink@example.invalid"]);
assert.deepEqual(JSON.parse(calls[0].options.body).tags,[{name:"host_env",value:"non_production"}]);
const writes = [];
const handler = adapter.createResendWebhookHandler({environmentTagName:"host_env",webhookSecret:"synthetic-hook",now:()=>1000,port:{findSend:async()=>({id:"send"}),applyObservation:async row=>writes.push(row),recordAttempt:async()=>{}}});
const rawBody = '{ "type":"email.delivered", "data":{"email_id":"cold-message"} }';
const signature = createHmac("sha256","synthetic-hook").update("hook.1000."+rawBody).digest("base64");
assert.equal((await handler({rawBody,headers:{webhookId:"hook",timestamp:"1000",signature:"v1,"+signature}})).status,200);
assert.equal(writes.length,1); assert.equal(writes[0].eventType,"email.delivered");
assert.equal((await handler({rawBody,headers:{}})).status,401);
const result = await adapter.runResendDeliveryReconciliation({apiKey:"synthetic-read",fetch,now:new Date(1000000).toISOString(),graceMinutes:45,limit:1,port:{findFrozenSends:async()=>[{id:"send",messageId:"cold-message"}],applyPolledEvent:async row=>writes.push(row),recordPollAttempt:async()=>{},recordSendNotFound:async()=>{throw Error("unexpected abandonment");}}});
assert.equal(result.reconciled,1); assert.equal(writes.length,2); assert.equal(writes[1].eventType,"email.delivered");
assert.deepEqual(calls.map(call=>call.options.method),["POST","GET"]);
`);
}

/** Singleton marketing proof from installed bytes, with local-only credentials and injected I/O. */
export function proveMarketingSyncConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
globalThis.fetch = () => { throw Error("ambient network forbidden"); };
const adapter = await import("@openlup/platform/communications/klaviyo");
assert.equal(Object.keys(adapter).length,1,"P2 installed exact one-export surface");
const factory = Object.values(adapter)[0]; assert.equal(typeof factory,"function");
const binding={account:"synthetic",environment:"test",namespace:"host",mappingVersion:"1"},audience={kind:"account-wide"};
const subject={binding,subjectReference:"opaque:1",generation:1,erased:false,id:"profile_1",email:"reader@example.invalid",externalReference:"local:1",ownedFields:[],ownedProperties:[]};
const values=new Map(),calls=[];
const storage={availability:{account:binding.account,environment:binding.environment,busy:false,quarantined:false},get:async k=>values.get(k)??null,compareAndSwap:async(k,expected,next)=>{if((values.get(k)??null)!==expected)return false;values.set(k,next);return true;}};
const auth={binding,audience,subjectReference:"opaque:1",operation:"consent.read",expiresAtMs:10000};
let clock=10;
const config={binding,audience,subjectMapper:ref=>ref==="opaque:1"?subject:undefined,resolveCredential:()=>({binding,key:"synthetic-key"}),authorizations:new Map([["authorization:1",auth]]),localEvidence:new Map(),storage,now:()=>clock,rateIntervalMs:1,fetch:async(url,options)=>{calls.push({url,options});clock+=2;return Response.json({data:{type:"profile",id:"profile_1",attributes:{email:subject.email,external_id:subject.externalReference,subscriptions:{email:{marketing:{consent:"SUBSCRIBED",can_receive_email_marketing:true,suppression:[],list_suppressions:[]}}}}}});}};
const request={binding,audience,subjectReference:"opaque:1",requestId:"read:1",generation:1,deadlineMs:10000,authorizationReference:"authorization:1",operation:"consent.read",payload:{}};
const pending=factory(config);
assert.equal(pending.capabilities.operations["consent.read"].state,"verification_pending","P2 installed pending account evidence");
assert.equal((await pending.consent.read(request)).reason,"verification_pending");assert.equal(calls.length,0,"P2 unverified zero IO");
assert.deepEqual(Object.values(pending.newsletter.capabilities),Array(9).fill(false));assert.equal((await pending.newsletter.sync({})).status,"skipped");
config.verification={binding,audience,evidenceReference:"offline:synthetic",revision:"2026-07-15",operations:["consent.read"],scopes:["profiles:read"],noTrigger:{profile:false,accountWideGrant:false,doi:false},safeCreate:false,safeListRemoval:false,suppressionSafeAtEffect:false,negativeSourcesComplete:true,listMappings:{}};
const verified=factory(config),result=await verified.consent.read(request);
assert.equal(result.kind,"completed","P2 installed injected positive control");assert.equal(result.value.remoteConsent,"subscribed");assert(!Object.hasOwn(result.value,"localConsent"));
assert.equal(calls.length,1);assert.equal(calls[0].options.method,"GET");assert.equal(calls[0].options.redirect,"manual");
assert.equal(verified.consentPush.capabilities.operations["consent.push"].grantEffect,"account-wide");
`);
}

export function proveCommunicationsConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createInMemoryEmailTransport, createPostgresTransactionalDeliveryStore, resolveCapturedDocumentDelivery } from "@openlup/platform/communications";
import * as contracts from "@openlup/platform/communications/contracts";
import { timingSafeStringEqual } from "@openlup/platform/http";
assert.deepEqual(Object.keys(contracts).sort(), ["accentBox","button","createAbandonedCartContentFactory","createBackInStockContentFactory","createCheckoutExpiredContentFactory","createCheckoutRecoveryContentFactory","createInquiryContentFactory","createInvoiceDocumentContentFactory","createOptOutContentFactory","createOrderCanceledContentFactory","createOrderDraftContentFactory","createOrderPaidContentFactory","createOrderRefundedContentFactory","createPaymentFailedContentFactory","createReorderReminderContentFactory","createReturnEmailsContentFactory","createReviewEffectsContentFactory","createReviewRequestContentFactory","createRoleNotificationContentFactory","createShipmentDeliveredContentFactory","createShipmentDispatchedContentFactory","createShipmentExceptionContentFactory","createSubscriptionActivationActionRequiredContentFactory","createSubscriptionAddressChangedContentFactory","createSubscriptionCancelledContentFactory","createSubscriptionCycleSkippedContentFactory","createSubscriptionDeliveryRescheduledContentFactory","createSubscriptionPackageChangedContentFactory","createSubscriptionPauseReminderContentFactory","createSubscriptionPausedContentFactory","createSubscriptionPaymentExpiredContentFactory","createSubscriptionPaymentFailedContentFactory","createSubscriptionPaymentRecoveredContentFactory","createSubscriptionRenewalAtRiskContentFactory","createSubscriptionRenewalUpcomingContentFactory","createSubscriptionResumedContentFactory","createSubscriptionWelcomeContentFactory","createSubscriptionWinbackContentFactory","dataTable","divider","featureCard","guideCardBlock","heading","linkParagraph","list","paragraph","renderEmail"]);
// Optional peers are physically absent in this phase. Rendering must be pure.
const previousFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("contracts rendering must never fetch"); };
try {
  const rendered = contracts.renderEmail({ brand: { copyBrandName: "Example", theme: { bodyBg: "#fff", cardBg: "#fff", accentBg: "#eee", hairline: "#ccc", brand: "#123", onBrand: "#fff", textHeading: "#111", textBody: "#222", textMuted: "#555", fontFamily: "Arial", logoText: "Example", cardRadiusPx: 12, buttonRadiusPx: 8, maxWidthPx: 600 }, chrome: { pl: { logoAlt: "Example", footerTagline: "Polish footer" }, en: { logoAlt: "Example", footerTagline: "EN footer" } } }, locale: "en", subject: "Synthetic", blocks: [contracts.paragraph("<probe>"), contracts.button("Open", "https://example.invalid")] });
  assert.equal(rendered.subject, "Synthetic");
  assert(rendered.html.includes("&lt;probe&gt;"));
  assert(rendered.html.includes('href="https://example.invalid"'));
  assert.equal(rendered.text, "<probe>\\n\\nOpen: https://example.invalid\\n\\nEN footer");
  for (const locale of ["pl", "en"]) {
    const invoice = contracts.createInvoiceDocumentContentFactory().invoiceDocumentEmailContent(locale, { kind: "invoice", orderRef: "ORDER-1", documentNumber: "DOC/1", accountDocumentsUrl: "https://example.test/documents" });
    assert.equal(invoice.subject, locale === "pl" ? "Faktura do zamówienia ORDER-1" : "Invoice for order ORDER-1");
    assert.equal(invoice.blocks[3].href, "https://example.test/documents");
    const role = contracts.createRoleNotificationContentFactory().roleNotificationEmailContent(locale, { role: "admin", operatorUrl: "https://example.test/admin" });
    assert.equal(role.subject, locale === "pl" ? "Uprawnienia operatora: admin" : "Operator membership: admin");
    const inquiry = contracts.createInquiryContentFactory();
    const vars = { displayName: "Alex Example", contact: "alex@example.test", details: [], operatorUrl: "https://example.test/inquiry" };
    assert.equal(inquiry.inquiryReceiptEmailContent(locale, vars, "Team").subject, locale === "pl" ? "Otrzymaliśmy Twoje zapytanie" : "We've received your inquiry");
    assert.equal(inquiry.inquiryNoticeEmailContent(locale, vars, "Team").blocks[3].href, vars.operatorUrl);
    assert.equal(contracts.createOptOutContentFactory().optOutContent(locale, "error", "support@example.test").title, locale === "pl" ? "Błąd" : "Error");
  }
} finally { globalThis.fetch = previousFetch; }
assert(timingSafeStringEqual("synthetic", "synthetic"));
globalThis.fetch = () => { throw new Error("capture must never fetch"); };
const transport = createInMemoryEmailTransport();
assert.equal((await transport.send({ from: "sender@example.invalid", to: "recipient@example.invalid", subject: "Synthetic", html: "<p>Synthetic</p>" })).outcome.resendId, "in-memory-1");
assert.equal(transport.sent.length, 1);
assert.equal(resolveCapturedDocumentDelivery({}).refused, "document_delivery_channel_undeclared");
const store = createPostgresTransactionalDeliveryStore({ connectionString: "postgresql://unused.invalid/synthetic" });
let missingPeer;
await assert.rejects(() => store.readReceipt("synthetic:1"), error => {
  missingPeer = error;
  return error.message.startsWith("OPENLUP_E_PEER_MISSING: pg is required by ") && Boolean(error.cause);
});
for (const [factory,options,operation] of [
  ["createPostgresDeliveryReconciliationPort",{binding:"synthetic"},store=>store.findFrozenSends({now:"2026-10-19T12:00:00Z",graceMinutes:10,limit:1})],
  ["createPostgresCommunicationSyncStore",{binding:"synthetic",providerKind:"synthetic",rail:()=>{throw new Error("peer must fail first");}},store=>store.claimBatch({providerKind:"synthetic",batchSize:1,visibilitySeconds:60,maxAttempts:2})],
  ["createPostgresNotificationRecipientsPort",{operatorId:"synthetic"},store=>store.listNotificationRecipients({notification_type:"new_signup"})],
  ["createPostgresConsentEvaluator",{},store=>store.evaluate({email:"cold@example.invalid",purpose:"transactional"})],
]) {
  const module=await import("@openlup/platform/communications"), native=module[factory]({connectionString:"postgresql://unused.invalid/synthetic"},options);
  await assert.rejects(()=>operation(native),error=>{const refusal=error.name==="ConsentEvaluationUnavailableError"?error.cause:error;return refusal.message.startsWith("OPENLUP_E_PEER_MISSING: pg is required by ")&&Boolean(refusal.cause);});
  await assert.rejects(()=>native.close());
}
// No pool was created; closing repeats the cached initialization refusal.
await assert.rejects(() => store.close(), error => error === missingPeer);
`);
}

/** Sparse projected units are exercised in an owned disposable database only. */
export function proveCommunicationsPostgres(consumer: string, connectionString: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { COMMUNICATIONS_MIGRATIONS, createPostgresTransactionalDeliveryStore, createCapturedTransactionalDelivery, createTransactionalDelivery } from "@openlup/platform/communications";
const connectionString = process.argv[2], client = new pg.Client({ connectionString });
await client.connect();
try {
  for (const unit of COMMUNICATIONS_MIGRATIONS) await client.query(readFileSync(unit.url, "utf8"));
  const store = createPostgresTransactionalDeliveryStore({ connectionString });
  let deliveries = 0;
  const delivery = createCapturedTransactionalDelivery({ outcome: () => { deliveries++; return { state: "accepted" }; } });
  const action = createTransactionalDelivery({ store, delivery });
  const command = { idempotencyKey: "synthetic:receipt", recipientReference: "contact:1", templateReference: "template:1" };
  try {
    const first = await action.send(command);
    assert.equal(first.state, "accepted");
    assert.deepEqual(await action.send(command), first);
    assert.equal(deliveries, 1);
    await assert.rejects(() => action.send({ ...command, templateReference: "template:2" }), error => error.message === "transactional_delivery_command_conflict");
    await assert.rejects(() => client.query("SELECT * FROM public.communications_delivery_readiness($1)", ["11111111-1111-4111-8111-111111111111"]), error => error.message.includes("operator"));
    await client.query("SET ROLE anon");
    await assert.rejects(() => client.query("SELECT * FROM public.transactional_delivery_receipts"), error => error.code === "42501");
    await client.query("RESET ROLE");
  } finally { await store.close(); }
} finally { await client.end(); }
`, [connectionString]);
}

/** Useful installed native operations against a complete canonical catalogue installed by the reference runner. */
export function proveNativeCommunicationsOperations(consumer: string, connectionString: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createPostgresDeliveryReconciliationPort,createPostgresCommunicationSyncStore,createPostgresNotificationRecipientsPort,createPostgresConsentEvaluator,createGuardedEmailTransport,guardEmailTransport,createInMemoryEmailTransport,runCommunicationSyncDispatch } from "@openlup/platform/communications";
const env={connectionString:process.argv[2]},binding="cold-native";
const rail=db=>({
  claimBatch: async input=>(await db.query("SELECT * FROM public.outbox_claim_batch($1,$2,$3,$4,$5)",[input.eventTypes,input.knownEventTypes,input.batchSize,input.visibilitySeconds,input.maxAttempts])).rows,
  markProcessed: async input=>({applied:(await db.query("SELECT public.outbox_mark_processed($1,$2,'{}') AS value",[input.eventId,input.claimToken])).rows[0].value}),
  markFailed: async input=>({status:(await db.query("SELECT public.outbox_mark_failed($1,$2,$3,$4,$5,$6,$7,$8) AS value",[input.eventId,input.claimToken,input.error,input.outcome,input.baseDelaySeconds,input.maxDelaySeconds,input.maxAttempts,input.snoozeSeconds])).rows[0].value}),
});
const delivery=createPostgresDeliveryReconciliationPort(env,{binding}),sync=createPostgresCommunicationSyncStore(env,{binding,providerKind:"synthetic",rail});
const consent=createPostgresConsentEvaluator(env),directory=createPostgresNotificationRecipientsPort(env,{operatorId:"b3000000-0000-4000-8000-000000000001"});
try {
  const target={sourceKey:"cold:send",messageId:"network:cold",recipientEmail:"cold@example.invalid",templateReference:"synthetic",acceptedAt:"2026-10-19T10:00:00Z",evidence:"network_accepted"};
  const registered=await delivery.registerNetworkTarget(target);
  assert.equal(typeof registered.id,"string");
  assert.equal((await delivery.findFrozenSends({now:"2026-10-19T12:00:00Z",graceMinutes:10,limit:10}))[0]?.id,registered.id,"no-op store must refuse proof");
  assert.equal((await delivery.readEvidence(registered.id)).observedState,null,"acceptance is not delivery");
  assert.deepEqual(await delivery.findByMessageId(target.messageId),{id:registered.id},"selected message lookup must reach stored evidence");
  assert.equal((await delivery.listEvidence({limit:10})).some(row=>row.id===registered.id),true,"bounded evidence must include the actual target");
  await assert.rejects(()=>delivery.registerNetworkTarget({...target,sourceKey:"capture",messageId:"captured:1",evidence:"capture"}));
  await delivery.applyPolledEvent({sendId:registered.id,messageId:target.messageId,eventType:"delivered",eventAt:"2026-10-19T12:00:00Z",recipientEmail:target.recipientEmail});
  assert.equal((await delivery.readEvidence(registered.id)).observedState,"delivered");
  const work=await sync.registerWork({sourceKey:"cold:sync",contactId:"synthetic",normalizedEmail:target.recipientEmail,eventType:"subscribe",purpose:"marketing_newsletter"});
  const [claimed]=await sync.claimBatch({providerKind:"synthetic",batchSize:10,visibilitySeconds:60,maxAttempts:2});
  assert.equal(claimed?.id,work.id);
  assert.equal(await sync.markSent({eventId:work.id,claimToken:"wrong",providerKind:"synthetic"}),false,"wrong token must not settle");
  assert.equal(await sync.markSent({eventId:work.id,claimToken:claimed.claimToken,providerKind:"synthetic"}),true);
  assert.equal(await sync.markSent({eventId:work.id,claimToken:claimed.claimToken,providerKind:"synthetic"}),false);
  assert.deepEqual(await sync.claimBatch({providerKind:"synthetic",batchSize:10,visibilitySeconds:60,maxAttempts:2}),[],"second executor must see no settled work");
  await directory.createNotificationRecipient({email:"operator-recipient@example.invalid",name:"Synthetic",notification_type:"new_signup",active:true});
  const [recipient]=(await directory.listNotificationRecipients({notification_type:"new_signup"})).recipients;
  assert.equal(recipient.email,"operator-recipient@example.invalid");
  await directory.updateNotificationRecipient({recipientId:recipient.id,active:false});
  assert.equal((await directory.listNotificationRecipients({notification_type:"new_signup"})).recipients[0].active,false);
  await directory.deleteNotificationRecipient({recipientId:recipient.id});
  assert.deepEqual((await directory.listNotificationRecipients({notification_type:"new_signup"})).recipients,[]);
  const decision=await consent.evaluate({email:target.recipientEmail,purpose:"marketing_newsletter"});
  assert.equal(decision.allowed,false);assert.equal(typeof decision.decisionId,"string");
  assert.deepEqual(consent.guarantees,{managedFrequencyCaps:false,legacyContactTouching:false,sendTimeFence:false});
  const message={from:"sender@example.invalid",to:"intended@example.invalid",subject:"Synthetic",html:"<p>Synthetic</p>"};
  let effects=0;
  const raw={providerKind:"synthetic-raw",send:async()=>{effects++;throw Error("raw adapter must refuse before effect");}};
  assert.equal((await guardEmailTransport(raw).send(message)).outcome.ok,false);assert.equal(effects,0);
  for(const providerKind of ["synthetic-a","synthetic-b"]){
    const transport=createGuardedEmailTransport({providerKind,policy:intendedRecipient=>({mode:"sandbox_sink",reason:"synthetic_sink",intendedRecipient,recipient:"sink@example.invalid",credential:"synthetic",environmentTag:"non_production"}),send:async(selected,context)=>{
      assert.equal(selected.to,"sink@example.invalid");assert.equal(context.intendedRecipient,message.to);assert.equal(context.environmentTag,"non_production");effects++;
      return {outcome:{ok:true,resendId:"network:"+providerKind,httpStatus:202,providerError:null,aborted:false},providerResponse:{accepted:true}};
    }});
    const result=await guardEmailTransport(transport).send(message);
    assert.equal(result.outcome.ok,true);assert.equal(result.outcome.egressMode,"sandbox_sink");
    const acceptance=await delivery.registerNetworkTarget({...target,sourceKey:providerKind,messageId:result.outcome.resendId});
    assert.equal((await delivery.readEvidence(acceptance.id)).observedState,null);
  }
  await createInMemoryEmailTransport().send(message);assert.equal(effects,2,"capture must not call the network sender");
  let membershipEffects=0;
  const selectedProvider={providerKind:"synthetic",capabilities:{subscribe:true,unsubscribe:true,suppress:true,unsuppress:false,doubleOptIn:false,emailChange:false,listMembership:false,webhookIdempotency:false,retryAfter:false},sync:async event=>{assert.equal(event.normalizedEmail,target.recipientEmail);membershipEffects++;return {status:"sent"};}};
  await sync.registerWork({sourceKey:"cold:substitute",contactId:"synthetic-substitute",normalizedEmail:target.recipientEmail,eventType:"unsubscribe",purpose:"marketing_newsletter"});
  assert.equal((await runCommunicationSyncDispatch({store:sync,provider:selectedProvider})).sent,1);
  assert.equal((await runCommunicationSyncDispatch({store:sync,provider:selectedProvider})).checked,0);
  assert.equal(membershipEffects,1);assert.equal((await consent.evaluate({email:target.recipientEmail,purpose:"marketing_newsletter"})).allowed,false,"provider settlement must not grant permission");
} finally {await Promise.all([delivery.close(),sync.close(),consent.close(),directory.close()]);}
`, [connectionString]);
}

/** Installed adapter with the complete native catalogue and an explicitly granted invoker role. */
export function proveOperationsPostgres(consumer: string, connectionString: string): void {
  const operator="b4000000-0000-4000-8000-000000000001";
  const setup=consumerNode(consumer,`
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresGatewayTypeOverrides } from "@openlup/platform/data";
import { createPlatformControlPlanePort, runControlPlaneWatchdogTick, OPERATIONS_MIGRATIONS } from "@openlup/platform/operations/server";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
assert.equal(createHash("sha256").update(readFileSync(OPERATIONS_MIGRATIONS.native.units[0].url)).digest("hex"),OPERATIONS_MIGRATIONS.native.units[0].sha256);
const client=new pg.Client({connectionString:process.argv[2],types:createPostgresGatewayTypeOverrides(pg.TypeOverrides)});await client.connect();
const operator=process.argv[3],inactive="b4000000-0000-4000-8000-000000000002";
async function snapshot(){return (await client.query("SELECT jsonb_build_object('controls',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('rowVersion',xmin::text) ORDER BY control_key) FROM public.platform_operational_controls t),'operations',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('rowVersion',xmin::text) ORDER BY idempotency_key) FROM public.platform_control_operations t),'heartbeat',(SELECT to_jsonb(t)||jsonb_build_object('rowVersion',xmin::text) FROM public.platform_job_controls t WHERE job_name='platform-watchdog')) AS state")).rows[0].state;}
try {
  await client.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true),($2,false)",[operator,inactive]);
  await client.query("CREATE ROLE operations_runtime NOLOGIN; CREATE ROLE operations_denied NOLOGIN; GRANT USAGE ON SCHEMA public TO operations_runtime; GRANT SELECT ON public.platform_control_operators,public.platform_alerts TO operations_runtime; GRANT SELECT,INSERT,UPDATE ON public.platform_operational_controls,public.platform_control_operations,public.platform_job_controls TO operations_runtime; GRANT EXECUTE ON FUNCTION public.platform_control_operator_is_active(uuid),public.platform_control_require_operator(uuid),public.platform_control_set_control(uuid,text,text,text,boolean),public.platform_control_record_heartbeat(uuid,text,text,text,integer,text,boolean),public.platform_control_list_controls(uuid),public.platform_control_list_jobs(uuid),public.platform_control_list_alerts(uuid) TO operations_runtime");
  const before=await snapshot();
  await client.query("SET ROLE operations_denied");
  assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,"operations_denied");
  const denied=createPlatformControlPlanePort(client,operator);
  await assert.rejects(denied.mutateControlPlane({action:"set-control",idempotencyKey:"denied",controlKey:"jobs.enabled",enabled:true}),{name:"PlatformControlPlaneUnavailableError"});
  await assert.rejects(client.query("UPDATE public.platform_operational_controls SET enabled=false"),{code:"42501"});
  await client.query("RESET ROLE");assert.deepEqual(await snapshot(),before);
  await client.query("SET ROLE operations_runtime");
  assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,"operations_runtime");
  const port=createPlatformControlPlanePort(client,operator);
  const command={action:"set-control",idempotencyKey:"m14-control",controlKey:"jobs.enabled",enabled:true};
  const first=await port.mutateControlPlane(command);assert.equal(first.replayed,false);assert.equal(first.revision,1);
  const settled=await snapshot();
  assert.deepEqual(await port.mutateControlPlane(command),{...first,replayed:true});assert.deepEqual(await snapshot(),settled);
  await assert.rejects(port.mutateControlPlane({...command,enabled:false}),{name:"PlatformControlPlaneConflictError"});assert.deepEqual(await snapshot(),settled);
  await assert.rejects(createPlatformControlPlanePort(client,inactive).mutateControlPlane({...command,idempotencyKey:"inactive"}),{name:"PlatformControlPlaneUnavailableError"});assert.deepEqual(await snapshot(),settled);
  // Grants are confined to operations. A neighboring domain write still refuses.
  await assert.rejects(client.query("UPDATE public.subscriptions SET cadence_days=cadence_days"),{code:"42501"});
  const revised=await port.mutateControlPlane({...command,idempotencyKey:"m14-control-2",enabled:false});assert.equal(revised.revision,2);
  assert.deepEqual((await port.readControlPlane({})).controls,[{controlKey:"jobs.enabled",enabled:false,revision:2,updatedAt:revised.recordedAt}]);
  const dryBefore=await snapshot();await runControlPlaneWatchdogTick(port,new Date("2026-10-26T12:00:00Z"),true);assert.deepEqual(await snapshot(),dryBefore);
  const heartbeat={action:"record-heartbeat",idempotencyKey:"m14-heartbeat",health:"degraded",firingCount:1,maxSeverity:"p1",promotionReady:false};
  const beat=await port.mutateControlPlane(heartbeat);assert.equal(beat.replayed,false);assert.equal(beat.revision,null);
  const durable=await snapshot();
  assert.equal(durable.heartbeat.last_status,"success");assert.equal(durable.heartbeat.active_driver,"operator");
  assert.equal(durable.heartbeat.last_success_at,beat.recordedAt);assert.deepEqual(durable.heartbeat.metadata,{health:"degraded",firingCount:1,maxSeverity:"p1",promotionReady:false});
  assert.deepEqual(await port.mutateControlPlane(heartbeat),{...beat,replayed:true});assert.deepEqual(await snapshot(),durable);
  await assert.rejects(port.mutateControlPlane({...heartbeat,firingCount:2}),{name:"PlatformControlPlaneConflictError"});assert.deepEqual(await snapshot(),durable);
  process.stdout.write(JSON.stringify({first,beat,durable}));
} finally {await client.query("RESET ROLE");await client.end();}
`,[connectionString,operator]);
  const expected=JSON.parse(setup);
  // A second independent consumer process reconstructs the adapter against the same durable state.
  const restarted=consumerNode(consumer,`
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresGatewayTypeOverrides } from "@openlup/platform/data";
import { createPlatformControlPlanePort } from "@openlup/platform/operations/server";
const client=new pg.Client({connectionString:process.argv[2],types:createPostgresGatewayTypeOverrides(pg.TypeOverrides)});await client.connect();
try {
  await client.query("SET ROLE operations_runtime");assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,"operations_runtime");
  const port=createPlatformControlPlanePort(client,process.argv[3]);
  const first=await port.mutateControlPlane({action:"set-control",idempotencyKey:"m14-control",controlKey:"jobs.enabled",enabled:true});
  const beat=await port.mutateControlPlane({action:"record-heartbeat",idempotencyKey:"m14-heartbeat",health:"degraded",firingCount:1,maxSeverity:"p1",promotionReady:false});
  const durable=(await client.query("SELECT jsonb_build_object('controls',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('rowVersion',xmin::text) ORDER BY control_key) FROM public.platform_operational_controls t),'operations',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('rowVersion',xmin::text) ORDER BY idempotency_key) FROM public.platform_control_operations t),'heartbeat',(SELECT to_jsonb(t)||jsonb_build_object('rowVersion',xmin::text) FROM public.platform_job_controls t WHERE job_name='platform-watchdog')) AS state")).rows[0].state;
  process.stdout.write(JSON.stringify({first,beat,durable}));
} finally {await client.query("RESET ROLE");await client.end();}
`,[connectionString,operator]);
  const actual=JSON.parse(restarted);
  assert.deepEqual(actual,{first:{...expected.first,replayed:true},beat:{...expected.beat,replayed:true},durable:expected.durable});
  console.log("Operations installed native proof PASS (explicit invoker role, denied neighbor, durable replay/conflict/checkOnly/process restart)");
}

/** Selected-row recovery from installed bytes against the already-owned canonical database. */
export function provePortabilityPostgres(consumer: string, connectionString: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {captureCompatiblePostgresRows,restoreCompatiblePostgresRows} from "@openlup/platform/portability";
const client=new pg.Client({connectionString:process.argv[2]});await client.connect();
const id=randomUUID(),key="installed-transfer:"+id,catalogueId="owned-canonical-install";
async function transaction(readOnly,work){await client.query(readOnly?"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY":"BEGIN");try{const result=await work(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}}
try{
 const ledger=await client.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position");
 const acl=await client.query("SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname");
 const payload='{"large":9007199254740993}';
 await client.query("INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts) VALUES($1,'synthetic',$1,'synthetic.transfer',$2,$3::jsonb,'processing',3)",[id,key,payload]);
 const before=(await client.query("SELECT to_jsonb(t)::text AS value FROM public.outbox_events t WHERE id=$1",[id])).rows;
 const packet=await captureCompatiblePostgresRows({source:{withSnapshot:work=>transaction(true,work)},sourceId:"owned-installed-source",catalogueId,tables:["outbox_events"],maximumRows:1000,maximumBytes:4194304});
 const input={target:{withTransaction:work=>transaction(false,work)},catalogueId,packet};
 assert.equal((await restoreCompatiblePostgresRows(input)).inserted,0);
 // Owned fixture loss: recover the exact retained row without resetting its
 // in-flight status, attempts, original key or precision-bearing payload.
 await client.query("DELETE FROM public.outbox_events WHERE id=$1",[id]);
 assert.equal((await restoreCompatiblePostgresRows(input)).inserted,1);
 assert.deepEqual((await client.query("SELECT to_jsonb(t)::text AS value FROM public.outbox_events t WHERE id=$1",[id])).rows,before);
 const retained=(await client.query("SELECT xmin::text AS version FROM public.outbox_events WHERE id=$1",[id])).rows;
 assert.equal((await restoreCompatiblePostgresRows(input)).inserted,0);
 assert.deepEqual((await client.query("SELECT xmin::text AS version FROM public.outbox_events WHERE id=$1",[id])).rows,retained);
 await client.query("UPDATE public.outbox_events SET attempts=4 WHERE id=$1",[id]);
 await assert.rejects(restoreCompatiblePostgresRows(input),{code:"target_conflict"});
 assert.deepEqual((await client.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position")).rows,ledger.rows);
 assert.deepEqual((await client.query("SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows,acl.rows);
 console.log("Portability installed canonical selected-row recovery PASS");
}finally{await client.query("DELETE FROM public.outbox_events WHERE id=$1",[id]);await client.end();}
`, [connectionString]);
}

/** Setup uses the existing canonical runner; subjects resolve only from installed artifacts. */
function proveNativeCommunicationsPostgres(consumer: string): void {
  const started = performance.now();
  const name = `openlup-native-proof-${randomUUID()}`;
  const docker = (args: string[]) => command("docker", args, root, isolatedConsumerEnv()).trim();
  try {
    // Complete catalogue fingerprints use the repository harness's PostgreSQL 16 profile.
    docker(["run",...disposableLabelArgs(),"--detach","--rm","--name",name,"--cpus=1","--memory=512m","--pids-limit=128","--tmpfs","/var/lib/postgresql/data","--publish","127.0.0.1::5432","--env","POSTGRES_HOST_AUTH_METHOD=trust","postgres:16"]);
    const port = docker(["port",name,"5432/tcp"]).split(":").at(-1)!;
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    // Host TCP readiness, through the same repository harness as the real-PG witness.
    const schemaObservation = JSON.parse(command(process.execPath,["--import",import.meta.resolve("tsx"),"--input-type=module","-e",`
      import { waitForPostgresTcpReady } from ${JSON.stringify(pathToFileURL(join(root,"tests/helpers/postgresContainer.ts")).href)};
      import { createPostgresMigrationRunner } from ${JSON.stringify(pathToFileURL(join(root,"server/adapters/postgres/migrationRunner.ts")).href)};
      import pg from "pg";
      const connectionString=process.argv[1];
      if(!await waitForPostgresTcpReady(connectionString))throw new Error("Native cold PG unavailable");
      const runner=createPostgresMigrationRunner({connectionString});await runner.apply();
      const observed=await runner.status();
      if(observed.pending.length || !observed.applied.length)throw new Error("Incomplete application upgrade schema");
      const client=new pg.Client({connectionString});await client.connect();
      try {
        await client.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ('b3000000-0000-4000-8000-000000000001','admin@example.invalid')");
        await client.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ('b3000000-0000-4000-8000-000000000001','admin','active','legacy',now())");
        await client.query("INSERT INTO public.platform_communication_operators(principal_id) VALUES ('b3000000-0000-4000-8000-000000000001')");
      } finally {await client.end();}
      process.stdout.write(JSON.stringify({schemaVersion:observed.applied.length}));
      process.exit(0);
    `,connectionString],root,isolatedConsumerEnv()));
    proveApplicationUpgradePostgres(consumer,connectionString,schemaObservation.schemaVersion);
    proveNativeCommunicationsOperations(consumer,connectionString);
    proveOperationsPostgres(consumer,connectionString);
    provePortabilityPostgres(consumer,connectionString);
  } finally {docker(["rm","--force",name]);}
  console.log(`Native communications installed proof PASS (PostgreSQL 16, complete canonical catalogue; ${Math.round(performance.now()-started)} ms including setup/cleanup)`);
}

// Like the outbox proof: the trusted job service when CI supplies its identity, otherwise an owned
// labelled container; a unique database either way, and no skip when neither is available.
function proveDockerPostgres(consumer: string, environment: NodeJS.ProcessEnv): void {
  const service = environment.OPENLUP_PROOF_SERVICE_CONTAINER, servicePort = environment.OPENLUP_PROOF_SERVICE_PORT;
  if (Boolean(service) !== Boolean(servicePort) || (service && (!/^[a-f0-9]{12,64}$/u.test(service) || !/^\d{1,5}$/u.test(servicePort!) || Number(servicePort) < 1 || Number(servicePort) > 65535))) {
    throw new Error("Missing or malformed job-service identity");
  }
  const docker = (args: string[]) => command("docker", args, root, isolatedConsumerEnv()).trim();
  const owner = randomUUID(), name = `openlup-platform-proof-${owner}`, database = `openlup_platform_proof_${owner.replaceAll("-", "")}`;
  let container: string | undefined, ownedContainer = false, createdDatabase = false;
  try {
    if (service) {
      // Identity comes from job.services, not an ambient port or URL. Require the pinned image.
      const info = JSON.parse(docker(["inspect", service]))[0];
      if (info?.Id !== service || info?.Config?.Image !== POSTGRES_PROOF_IMAGE || !info?.State?.Running
        || !info?.NetworkSettings?.Ports?.["5432/tcp"]?.some((binding: { HostPort: string }) => binding.HostPort === servicePort)) {
        throw new Error("Job service is not the exact pinned running container/port");
      }
      container = service;
    } else {
      ownedContainer = true;
      container = docker(["run", "--detach", "--rm", "--name", name, "--label", `openlup-proof=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
    }
    docker(["exec", container, "sh", "-c", "for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -U postgres -t 1 && exit 0; sleep 1; done; exit 1"]);
    const port = servicePort ?? docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
    createdDatabase = true; // Only this run's unique name, including a lost CREATE response.
    docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${database}`]);
    // Roles are cluster-wide; create the three the gateway assumes only when they are absent.
    docker(["exec", container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-c",
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END $$;"]);
    provePostgresOperations(consumer, `postgresql://postgres@127.0.0.1:${port}/${database}`);
    proveCommunicationsPostgres(consumer, `postgresql://postgres@127.0.0.1:${port}/${database}`);
    consumerNode(consumer, adapterOperations + `
const operations = postgresOperations(process.argv[2]);
// The appended identity adapters also require their migrated schema.
for (const index of [6, 7, 8, 9, 10]) {
  await assert.rejects(operations[index], error => error.code === "42P01");
}
process.exit(0);
`, [`postgresql://postgres@127.0.0.1:${port}/${database}`]);
    proveNativeCommunicationsPostgres(consumer);
    console.log(`Platform PostgreSQL SQL conformance PASS (${service ? "job service" : "owned container"}, database ${database})`);
  } finally {
    if (service && createdDatabase) docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
    if (ownedContainer) docker(["rm", "--force", name]);
  }
}

/** SDK-absent catalog operations and inert structural contribution, reused by the selected P7 case. */
export function proveCatalogCompositionConsumer(consumer: string) {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as catalog from "@openlup/platform/catalog";
import { createCatalogContribution } from "@openlup/platform/composition";
const statements = [];
const executor = { query: async (sql, values) => { statements.push([sql, values]); return { rows: [] }; } };
const native = catalog.createPostgresCatalogSkuEnvelopeReadPort(executor);
assert.deepEqual(await native.listActiveSkuEnvelopes({ cursor: null, limit: 1, skuCodes: ["P7-UNIT"] }), { items: [], nextCursor: null });
assert.equal(statements.length, 1);
await assert.rejects(native.getSkuEnvelope({ kind: "sku_code", skuCode: "ABSENT" }), error => error instanceof catalog.CatalogSkuAuthorityError && error.code === "catalog_sku_authority_sku_absent");
const draft = catalog.createPostgresCatalogDraftStore({ query: async () => { throw { code: "42501" }; } });
assert.deepEqual(await draft.apply({ canonicalCommand: "{}", fingerprint: "a".repeat(64), actorId: "synthetic" }), { outcome: "unauthorized", reason: "operator_required" });
assert.deepEqual(catalog.CATALOG_MIGRATIONS.map(unit => unit.position), [1,8,58,59,61]);
for (const unit of catalog.CATALOG_MIGRATIONS) assert.equal(createHash("sha256").update(readFileSync(unit.url)).digest("hex"), unit.sha256);
const quote = () => { throw new Error("synthetic_quote_unavailable"); };
const selected = createCatalogContribution({ version: JSON.parse(readFileSync(new URL("./node_modules/@openlup/platform/package.json", import.meta.url))).version, requiredSchema: { version: "complete", migration: "complete", objects: [] },
  catalog: { read: native.getSkuEnvelope, draft: draft.apply }, pricing: { quote }, promotions: {}, routes: [] });
assert.equal(selected.ports["@openlup/platform/catalog:read"], native.getSkuEnvelope);
assert.equal(selected.ports["@openlup/platform/catalog:draft"], draft.apply);
assert.equal(selected.ports["@openlup/platform/pricing:quote"], quote);
assert.throws(selected.ports["@openlup/platform/pricing:quote"], /synthetic_quote_unavailable/);
assert.deepEqual(selected.contributions.map(item => item.manifest.module.id), ["catalog", "pricing", "promotions"]);
`);
}

/** Copy only the actual host composition; all package imports resolve installed bytes. */
export function installA1HostBinding(consumer: string, checkout = root): void {
  for (const relative of ["communications/a1ReferenceBinding", "communications/referenceComposition", "communications/communicationsSchema", "outbox/candidateAdmission"]) {
    const target = join(consumer, "server/runtime", relative + ".js");
    mkdirSync(dirname(target), { recursive: true });
    const source = readFileSync(join(checkout, "server/runtime", relative + ".ts"), "utf8");
    writeFileSync(target, stripTypeScriptTypes(source));
  }
}

/** Uses the same SDK-absent installed-consumer runner as the adapter proofs. */
export function proveA1ReferenceBindingConsumer(consumer: string, phase: "imports" | "selection"): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const bindingUrl = new URL("./server/runtime/communications/a1ReferenceBinding.js", import.meta.url);
const source = readFileSync(bindingUrl, "utf8");
// No absolute/checkout fallback may coexist with successful installed resolution.
for (const [, specifier] of source.matchAll(/\\b(?:from\\s*|import\\s*\\()\\s*["']([^"']+)["']/g)) {
 if (specifier.startsWith("@openlup/")) assert(fileURLToPath(import.meta.resolve(specifier)).startsWith(process.cwd() + "/node_modules/"), "P3 installed resolution");
 assert(!specifier.startsWith("/") && !specifier.startsWith("file:"), "P3 checkout fallback");
}
globalThis.fetch = () => { throw Error("ambient network forbidden"); };
const { createA1ReferenceBinding } = await import(bindingUrl.href);
let loads = 0, posts = 0, clocks = 0, credentials = 0;
assert.equal(await createA1ReferenceBinding(), undefined);
assert.equal(await createA1ReferenceBinding({ enabled:false, loadHostInputs:()=>{loads++;throw Error("eager");} }), undefined);
assert.equal(loads, 0);
const candidate = {artifact:"synthetic",configuration:"selected",environment:"disposable",database:"synthetic",schema:"70"};
const binding = {account:"synthetic",environment:"disposable",namespace:"cold",mappingVersion:"1"};
const values = new Map();
const host = {
 migrationIdentity:"70", admission:{candidate,currentIdentity:()=>candidate,
 observed:{loadedPackages:[{name:"@openlup/core",version:"0.17.0",kind:"kernel"},{name:"@openlup/platform",version:"0.17.0",kind:"rail"}],inventoryComplete:true},
 schemaProbe:{observe:async required=>({database:"synthetic",version:"70",objects:required.objects.map(object=>({object,present:true}))})}},
 sender:{environmentTagName:"host_env",policy:to=>({mode:"sandbox_sink",reason:"synthetic",intendedRecipient:to,recipient:"sink@example.invalid",credential:"synthetic",environmentTag:"non_production"}),fetch:async()=>{posts++;return Response.json({id:"cold"});}},
 callback:{environmentTagName:"host_env",webhookSecret:"synthetic",port:{findSend:async()=>null,applyObservation:async()=>{throw Error("unexpected callback");},recordAttempt:async()=>{}}},
 marketing:{binding,audience:{kind:"account-wide"},subjectMapper:()=>undefined,resolveCredential:()=>{credentials++;return undefined;},authorizations:new Map(),localEvidence:new Map(),
 storage:{availability:{account:binding.account,environment:binding.environment,busy:false,quarantined:true},get:async key=>values.get(key)??null,compareAndSwap:async()=>{throw Error("unexpected storage");}},now:()=>{clocks++;return 1;}},
 delivery:{database:{connectionString:"postgresql://unused.invalid/cold"},options:{binding:"synthetic"},resolveCredential:()=>{throw Error("unselected credential");},now:()=>{throw Error("unselected clock");},limit:1,graceMinutes:45}
};
const unselected = await createA1ReferenceBinding({enabled:true,loadHostInputs:()=>host});
assert.equal(unselected.admitted,true,"P3 installed admission");
assert.deepEqual(unselected.runtime.routes,[],"P3 empty default routes");assert.deepEqual(unselected.runtime.schedules,[],"P3 empty default schedules");assert.deepEqual(unselected.runtime.handlers,[],"P3 empty default handlers");
assert.equal(unselected.ports.marketing.capabilities.operations["profile.sync"].state,"verification_pending");
assert.deepEqual(await unselected.ports.marketing.newsletter.sync({}),{status:"skipped",reason:"unsupported"});
assert.equal(posts+clocks+credentials,0,"P3 no unselected effects");
if (${JSON.stringify(phase)} === "selection") {
 let selected;
 host.select=ports=>{selected=ports;return {routes:[{id:"/synthetic",handle:ports.webhook}],schedules:[{id:"synthetic",cadenceSeconds:60,run:ports.reconcile}],handlers:[]};};
 const active = await createA1ReferenceBinding({enabled:true,loadHostInputs:()=>host});
 assert.equal(active.ports,selected,"P3 exact selected ports");
 for (const [key,value] of Object.entries(selected)) assert.equal(active.runtime.ports[key],value,"P3 exact admitted callable");
 assert.equal(active.runtime.routes.length,1);assert.equal(active.runtime.schedules.length,1);assert.deepEqual(active.runtime.handlers,[]);
 assert.equal(active.runtime.routes[0].handle,selected.webhook,"P3 exact selected route");assert.equal(active.runtime.schedules[0].run,selected.reconcile,"P3 exact selected schedule");
 const { guardEmailTransport } = await import("@openlup/platform/communications");
 const transport = guardEmailTransport(selected.transport);
 assert.equal(transport,selected.transport,"P3 existing transport injection seam");
 assert.equal((await transport.send({from:"sender@example.invalid",to:"reader@example.invalid",subject:"Synthetic",html:"<p>Notice</p>"})).outcome.ok,true);
 assert.equal(posts,1,"P3 single sender");
 assert.deepEqual(Object.keys(active.ports).sort(),["marketing","reconcile","transport","webhook"]);
 assert(!/subscription|claimBatch|setInterval|setTimeout/.test(source),"P3 no second executor or subscription writer");
}
`);
}

export function runPlatformColdConsumer(checkout = root, environment = processEnvironment): void {
  const manifest = environment.OPENLUP_PACK_MANIFEST, commit = environment.OPENLUP_PACK_COMMIT;
  if (!manifest || !commit || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Missing or malformed OPENLUP_PACK_MANIFEST / OPENLUP_PACK_COMMIT");
  const packs = readCurrentPackManifest(checkout, resolve(manifest), commit); // Refuse before install or service startup.
  const inputs = ["@openlup/core", "@openlup/platform"].map(name => {
    const pack = packs.get(name);
    if (!pack) throw new Error(`Verified manifest has no ${name} tarball (platform must be publishable in the package inventory)`);
    return pack;
  });
  const consumer = mkdtempSync(join(tmpdir(), "openlup-platform-consumer-"));
  try {
    const lock = JSON.parse(readFileSync(join(checkout, "package-lock.json"), "utf8"));
    const locked = (name: string): string => {
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof version !== "string") throw new Error(`Missing locked consumer input: ${name}`);
      return `${name}@${version}`;
    };
    const artifacts = join(consumer, "packs"); mkdirSync(artifacts);
    const tarballs = inputs.map(pack => {
      const bytes = readFileSync(pack.path);
      if (createHash("sha256").update(bytes).digest("hex") !== pack.sha256 || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pack.integrity) throw new Error(`Verified artifact changed before use: ${pack.name}`);
      const target = join(artifacts, `${pack.name.split("/")[1]}.tgz`); writeFileSync(target, bytes); return target;
    });
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "platform-cold-consumer", private: true, type: "module" }));
    // The SDK-absent phase uses only npm's default cache. Legacy peer mode prevents automatic peer installs;
    // physical and independent resolution checks below prove what omission flags cannot.
    const install = (packages: string[], sdkPresent = false) => process.stdout.write(command("npm", ["install", sdkPresent ? "--prefer-offline" : "--offline", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps", "--no-audit", "--fund=false", ...packages], consumer, isolatedConsumerEnv()));
    // The offline phase installs only local tarballs: npm ci caches the lockfile's tarballs but not their
    // registry metadata, so a cold runner cannot resolve version specs offline. Pack the locked runtime and
    // type inputs from the root's installed directories, as the Outbox proof does.
    const packInstalled = (name: string): string => {
      const directory = join(checkout, "node_modules", name);
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`Consumer input ${name} must be an ordinary installed directory`);
      const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
      if (`${name}@${version}` !== locked(name)) throw new Error(`Consumer input ${name} differs from the lockfile`);
      const [info] = JSON.parse(command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], directory, isolatedConsumerEnv()));
      return join(artifacts, info.filename);
    };
    install([...tarballs, ...["zod", "@types/node", "undici-types"].map(packInstalled)]);
    assertConsumerIsolation(consumer, checkout);
    assertExportInventory(consumer);
    for (const entry of NON_ADAPTER_ENTRIES) consumerNode(consumer, `await import("@openlup/platform/${entry}");`);
    consumerNode(consumer, `
import assert from "node:assert/strict";
import * as catalog from "@openlup/platform/catalog";
import * as contracts from "@openlup/platform/catalog/contracts";
assert.equal(catalog.CatalogSkuAuthorityError, contracts.CatalogSkuAuthorityError);
assert.equal(catalog.canonicalCatalogDraftJson, contracts.canonicalCatalogDraftJson);
assert.equal(contracts.canonicalCatalogDraftJson({z:2,a:1}), '{"a":1,"z":2}');
assert.throws(() => contracts.canonicalCatalogDraftJson({value:NaN}), /draft_json_invalid/);
assert.throws(() => contracts.requireCurrentCatalogDocumentAuthority("product", null, null), contracts.CatalogSkuAuthorityError);
assert.deepEqual(catalog.parseCatalogActiveSkuSelection([" ITEM-1 "]), ["ITEM-1"]);
assert.throws(() => catalog.parseCatalogActiveSkuSelection(["ITEM-1", " ITEM-1 "]), /catalog_active_sku_selection_invalid/);
const handler = catalog.createCatalogDraftHandler({ store: {}, registry: {}, authorizeOperator: async () => null });
assert.deepEqual(await handler.execute({}, {}), { outcome: "unauthorized", reason: "draft_operator_required" });
// Catalog imports without pg: the native read store uses only the supplied executor.
const statements = [];
const native = catalog.createPostgresBundleCatalogStore({ query: async (sql, values) => { statements.push([sql, values]); return { rows: [] }; } });
assert.deepEqual(await native.listBundles({ status: "all", limit: 10, offset: 0 }), { bundles: [], total: 0 });
assert.equal(await native.getBundle({ code: "absent" }), null);
assert.deepEqual(await native.listActiveBundleCompositions(), []);
assert.deepEqual(await native.listBundleHistory({ code: "absent", limit: 10, offset: 0 }), { events: [], total: 0 });
assert.equal(statements.length, 6);
assert.deepEqual(catalog.BUNDLE_MIGRATIONS.map(unit => unit.position), [16, 19]);
await assert.rejects(() => catalog.createPostgresBundleCatalogStore({ query: async () => { throw Error("synthetic read failure"); } }).getBundle({ code: "absent" }), catalog.BundleCatalogReadError);
const composition = { code: "fixed-set", title: "Fixed set", fulfillmentMode: "virtual", currency: "XXX", targetPriceMinor: 2001, mode: "one_time",
  components: [
    { sku: "UNIT-A", title: "Unit A", productSlug: "unit-a", variantId: "variant-a", quantity: 2, isAddon: false, sortOrder: 0, referenceUnitPriceMinor: 1000 },
    { sku: "UNIT-B", title: "Unit B", productSlug: "unit-b", variantId: "variant-b", quantity: 1, isAddon: true, sortOrder: 1, referenceUnitPriceMinor: 500 },
  ] };
assert.deepEqual(catalog.evaluateBundleComposition(composition.components), { ok: true, violations: [] });
assert.deepEqual(catalog.evaluateBundleComposition([composition.components[0], composition.components[0]]), { ok: false, violations: ["DUPLICATE_COMPONENT"] });
const { deriveBundleAvailability } = catalog.createBundleAvailability({
  offerAvailabilityStatusFor: (value, threshold) => value === null ? "unknown" : value <= 0 ? "out_of_stock" : value <= threshold ? "low_stock" : "available",
  offerAvailabilityReasonCode: status => status,
});
const { createBundleAvailabilityService } = catalog.createBundleAvailabilityServices({ deriveBundleAvailability });
const rows = await createBundleAvailabilityService({ bundleCatalogReadPort: { listActiveBundleCompositions: async () => [composition] }, offerAvailabilityPort: catalog.createUnknownOfferAvailabilityPort() }).describeActiveBundles();
assert.equal(rows[0].availability.sellableNow, null);
const bundle = catalog.toSellableBundle(rows[0].composition, rows[0].availability);
assert.deepEqual(bundle.components.map(line => line.lineSubtotalMinor), [801, 800, 400]);
assert.equal(bundle.components.reduce((sum, line) => sum + line.lineSubtotalMinor, 0), 2001);
for (const line of bundle.components) assert.equal(line.effectiveUnitPriceMinor * line.quantity, line.lineSubtotalMinor);
assert.equal("createBundleAvailability" in contracts, false);
assert.equal("createAdminBundleHandlers" in contracts, false);

`);
    consumerNode(consumer, `
import assert from "node:assert/strict";
import * as pricing from "@openlup/platform/pricing";
import * as contracts from "@openlup/platform/pricing/contracts";
assert.equal(pricing.OFFER_POLICY_V2, contracts.OFFER_POLICY_V2);
assert.equal(contracts.ACQUISITION_TERMS_CAPABILITY, "subscription-acquisition.v1");
assert.equal(contracts.COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, "commerce.offer-pricing.v3");
assert.equal("selectAcquisitionTerms" in contracts, false);
assert.throws(() => pricing.selectAcquisitionTerms([], "2026-10-01T00:00:00Z", "ZZ", undefined),
  error => error instanceof pricing.AcquisitionTermsError && error.reason === "acquisition_terms_policy_unconfigured");
assert.equal(pricing.acquisitionExpectationChanged(undefined, undefined), false);
assert.equal(pricing.acquisitionExpectationChanged({ revision: "example-a", delivery2DiscountBps: 1700 }, undefined), true);
assert.deepEqual(pricing.acquisitionQuoteBinding(), {});
assert.equal(contracts.COMMERCE_CONTRACT_VERSION, "commerce.v0");
assert.equal("createCommerceQuoteSchemas" in contracts, false);
assert.equal("catalogFactsProvenanceSchema" in contracts, false);
assert.deepEqual(pricing.splitIncludedVat(12300, 2300), { netMinor: 10000, vatMinor: 2300 });
assert.deepEqual(pricing.calculateIncludedVat(12300, 2300), { netMinor: 10000, vatMinor: 2300 });
assert.equal(contracts.COMMERCE_OFFER_PRICING_CONTRACT_VERSION, "commerce.offer-pricing.v1");
assert.equal("createCommerceOfferPricingHandler" in contracts, false);
const readiness = pricing.createOfferPolicyReadinessCache({ now: () => 0 });
assert.equal((await readiness.read({ readOfferPolicyV2Readiness: async () => ({ ready: true }) })).ready, false);
const cache = pricing.createCommerceOfferPricingCache({ ttlMs: 10, now: () => 0 });
const value = { contractVersion: contracts.COMMERCE_OFFER_PRICING_CONTRACT_VERSION };
assert.equal(await cache.read("v1", async () => value), value);
assert.equal(await cache.read("v1", async () => { throw new Error("cached"); }), value);
const { z } = await import("zod");
const schemas = pricing.createCommerceQuoteSchemas({ currencySchema: z.string().regex(/^[A-Z]{3}$/),
  productSlugSchema: z.string().min(1), contextSchema: z.object({ mode: z.enum(["one_time", "subscription"]), promoCodes: z.array(z.string()) }) });
assert(schemas.createQuoteRequestSchema.safeParse({ lines: [{ sku: "ITEM", quantity: 1 }] }).success);
assert(!schemas.createQuoteRequestSchema.safeParse({ mode: "subscription", lines: [{ sku: "ITEM", quantity: 1 }] }).success);
assert(!pricing.quoteDiscountSchema.safeParse({ promotionEngineVersion: "promotion-engine.v2" }).success);
const profile = { included: true, country: "AA", category: "standard", vatRateBps: 2300, legalBasis: "Example" };
assert.throws(() => pricing.assertSupportedCommerceTaxProfile(profile, []), error => error instanceof pricing.CommerceQuoteError && error.code === "UNSUPPORTED_TAX_PROFILE");
assert.equal(pricing.deriveSubscriptionUnitPrice(1490, { discountBps: 1000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" }), 1340);
assert.equal("createPricingPolicyToken" in contracts, false);
assert.equal("subscriptionPricePolicyRevisionSchema" in contracts, false);
assert.throws(() => pricing.pricingPolicySnapshotSchema.parse({ offerPolicyVersion: contracts.OFFER_POLICY_V1, promotionEngineVersion: contracts.PROMOTION_ENGINE_V2 }));
const authority = pricing.createCommercePriceAuthorityPort({ listPriceLists: async () => [] });
await assert.rejects(authority.resolvePrice({ variantId: "item", mode: "one_time", regionCode: "AA", currency: "XXX", channel: "test", atTime: "2026-09-09T00:00:00.000Z" }), error => error instanceof pricing.CommercePriceAuthorityError && error.code === "active_price_list_not_found");
`);
    consumerNode(consumer, `
import assert from "node:assert/strict";
import * as promotions from "@openlup/platform/promotions";
import * as contracts from "@openlup/platform/promotions/contracts";
assert.deepEqual(Object.keys(contracts), []);
// Promotions imports without pg: its store uses only the host executor. The selected
// data gateway retains the existing named missing-pg refusal (proveAdapterRefusals).
assert.equal(typeof promotions.createPostgresCommercePromoDataPort, "function");
let sqlCalls = 0;
const executor = { query: async sql => { sqlCalls++; assert(sql.includes("active_definitions")); return { rows: [{ result: [] }] }; } };
assert.deepEqual(await promotions.createPostgresCommercePromoDataPort(executor).listActivePromotions(), []);
assert.equal(sqlCalls, 1);
assert.deepEqual(promotions.PROMOTIONS_MIGRATIONS.map(unit => unit.position), [47, 48]);
const { applyPromotionCodesV2 } = promotions.createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: 100 });
let reads = 0;
const input = { clientId: null, mode: "one_time", promoCodes: ["save"], referenceProductMinor: 10000,
  subtotalGrossMinor: 10000, shippingGrossMinor: 0, discounts: [], codeRejections: [], atTime: "2026-10-01T00:00:00.000Z" };
const result = await applyPromotionCodesV2({ ...input, port: { async resolve(facts) {
  reads++; assert.equal(facts.purchaseScope, "one_time");
  return { candidates: [{ promotionId: "promotion", codeId: "code", source: "code", name: "Example", code: "SAVE",
    lane: "product", kind: "target_percentage", valueBps: 8000, scopes: ["one_time"], codeRevision: 1,
    definitionFingerprint: "a".repeat(64), minimumReferenceMinor: 0, validTo: null }], codeRejections: [], codeRejectionDetails: [] };
} } });
assert.equal(reads, 1);
assert.equal(result.discounts[0].amountOffMinor, 8000);
const money = amountMinor => ({ amountMinor, currency: "XXX" });
const quote = { currency: "XXX", taxIncluded: true, lines: [], discounts: result.discounts,
  totalGross: money(2000), netTotal: money(2000), taxTotal: money(0), subtotalGross: money(10000), discountTotalGross: money(8000) };
const request = { promoCodes: ["save"] }, keyring = { current: "synthetic-acceptance-key-000000000000000000" }, now = new Date(input.atTime);
const acceptance = promotions.createPromotionQuoteAcceptance({ projectRequest: value => value });
const token = acceptance.issuePromotionQuoteAcceptance({ request, quote, keyring, now });
assert(token);
assert(acceptance.verifyPromotionQuoteAcceptance({ token, request, quote, keyring, now, expectedTotal: quote.totalGross }));
assert(!acceptance.verifyPromotionQuoteAcceptance({ token, request, quote: { ...quote, totalGross: money(2001) }, keyring, now, expectedTotal: quote.totalGross }));
await assert.rejects(applyPromotionCodesV2({ ...input, port: { resolve: async () => { throw new Error("read unavailable"); } } }), /read unavailable/);
assert.throws(() => promotions.resolvePromotionBenefitDefinition({ discount_type: "unknown", discount_value: 0 }), /promotion_v1_benefit_invalid/);
`);
    const compiler = join(checkout, "node_modules/typescript/bin/tsc");
    compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler);
    assertConsumerIsolation(consumer, checkout); // Compilation must not have supplied a peer.
    proveMarketingConsumer(consumer);
    proveMarketingServerConsumer(consumer);
    compileMarketingAnalyticsConsumer(consumer, compiler);
    proveCommerceConsumer(consumer);
    proveCommerceServerConsumer(consumer);
    proveOperationsConsumer(consumer);
    provePortabilityConsumer(consumer);
    proveLifecycleConsumer(consumer);
    proveCatalogCompositionConsumer(consumer);
    proveAdapterRefusals(consumer);
    proveOidcRefusals(consumer);
    proveCommunicationsConsumer(consumer);
    proveResendConsumer(consumer);
    provePaymentAdapterConsumer(consumer);
    proveWarehouseAdapterConsumer(consumer);
    proveMarketingSyncConsumer(consumer);
    proveInvoicingConsumer(consumer);
    proveSubscriptionsConsumer(consumer);
    proveAccountSupportConsumer(consumer);
    proveAccountSupportReadsConsumer(consumer);
    for (const proof of ACCOUNT_SUPPORT_COMPOSITION_PROOFS) proveAccountSupportCompositionConsumer(consumer, compiler, proof);
    proveSelfServiceConsumer(consumer);
    provePaymentsConsumer(consumer);
    proveFulfillmentConsumer(consumer);
    installA1HostBinding(consumer, checkout);
    proveA1ReferenceBindingConsumer(consumer, "imports");
    proveA1ReferenceBindingConsumer(consumer, "selection");
    compileConsumer(consumer, ["communications/resend"], compiler);
    compileConsumer(consumer, ["communications/klaviyo"], compiler);
    install(OPTIONAL_PEERS.map(locked), true);
    assertInstalledPackages(consumer, OPTIONAL_PEERS);
    assertConsumerIsolation(consumer, checkout, false);
    compileConsumer(consumer, [...NON_ADAPTER_ENTRIES, ...ADAPTER_ENTRIES], compiler);
    compileOperationsConsumer(consumer, compiler);
    proveInstalledAdapters(consumer);
    proveDockerPostgres(consumer, environment);
    console.log("Platform cold consumer PASS; verified tarballs, isolated optional peers, no live provider");
  } finally { rmSync(consumer, { recursive: true, force: true }); }
}


export const ACCOUNT_SUPPORT_READ_SCENARIOS = [
  "account aggregate", "foreign detail", "owned detail", "unread profile", "partial profile",
  "unbound invoice history", "signed invoice history", "authorized PDF", "denied PDF", "failed invoice history"
] as const;
export interface AccountSupportReadScenarioResult {
  name: string;
  pass: boolean;
  comparisons: { observed: unknown; expected: unknown }[];
  error?: string;
}

/** One installed process reports every independent R2 scenario, even after a failed assertion. */
export function proveAccountSupportReadsConsumer(
  consumer: string,
  options: { throwOnFailure?: boolean } = {}
): AccountSupportReadScenarioResult[] {
  const output = consumerNode(consumer, `
import assert from "node:assert/strict";
import { readAccountSnapshot, readCustomerOrderDetail, projectCustomer360Snapshot, createInvoiceAccess } from "@openlup/platform/account-support";
const results=[];
let comparisons;
const equal=(observed,expected)=>{comparisons.push({observed,expected});assert.deepEqual(observed,expected);};
async function scenario(name,run){
 comparisons=[];
 try {await run();results.push({name,pass:true,comparisons});}
 catch(error){comparisons.push({observed:{error:String(error)},expected:"scenario completes"});results.push({name,pass:false,comparisons,error:String(error.stack??error)});}
}
const empty = async () => new Map();
const sources = { readExtension: async()=>({host:"captured"}), readSubscriptionRows: async(_id,limit)=>{equal(limit,50);return [];},
 readAddresses:async()=>[],readOrdererProfiles:async()=>[],readPaymentPreferences:async()=>[],readDeliveryPreferences:async()=>[],
 readOrders:async(id,limit)=>{equal(id,"owned");equal(limit,20);return {orders:[]};},readEvents:async()=>[],
 readSubscriptionLines:empty,readSubscriptionBlockers:empty,readPauseWindows:empty,readPaymentEvidence:empty,readDeliveryAlignments:empty,readNextCharges:empty,readActionStates:empty};
const policy={paymentMethodStatus:()=>"usable",canUsePaymentMethodForRenewal:()=>true,packageSummary:()=>null,withNextCharge:(recurringPrice,nextCharge)=>({recurringPrice,nextCharge})};
await scenario("account aggregate",async()=>{
 const account=await readAccountSnapshot(sources,policy,{id:"owned",email:"a@example.invalid"});equal(account.contractVersion,"customer.account.v3");equal(account.extension.host,"captured");
});
let companionReads=0;
const store={readCustomerOrder:async(owner)=>owner==="owned"?{id:"o",currency:"EUR",status:"paid",subtotal_cents:200,discount_cents:20,shipping_cents:50,shipping_discount_cents:50,tax_cents:0,total_cents:180}:null,
 readOrderLines:async()=>{companionReads++;return [{id:"l",quantity:2,unit_price_cents:100,total_cents:200,discount_allocated_cents:20,effective_total_cents:180,effective_net_cents:180,vat_rate_bps:0}];},
 readPaymentStatuses:empty,readFulfillments:async()=>[],readTracking:empty,readFulfillmentOperations:empty,readStatusEvidence:empty,readReleasedProviderExceptionHolds:empty,readReleasedProviderExceptionEvidence:empty,readActiveHoldOrderIds:async()=>new Set(),readInvoiceSummaries:empty};
const projection={automaticHoldSource:"host.hold",automaticReleaseSource:"host.release",orderReference:id=>id,fulfillmentEvidence:()=>({trackingReferences:[],trackingNumbers:[],trackingNumber:null,trackingUrl:null,carrierKind:null,service:null,trackingTimeline:[]}),presentation:{display:()=>({title:"Captured",variantName:null})}};
await scenario("foreign detail",async()=>{
 companionReads=0;equal(await readCustomerOrderDetail(store,"foreign","o",projection),null);equal(companionReads,0);
});
await scenario("owned detail",async()=>{
 const detail=await readCustomerOrderDetail(store,"owned","o",projection);equal(detail.order.shipping,{amountMinor:0,currency:"EUR"});equal(detail.order.total,{amountMinor:180,currency:"EUR"});equal(detail.order.lines[0].title,"Captured");
});
const input={subject:{subjectId:"s",displayName:null,email:null,lifecycleStage:"customer",createdAt:null,lastActivityAt:null},legacy:null,cases:[],notices:[],tokens:[],recoveryAudit:[],orderTruth:[],now:0};
const supportPolicy={lifecycle:()=>[],timelineAudit:()=>[]};
await scenario("unread profile",()=>{
 const core=projectCustomer360Snapshot(input,supportPolicy);equal("extension" in core,false);equal("contactHealth" in core,false);
});
await scenario("partial profile",()=>{
 equal(projectCustomer360Snapshot({...input,profile:{extension:{host:"selected"},partial:true}},supportPolicy).extension,{host:"selected"});
});
await scenario("unbound invoice history",async()=>{
 equal((await createInvoiceAccess().history({accountRef:"owned",orderId:"o"})).kind,"unsupported");
});
const identity={providerRef:"host",documentRef:"child",providerDocumentRef:"remote-child",orderRef:"order-o",invoiceRef:"parent",parentProviderDocumentRef:"remote-parent"};
const content=new TextEncoder().encode("%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\n%%EOF\\n");
function invoice(){
 let artifacts=0;
 const history={read:async()=>({kind:"found",accountRef:"owned",orderId:"o",documents:[{documentRef:"child",invoiceRef:"parent",parentDocumentRef:"parent",role:"correction",status:"issued",issuedAt:null,clearance:null,documentKind:null,artifact:"correction",providerDocumentNumber:null,totalGrossMinor:-50,currency:"EUR",emailState:"not_requested",isCurrent:true,createdAt:"2030-01-01",downloadAvailable:true}]}),resolveDownload:async()=>({kind:"authorized",identity,artifactRef:"child-artifact",fileName:"child.pdf",parentDocumentRef:"parent"})};
 const access=createInvoiceAccess({accountHistory:history,artifacts:{download:async()=>{artifacts++;return {kind:"downloaded",content,contentType:"application/pdf"};}}});
 return {history,access,artifacts:()=>artifacts};
}
await scenario("signed invoice history",async()=>{
 const {access}=invoice();const documents=await access.history({accountRef:"owned",orderId:"o"});equal(documents.documents[0].totalGrossMinor,-50);
});
await scenario("authorized PDF",async()=>{
 const {access}=invoice();const pdf=await access.download({accountRef:"owned",orderId:"o",documentRef:"child"});equal(pdf.kind,"downloaded");equal(pdf.parentDocumentRef,"parent");equal(pdf.content,content);
});
await scenario("denied PDF",async()=>{
 const {access,history,artifacts}=invoice();await access.download({accountRef:"owned",orderId:"o",documentRef:"child"});history.resolveDownload=async()=>({kind:"denied"});equal((await access.download({accountRef:"owned",orderId:"o",documentRef:"child"})).kind,"denied");equal(artifacts(),1);
});
await scenario("failed invoice history",async()=>{
 const {access,history}=invoice();history.read=async()=>{throw Error("partial");};equal((await access.history({accountRef:"owned",orderId:"o"})).kind,"unknown");
});
console.log("R2_SCENARIOS="+JSON.stringify(results));
`);
  const record = output.split("\n").find(line => line.startsWith("R2_SCENARIOS="));
  if (!record) throw new Error("R2 installed consumer did not report scenarios");
  const results = JSON.parse(record.slice("R2_SCENARIOS=".length)) as AccountSupportReadScenarioResult[];
  assert.deepEqual(results.map(result => result.name), ACCOUNT_SUPPORT_READ_SCENARIOS);
  if (options.throwOnFailure !== false) assert.deepEqual(results.filter(result => !result.pass), []);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) runPlatformColdConsumer();
